import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseYaml } from '@tagma/sdk/yaml';

import {
  advanceChatYamlStageSessionRelocation,
  clearChatYamlStageSessionRelocation,
  createChatYamlStage,
  discardChatYamlStage,
  finalizeChatYamlStage,
  listChatYamlStage,
  listChatYamlStageSessionRelocations,
  prepareChatYamlStageSessionRelocation,
  readChatYamlStageSessionRelocation,
} from '../server/chat-yaml-staging';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { registerChatYamlStagingRoutes } from '../server/routes/chat-yaml-staging';
import {
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
} from '../server/server-record-auth';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];
const workspaces: WorkspaceState[] = [];

function yamlFor(prompt = 'base'): string {
  return [
    'pipeline:',
    '  name: Relocation Test',
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      tasks:',
    '        - id: task',
    `          prompt: ${prompt}`,
    '',
  ].join('\n');
}

function makeWorkspace(): { ws: WorkspaceState; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-relocation-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const yaml = yamlFor();
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, yaml, 'utf-8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({ opencodeChatTrialRunEnabled: false }),
    'utf-8',
  );
  const ws = new WorkspaceState(root);
  workspaces.push(ws);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(yaml);
  ws.yamlEditLock = {
    id: 'chat-lock',
    owner: 'chat',
    reason: 'test',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    yamlPath: sourcePath,
  };
  return { ws, sourcePath };
}

function relocationInput(stage: { id: string }) {
  return {
    stageId: stage.id,
    sessionId: 'ses_relocation_test',
    relocationId: 'relocation-test-1',
  };
}

type MockRequest = {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  workspace: WorkspaceState | null;
  get(name: string): string | undefined;
};

function request(
  ws: WorkspaceState,
  body: Record<string, unknown> = {},
  lockId?: string,
  query: Record<string, unknown> = {},
): MockRequest {
  return {
    body,
    query,
    workspace: ws,
    get(name) {
      return name.toLowerCase() === 'x-tagma-yaml-lock-id' ? lockId : undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function createHarness() {
  type Handler = (req: MockRequest, res: ReturnType<typeof makeRes>) => unknown;
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    post(path: string, handler: Handler) {
      routes.set(`POST ${path}`, handler);
      return app;
    },
  };
  registerChatYamlStagingRoutes(app as never);
  return (method: 'GET' | 'POST', path: string) => {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`Missing route ${method} ${path}`);
    return handler;
  };
}

function metadataRecord(stage: { id: string; rootDir: string }, ws: WorkspaceState) {
  const path = join(stage.rootDir, 'stage.json');
  const context = {
    workspaceTagmaDir: join(ws.workDir, '.tagma'),
    controlRoot: stage.rootDir,
    stageId: stage.id,
    kind: 'stage-metadata' as const,
  };
  return { path, context };
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Chat YAML session relocation binding', () => {
  test('persists an authenticated optional binding without exposing the YAML lock secret', () => {
    const { ws } = makeWorkspace();
    const stage = createChatYamlStage(ws);
    const input = relocationInput(stage);

    expect(listChatYamlStage(ws, stage.id).sessionRelocation).toBeUndefined();
    const prepared = prepareChatYamlStageSessionRelocation(ws, input);

    expect(prepared).toMatchObject({
      ...input,
      version: 1,
      sourceDirectory: join(ws.workDir, '.tagma'),
      targetDirectory: stage.agentTagmaDir,
      phase: 'prepared',
    });
    expect(prepared.updatedAt).toBeNumber();
    expect(JSON.stringify(prepared)).not.toContain('chat-lock');
    expect(readChatYamlStageSessionRelocation(ws, stage.id)).toEqual(prepared);
    expect(listChatYamlStage(ws, stage.id).sessionRelocation).toEqual(prepared);
    expect(listChatYamlStageSessionRelocations(ws)).toEqual([prepared]);

    // Exact prepare retries are idempotent; an identity change is not.
    expect(prepareChatYamlStageSessionRelocation(ws, input)).toEqual(prepared);
    expect(() =>
      prepareChatYamlStageSessionRelocation(ws, { ...input, sessionId: 'ses_other' }),
    ).toThrow(/does not match/i);
    expect(
      clearChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'prepared',
        verifiedHomeDirectory: prepared.sourceDirectory,
      }),
    ).toBe(true);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
  });

  test('enforces exact identity, ordered phases, and verified-home clearing', () => {
    const { ws } = makeWorkspace();
    const stage = createChatYamlStage(ws);
    const other = createChatYamlStage(ws);
    const input = relocationInput(stage);
    const homeDirectory = join(ws.workDir, '.tagma');
    prepareChatYamlStageSessionRelocation(ws, input);

    expect(
      advanceChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'prepared',
        phase: 'prepared',
      }).phase,
    ).toBe('prepared');

    expect(() =>
      advanceChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'restoring',
        phase: 'prepared',
      }),
    ).toThrow(/transition/i);
    expect(() =>
      advanceChatYamlStageSessionRelocation(ws, {
        ...input,
        relocationId: 'relocation-other',
        expectedPhase: 'prepared',
        phase: 'staged',
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      advanceChatYamlStageSessionRelocation(ws, {
        ...input,
        stageId: other.id,
        expectedPhase: 'prepared',
        phase: 'staged',
      }),
    ).toThrow(/no active session relocation/i);

    const staged = advanceChatYamlStageSessionRelocation(ws, {
      ...input,
      expectedPhase: 'prepared',
      phase: 'staged',
    });
    expect(staged.phase).toBe('staged');
    expect(
      advanceChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'prepared',
        phase: 'staged',
      }),
    ).toEqual(staged);

    expect(() =>
      clearChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'staged',
        verifiedHomeDirectory: stage.agentTagmaDir,
      }),
    ).toThrow(/only from prepared or restoring/i);

    const restoring = advanceChatYamlStageSessionRelocation(ws, {
      ...input,
      expectedPhase: 'staged',
      phase: 'restoring',
    });
    expect(restoring.phase).toBe('restoring');
    expect(() =>
      clearChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: stage.agentTagmaDir,
      }),
    ).toThrow(/verified home directory/i);
    expect(
      clearChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: homeDirectory,
      }),
    ).toBe(true);
    expect(readChatYamlStageSessionRelocation(ws, stage.id)).toBeNull();
    expect(
      clearChatYamlStageSessionRelocation(ws, {
        ...input,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: homeDirectory,
      }),
    ).toBe(false);

    const crashInput = { ...relocationInput(other), relocationId: 'relocation-crash-window' };
    prepareChatYamlStageSessionRelocation(ws, crashInput);
    expect(
      advanceChatYamlStageSessionRelocation(ws, {
        ...crashInput,
        expectedPhase: 'prepared',
        phase: 'restoring',
      }).phase,
    ).toBe('restoring');
    expect(
      clearChatYamlStageSessionRelocation(ws, {
        ...crashInput,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: homeDirectory,
      }),
    ).toBe(true);

    const missingStage = createChatYamlStage(ws);
    const missingInput = {
      ...relocationInput(missingStage),
      relocationId: 'relocation-missing-after-downgrade',
    };
    prepareChatYamlStageSessionRelocation(ws, missingInput);
    advanceChatYamlStageSessionRelocation(ws, {
      ...missingInput,
      expectedPhase: 'prepared',
      phase: 'restoring',
    });
    expect(
      clearChatYamlStageSessionRelocation(ws, {
        ...missingInput,
        expectedPhase: 'restoring',
        verifiedSessionMissing: true,
      }),
    ).toBe(true);

    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    expect(discardChatYamlStage(ws, other.id)).toBe(true);
    expect(discardChatYamlStage(ws, missingStage.id)).toBe(true);
  });

  test('blocks finalize, discard, and expiry cleanup while a binding may own the session', async () => {
    const { ws } = makeWorkspace();
    const stage = createChatYamlStage(ws);
    const entry = stage.entries[0]!;
    const input = relocationInput(stage);
    prepareChatYamlStageSessionRelocation(ws, input);
    advanceChatYamlStageSessionRelocation(ws, {
      ...input,
      expectedPhase: 'prepared',
      phase: 'staged',
    });

    expect(() => discardChatYamlStage(ws, stage.id)).toThrow(/session relocation is active/i);
    await expect(
      finalizeChatYamlStage(ws, { stageId: stage.id, relativePath: entry.relativePath }),
    ).rejects.toThrow(/session relocation is active/i);

    const { path, context } = metadataRecord(stage, ws);
    const saved = readAuthenticatedServerRecordSync<Record<string, unknown>>(path, context);
    writeAuthenticatedServerRecordSync(path, context, { ...saved, createdAt: 0 });
    const laterStage = createChatYamlStage(ws);

    expect(existsSync(stage.rootDir)).toBe(true);
    expect(listChatYamlStageSessionRelocations(ws)).toHaveLength(1);

    advanceChatYamlStageSessionRelocation(ws, {
      ...input,
      expectedPhase: 'staged',
      phase: 'restoring',
    });
    clearChatYamlStageSessionRelocation(ws, {
      ...input,
      expectedPhase: 'restoring',
      verifiedHomeDirectory: join(ws.workDir, '.tagma'),
    });
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    expect(discardChatYamlStage(ws, laterStage.id)).toBe(true);
  });

  test('omits authenticated but malformed or cross-stage bindings from workspace recovery reads', () => {
    const { ws } = makeWorkspace();
    const stage = createChatYamlStage(ws);
    const { path, context } = metadataRecord(stage, ws);
    const saved = readAuthenticatedServerRecordSync<Record<string, unknown>>(path, context);
    writeAuthenticatedServerRecordSync(path, context, {
      ...saved,
      sessionRelocation: {
        version: 1,
        relocationId: 'relocation-cross-stage',
        stageId: '00000000-0000-4000-8000-000000000000',
        sessionId: 'ses_cross_stage',
        sourceDirectory: join(ws.workDir, '.tagma'),
        targetDirectory: stage.agentTagmaDir,
        phase: 'staged',
        updatedAt: Date.now(),
      },
    });

    expect(listChatYamlStageSessionRelocations(ws)).toEqual([]);
    expect(() => readChatYamlStageSessionRelocation(ws, stage.id)).toThrow(/metadata is invalid/i);

    writeAuthenticatedServerRecordSync(path, context, {
      ...saved,
      sessionRelocation: {
        version: 1,
        relocationId: 'relocation-forged-source',
        stageId: stage.id,
        sessionId: 'ses_forged_source',
        sourceDirectory: join(ws.workDir, 'renderer-selected', '.tagma'),
        targetDirectory: stage.agentTagmaDir,
        phase: 'prepared',
        updatedAt: Date.now(),
      },
    });
    expect(listChatYamlStageSessionRelocations(ws)).toEqual([]);
    expect(() => readChatYamlStageSessionRelocation(ws, stage.id)).toThrow(/metadata is invalid/i);

    // Restore valid legacy metadata so ordinary cleanup remains possible.
    writeAuthenticatedServerRecordSync(path, context, saved);
    expect(readFileSync(path, 'utf-8')).not.toContain('sessionRelocation');
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
  });

  test('exposes strict mutation routes plus lock-free authenticated recovery reads and clear', () => {
    const { ws } = makeWorkspace();
    const route = createHarness();
    const stage = createChatYamlStage(ws);
    const input = relocationInput(stage);

    const untrustedDirectoryRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/prepare')(
      request(
        ws,
        {
          ...input,
          sourceDirectory: '/renderer/source',
          targetDirectory: '/renderer/target',
        },
        'chat-lock',
      ),
      untrustedDirectoryRes,
    );
    expect(untrustedDirectoryRes.statusCode).toBe(400);
    expect(readChatYamlStageSessionRelocation(ws, stage.id)).toBeNull();

    const prepareRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/prepare')(
      request(ws, input, 'chat-lock'),
      prepareRes,
    );
    expect(prepareRes.statusCode).toBe(200);
    expect(prepareRes.body).toMatchObject({ binding: { ...input, phase: 'prepared' } });
    expect(JSON.stringify(prepareRes.body)).not.toContain('chat-lock');

    const readRes = makeRes();
    route('GET', '/api/workspace/chat-yaml-stage/session-relocation')(
      request(ws, {}, undefined, { stageId: stage.id }),
      readRes,
    );
    expect(readRes.statusCode).toBe(200);
    expect(readRes.body).toMatchObject({ binding: { sessionId: input.sessionId } });

    const listRes = makeRes();
    route('GET', '/api/workspace/chat-yaml-stage/session-relocations')(request(ws), listRes);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).toMatchObject({ bindings: [{ stageId: stage.id }] });

    const invalidAdvanceRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/advance')(
      request(
        ws,
        {
          ...input,
          relocationId: 'relocation-wrong',
          expectedPhase: 'prepared',
          phase: 'staged',
        },
        'chat-lock',
      ),
      invalidAdvanceRes,
    );
    expect(invalidAdvanceRes.statusCode).toBe(409);

    const advanceRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/advance')(
      request(ws, { ...input, expectedPhase: 'prepared', phase: 'staged' }, 'chat-lock'),
      advanceRes,
    );
    expect(advanceRes.statusCode).toBe(200);

    const activeLeaseRecoveryRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/advance')(
      request(ws, { ...input, expectedPhase: 'staged', phase: 'restoring' }),
      activeLeaseRecoveryRes,
    );
    expect(activeLeaseRecoveryRes.statusCode).toBe(423);

    // A restarted sidecar has no active lease. Workspace auth + an exact verified-home
    // recovery transition can restore and release the binding, but does not delete the stage.
    ws.yamlEditLock = null;
    const lockFreeForwardRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/advance')(
      request(ws, { ...input, expectedPhase: 'staged', phase: 'staged' }),
      lockFreeForwardRes,
    );
    expect(lockFreeForwardRes.statusCode).toBe(423);

    const restoreRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/advance')(
      request(ws, { ...input, expectedPhase: 'staged', phase: 'restoring' }),
      restoreRes,
    );
    expect(restoreRes.statusCode).toBe(200);

    const clearRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/clear')(
      request(ws, {
        ...input,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: join(ws.workDir, '.tagma'),
      }),
      clearRes,
    );
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.body).toEqual({ cleared: true });
    expect(existsSync(stage.rootDir)).toBe(true);

    const missingStage = createChatYamlStage(ws);
    const missingInput = {
      ...relocationInput(missingStage),
      relocationId: 'route-missing-session',
    };
    prepareChatYamlStageSessionRelocation(ws, missingInput);
    const ambiguousMissingRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/clear')(
      request(ws, {
        ...missingInput,
        expectedPhase: 'prepared',
        verifiedHomeDirectory: join(ws.workDir, '.tagma'),
        verifiedSessionMissing: true,
      }),
      ambiguousMissingRes,
    );
    expect(ambiguousMissingRes.statusCode).toBe(400);
    expect(readChatYamlStageSessionRelocation(ws, missingStage.id)).not.toBeNull();

    const clearMissingRes = makeRes();
    route('POST', '/api/workspace/chat-yaml-stage/session-relocation/clear')(
      request(ws, {
        ...missingInput,
        expectedPhase: 'prepared',
        verifiedSessionMissing: true,
      }),
      clearMissingRes,
    );
    expect(clearMissingRes.statusCode).toBe(200);
    expect(clearMissingRes.body).toEqual({ cleared: true });

    ws.yamlEditLock = {
      id: 'chat-lock',
      owner: 'chat',
      reason: 'test',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      yamlPath: ws.yamlPath,
    };
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    expect(discardChatYamlStage(ws, missingStage.id)).toBe(true);
  });
});
