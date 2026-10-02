import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import * as fileSystem from 'node:fs';
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManagedChatOperationV2AuthoringRuntime } from '../server/chat-operations/authoring-runtime';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding';
import { listChatYamlStage } from '../server/chat-yaml-staging';
import {
  MAX_SERVER_RECORD_BYTES,
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from '../server/server-record-auth';
import { WorkspaceState } from '../server/workspace-state';
import type { ChatPipelineTrialRunResult } from '../server/chat-pipeline-trial-run';
import {
  sealChatRepairErrorEvidence,
  type ChatRepairErrorEvidence,
} from '../server/chat-operations/repair-error-evidence';
import {
  ChatRepairEvidenceStorageError,
  MAX_CHAT_REPAIR_EVIDENCE_BYTES,
  writeChatRepairEvidenceBlob,
} from '../server/chat-operations/repair-evidence-store';
import type { ManagedChatOperationV2AuthoringAuthorityRecord } from '../server/chat-operations/authoring-runtime';

const STAGE_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const savedKeyPath = process.env.TAGMA_STAGE_RECORD_KEY_FILE;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedKeyPath === undefined) delete process.env.TAGMA_STAGE_RECORD_KEY_FILE;
  else process.env.TAGMA_STAGE_RECORD_KEY_FILE = savedKeyPath;
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-repair-evidence-storage-'));
  roots.push(root);
  process.env.TAGMA_STAGE_RECORD_KEY_FILE = join(root, 'control', 'stage-record-hmac.key');
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  const factory = () =>
    createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-storage',
      workspace,
      openCode: {} as never,
      commitPreparer: async () => ({ commitId: 'unused' }) as never,
    });
  const runtime = factory();
  const binding = {
    schemaVersion: 1 as const,
    status: 'reserved' as const,
    bindingId: 'binding-storage',
    workspaceScopeId: 'scope-storage',
    version: 1,
    target: normalizeChatOperationV2TargetCoordinate(
      'repro/repro.yaml',
      process.platform === 'win32' ? 'win32' : 'posix',
    ),
    operationId: 'operation-storage',
    reservedAtMs: 1,
  };
  const ensured = await runtime.ensureStage({
    operationId: binding.operationId,
    workspaceScopeId: binding.workspaceScopeId,
    operationGeneration: 1,
    binding,
    originHash: null,
    stageId: STAGE_ID,
    targetId: 'target-storage',
    intent: 'create',
    sessionId: 'session-storage',
  });
  if (ensured.kind !== 'ready') throw new Error('Production stage setup failed.');
  const descriptor = listChatYamlStage(workspace, STAGE_ID, true);
  mkdirSync(join(descriptor.agentTagmaDir, 'repro'), { recursive: true });
  writeFileSync(
    join(descriptor.agentTagmaDir, 'repro/repro.yaml'),
    'pipeline:\n  name: Storage\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: source\n          command: echo one\n        - id: failure\n          command: echo two\n',
  );
  const staging = (
    runtime as unknown as {
      staging: {
        runTrial: (...args: unknown[]) => Promise<ChatPipelineTrialRunResult>;
        authorityPath: (id: string) => {
          path: string;
          context: Parameters<typeof writeAuthenticatedServerRecordSync>[1];
        };
        writeAuthority: (
          id: string,
          record: ManagedChatOperationV2AuthoringAuthorityRecord,
        ) => Promise<void>;
      };
    }
  ).staging;
  const identity = { operationId: binding.operationId, operationGeneration: 1, stageId: STAGE_ID };
  return { root, runtime, factory, staging, identity, descriptor, stage: ensured.stage, binding };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const raw = value as Record<string, unknown>;
  return `{${Object.keys(raw)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(raw[key])}`)
    .join(',')}}`;
}

/** Exact old writer format, using only this test's fresh private key. */
function writeLegacy(path: string, context: ServerRecordContext, payload: object): void {
  const signature = createHmac('sha256', readFileSync(process.env.TAGMA_STAGE_RECORD_KEY_FILE!))
    .update(['1', context.kind, context.stageId, path, canonicalJson(payload)].join('\0'))
    .digest('hex');
  writeFileSync(
    path,
    JSON.stringify(
      { ...payload, __tagmaServerAuth: { version: 1, algorithm: 'hmac-sha256', signature } },
      null,
      2,
    ) + '\n',
  );
}

async function storeEvidence(
  h: Awaited<ReturnType<typeof harness>>,
  evidence: ChatRepairErrorEvidence,
) {
  const { path, context } = h.staging.authorityPath(STAGE_ID);
  const authority =
    readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
      path,
      context,
    );
  await h.staging.writeAuthority(STAGE_ID, { ...authority, repairErrorEvidence: evidence });
  const saved = readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
    path,
    context,
  );
  return {
    path,
    context,
    saved,
    blobPath: join(context.controlRoot, 'repair-error-evidence', `${evidence.hash}.json`),
  };
}

async function draftYaml(h: Awaited<ReturnType<typeof harness>>) {
  const runtime = h.factory();
  const input = { ...h.identity, signal: new AbortController().signal };
  const draft = await runtime.accessDraft!(input);
  const yaml = draft.files.find((file) => file.name.endsWith('repro.yaml'));
  if (!yaml) throw new Error('Retained YAML is unavailable.');
  return (await runtime.accessDraft!({ ...input, fileId: yaml.id })).selected?.text;
}

describe('durable complete repair evidence storage', () => {
  test('large independent stdout and errors preserve readable authority, drafts and restart recovery', async () => {
    const h = await harness();
    const streamBytes = MAX_SERVER_RECORD_BYTES / 2;
    const stdout = 'A'.repeat(streamBytes);
    const stderr = 'B'.repeat(streamBytes);
    const tasks = [
      {
        taskId: 'main.source',
        caseId: 'normal',
        runNumber: 1,
        status: 'success',
        repairScope: null,
        stdout,
        stderr: '',
      },
      {
        taskId: 'main.failure',
        caseId: 'normal',
        runNumber: 1,
        status: 'failed',
        failureKind: 'exit_nonzero',
        repairScope: 'pipeline-artifact',
        stdout: '',
        stderr,
      },
    ];
    h.staging.runTrial = async () =>
      ({
        kind: 'failed',
        success: false,
        ran: true,
        repairAuthorization: 'pipeline-change-allowed',
        tasks,
        repairErrorTasks: tasks,
        cases: [{ id: 'normal', success: false, expectations: [] }],
        summary: 'Independent failure',
      }) as unknown as ChatPipelineTrialRunResult;
    const result = await h.runtime.verifyStage({
      operationId: h.identity.operationId,
      workspaceScopeId: h.binding.workspaceScopeId,
      operationGeneration: 1,
      bindingId: h.binding.bindingId,
      targetId: 'target-storage',
      stage: h.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('repair_required');
    expect(statSync(h.staging.authorityPath(STAGE_ID).path).size).toBeLessThan(
      MAX_SERVER_RECORD_BYTES,
    );
    const text = await h.factory().readRepairErrorEvidence!({
      ...h.identity,
      hash: result.repairErrorEvidenceHash!,
    });
    const evidence = JSON.parse(text);
    expect(
      evidence.tasks.find((task: { taskId: string }) => task.taskId === 'main.source').stdout,
    ).toBe(stdout);
    expect(
      evidence.tasks.find((task: { taskId: string }) => task.taskId === 'main.failure').stderr,
    ).toBe(stderr);
    expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
    expect(await draftYaml(h)).toContain('name: Storage');
  });

  test('oversized authenticated control writes preserve the existing readable bytes', async () => {
    const h = await harness();
    const { path, context } = h.staging.authorityPath(STAGE_ID);
    const before = readFileSync(path);
    const payload = readAuthenticatedServerRecordSync<Record<string, unknown>>(path, context);
    expect(() =>
      writeAuthenticatedServerRecordSync(path, context, {
        ...payload,
        oversized: 'x'.repeat(MAX_SERVER_RECORD_BYTES),
      }),
    ).toThrow(/limit|bound|size/i);
    expect(readFileSync(path)).toEqual(before);
    expect(readAuthenticatedServerRecordSync(path, context)).toEqual(payload);
  });

  test.each(['missing', 'tampered', 'symlink'] as const)(
    '%s evidence fails closed while the draft remains readable',
    async (fault) => {
      const h = await harness();
      const evidence = sealChatRepairErrorEvidence('trial-storage', {
        schemaVersion: 1,
        stage: 'compile',
        error: 'Complete diagnosis',
      });
      const saved = await storeEvidence(h, evidence);
      if (fault === 'missing') unlinkSync(saved.blobPath);
      if (fault === 'tampered')
        writeFileSync(saved.blobPath, evidence.text.replace('Complete', 'Tampered'));
      if (fault === 'symlink') {
        const target = join(h.root, 'external-evidence.json');
        writeFileSync(target, evidence.text);
        unlinkSync(saved.blobPath);
        symlinkSync(target, saved.blobPath);
      }
      await expect(
        h.factory().readRepairErrorEvidence!({ ...h.identity, hash: evidence.hash }),
      ).rejects.toThrow(/unavailable|changed/);
      expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
      expect(await draftYaml(h)).toContain('name: Storage');
    },
  );

  test('small persisted inline evidence remains readable and migrates on the next authority write', async () => {
    const h = await harness();
    const { path, context } = h.staging.authorityPath(STAGE_ID);
    const authority =
      readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
        path,
        context,
      );
    const evidence = sealChatRepairErrorEvidence('legacy-small', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Legacy diagnosis',
    });
    writeLegacy(path, context, { ...authority, repairErrorEvidence: evidence });
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: evidence.hash })).toBe(
      evidence.text,
    );
    await storeEvidence(h, evidence);
    expect(readFileSync(path, 'utf8')).toContain('repair-evidence-blob');
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: evidence.hash })).toBe(
      evidence.text,
    );
  });

  test('an authenticated oversized legacy inline authority migrates before draft and evidence recovery', async () => {
    const h = await harness();
    const { path, context } = h.staging.authorityPath(STAGE_ID);
    const authority =
      readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
        path,
        context,
      );
    const evidence = sealChatRepairErrorEvidence('legacy-large', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'L'.repeat(MAX_SERVER_RECORD_BYTES),
    });
    writeLegacy(path, context, { ...authority, repairErrorEvidence: evidence });
    expect(statSync(path).size).toBeGreaterThan(MAX_SERVER_RECORD_BYTES);
    expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
    expect(statSync(path).size).toBeLessThan(MAX_SERVER_RECORD_BYTES);
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: evidence.hash })).toBe(
      evidence.text,
    );
    expect(await draftYaml(h)).toContain('name: Storage');
  });

  test('failed legacy migration preserves authenticated draft reads and retries when storage recovers', async () => {
    const h = await harness();
    const { path, context } = h.staging.authorityPath(STAGE_ID);
    const authority =
      readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
        path,
        context,
      );
    const evidence = sealChatRepairErrorEvidence('legacy-write-failure', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'L'.repeat(MAX_SERVER_RECORD_BYTES),
    });
    writeLegacy(path, context, { ...authority, repairErrorEvidence: evidence });
    const before = readFileSync(path);
    const blobDirectory = join(h.descriptor.rootDir, 'repair-error-evidence');
    symlinkSync(h.root, blobDirectory, 'dir');
    expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
    expect(await draftYaml(h)).toContain('name: Storage');
    expect(readFileSync(path)).toEqual(before);
    unlinkSync(blobDirectory);
    expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
    expect(statSync(path).size).toBeLessThan(MAX_SERVER_RECORD_BYTES);
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: evidence.hash })).toBe(
      evidence.text,
    );
  }, 15_000);

  test('interrupted pre-pointer blob publication is cleaned before storing new complete evidence', async () => {
    const h = await harness();
    const evidence = sealChatRepairErrorEvidence('first', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'First diagnosis',
    });
    const saved = await storeEvidence(h, evidence);
    const pending = join(
      h.descriptor.rootDir,
      'repair-error-evidence',
      '.pending-11111111-1111-4111-8111-111111111111',
    );
    writeFileSync(pending, 'interrupted bytes', { mode: 0o600 });
    const next = sealChatRepairErrorEvidence('second', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Second diagnosis',
    });
    await storeEvidence(h, next);
    expect(() => statSync(pending)).toThrow();
    expect(() => statSync(saved.blobPath)).toThrow();
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: next.hash })).toBe(
      next.text,
    );
  });

  test.each(['same-hash', 'new-hash'] as const)(
    'a crash after linking the blob recovers on %s retry',
    async (retry) => {
      const h = await harness();
      const evidence = sealChatRepairErrorEvidence('first', {
        schemaVersion: 1,
        stage: 'compile',
        error: 'First diagnosis',
      });
      const saved = await storeEvidence(h, evidence);
      const pending = join(
        h.descriptor.rootDir,
        'repair-error-evidence',
        '.pending-11111111-1111-4111-8111-111111111111',
      );
      linkSync(saved.blobPath, pending);
      const next =
        retry === 'same-hash'
          ? evidence
          : sealChatRepairErrorEvidence('second', {
              schemaVersion: 1,
              stage: 'compile',
              error: 'Second diagnosis',
            });
      await storeEvidence(h, next);
      expect(() => statSync(pending)).toThrow();
      expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: next.hash })).toBe(
        next.text,
      );
    },
  );

  test('a failed pointer replacement leaves the old evidence readable and reclaims the orphan on retry', async () => {
    const h = await harness();
    const first = sealChatRepairErrorEvidence('first', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'First diagnosis',
    });
    const saved = await storeEvidence(h, first);
    const second = sealChatRepairErrorEvidence('second', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Second diagnosis',
    });
    const before = readFileSync(saved.path);
    await expect(
      h.staging.writeAuthority(STAGE_ID, {
        ...saved.saved,
        repairErrorEvidence: second,
        invocations: { oversized: { text: 'X'.repeat(MAX_SERVER_RECORD_BYTES) } } as never,
      }),
    ).rejects.toThrow(/limit/);
    expect(readFileSync(saved.path)).toEqual(before);
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: first.hash })).toBe(
      first.text,
    );
    const orphan = join(saved.context.controlRoot, 'repair-error-evidence', `${second.hash}.json`);
    expect(statSync(orphan).size).toBeGreaterThan(0);
    const third = sealChatRepairErrorEvidence('third', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Third diagnosis',
    });
    await storeEvidence(h, third);
    expect(() => statSync(orphan)).toThrow();
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: third.hash })).toBe(
      third.text,
    );
  });

  test('the new pointer file and directory are flushed before the old blob is reclaimed', async () => {
    const h = await harness();
    const first = sealChatRepairErrorEvidence('first', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'First diagnosis',
    });
    const saved = await storeEvidence(h, first);
    const second = sealChatRepairErrorEvidence('second', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Second diagnosis',
    });
    const trace: string[] = [];
    const original = fileSystem.fsyncSync;
    const flush = spyOn(fileSystem, 'fsyncSync').mockImplementation((fd) => {
      original(fd);
      const stat = fileSystem.fstatSync(fd);
      if (JSON.parse(readFileSync(saved.path, 'utf8')).repairErrorEvidence.hash !== second.hash)
        return;
      if (stat.ino === statSync(saved.path).ino && stat.isFile()) {
        expect(statSync(saved.blobPath).isFile()).toBe(true);
        trace.push('pointer');
      } else if (stat.ino === statSync(saved.context.controlRoot).ino && stat.isDirectory()) {
        expect(statSync(saved.blobPath).isFile()).toBe(true);
        trace.push('directory');
      }
    });
    try {
      await storeEvidence(h, second);
    } finally {
      flush.mockRestore();
    }
    expect(trace).toEqual(['pointer', 'directory']);
    expect(() => statSync(saved.blobPath)).toThrow();
  });

  test('a pointer flush failure keeps the before-image blob until a successful retry', async () => {
    const h = await harness();
    const first = sealChatRepairErrorEvidence('first', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'First diagnosis',
    });
    const saved = await storeEvidence(h, first);
    const second = sealChatRepairErrorEvidence('second', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Second diagnosis',
    });
    const original = fileSystem.fsyncSync;
    const flush = spyOn(fileSystem, 'fsyncSync').mockImplementation((fd) => {
      if (
        fileSystem.fstatSync(fd).isFile() &&
        JSON.parse(readFileSync(saved.path, 'utf8')).repairErrorEvidence.hash === second.hash
      ) {
        const error = Object.assign(new Error('Simulated pointer flush failure'), { code: 'EIO' });
        throw error;
      }
      original(fd);
    });
    try {
      await expect(storeEvidence(h, second)).rejects.toThrow('flush failure');
    } finally {
      flush.mockRestore();
    }
    expect(statSync(saved.blobPath).isFile()).toBe(true);
    const third = sealChatRepairErrorEvidence('third', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Third diagnosis',
    });
    await storeEvidence(h, third);
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: third.hash })).toBe(
      third.text,
    );
    expect(() => statSync(saved.blobPath)).toThrow();
  });

  test('temporary cleanup errors remain observable without replacing the primary publication failure', async () => {
    const h = await harness();
    const first = sealChatRepairErrorEvidence('first', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'First diagnosis',
    });
    await storeEvidence(h, first);
    const second = sealChatRepairErrorEvidence('second', {
      schemaVersion: 1,
      stage: 'compile',
      error: 'Second diagnosis',
    });
    const primary = Object.assign(new Error('Primary publication failure'), { code: 'EIO' });
    const originalUnlink = fileSystem.unlinkSync;
    const publish = spyOn(fileSystem, 'linkSync').mockImplementation(() => {
      throw primary;
    });
    const cleanup = spyOn(fileSystem, 'unlinkSync').mockImplementation((path) => {
      if (String(path).includes('.pending-'))
        throw Object.assign(new Error('Cleanup failed'), { code: 'EACCES' });
      originalUnlink(path);
    });
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let observed: unknown;
      try {
        await storeEvidence(h, second);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(primary);
      expect(warning).toHaveBeenCalledWith('[chat-repair-evidence] temporary_cleanup_failed', [
        'EACCES',
      ]);
    } finally {
      publish.mockRestore();
      cleanup.mockRestore();
      warning.mockRestore();
    }
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: first.hash })).toBe(
      first.text,
    );
    await storeEvidence(h, second);
    expect(await h.factory().readRepairErrorEvidence!({ ...h.identity, hash: second.hash })).toBe(
      second.text,
    );
  });

  test.each(['bad-hmac', 'future-authority', 'future-evidence'] as const)(
    'oversized legacy %s is never migrated or replaced',
    async (fault) => {
      const h = await harness();
      const { path, context } = h.staging.authorityPath(STAGE_ID);
      const authority =
        readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
          path,
          context,
        );
      const evidence = sealChatRepairErrorEvidence('legacy-invalid', {
        schemaVersion: fault === 'future-evidence' ? 99 : 1,
        stage: 'compile',
        error: 'L'.repeat(MAX_SERVER_RECORD_BYTES),
      });
      writeLegacy(path, context, {
        ...authority,
        ...(fault === 'future-authority' ? { version: 99 } : {}),
        repairErrorEvidence: evidence,
      });
      if (fault === 'bad-hmac')
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('session-storage', 'session-changed'),
        );
      const before = readFileSync(path);
      await expect(h.factory().inspectStage(h.identity)).rejects.toThrow(/authentication|invalid/);
      expect(readFileSync(path)).toEqual(before);
    },
  );

  test('evidence storage write failures retain the draft and prior small authority without blind repair', async () => {
    const h = await harness();
    const { path } = h.staging.authorityPath(STAGE_ID);
    const before = readFileSync(path);
    symlinkSync(h.root, join(h.descriptor.rootDir, 'repair-error-evidence'), 'dir');
    h.staging.runTrial = async () =>
      ({
        kind: 'failed',
        success: false,
        ran: true,
        repairAuthorization: 'pipeline-change-allowed',
        tasks: [],
        cases: [{ id: 'normal', success: false, expectations: [] }],
        plannedCaseCount: 1,
        summary: 'failure',
      }) as unknown as ChatPipelineTrialRunResult;
    const result = await h.runtime.verifyStage({
      operationId: h.identity.operationId,
      workspaceScopeId: h.binding.workspaceScopeId,
      operationGeneration: 1,
      bindingId: h.binding.bindingId,
      targetId: 'target-storage',
      stage: h.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('unverified');
    expect(result.kind === 'unverified' && result.errorCode).toBe('repair_evidence_unavailable');
    expect(result.caseCount).toBe(1);
    expect(result.kind === 'unverified' && result.outcome.sandbox.status).toBe('failed');
    expect(readFileSync(path)).toEqual(before);
    expect(await draftYaml(h)).toContain('name: Storage');
  });

  test('the total evidence bound refuses oversized bytes before touching the authority', async () => {
    const h = await harness();
    const { path, context } = h.staging.authorityPath(STAGE_ID);
    const before = readFileSync(path);
    expect(() =>
      writeChatRepairEvidenceBlob(
        context,
        { workspaceScopeId: h.binding.workspaceScopeId, ...h.identity },
        {
          trialId: 'over-limit',
          hash: '0'.repeat(64),
          text: 'X'.repeat(MAX_CHAT_REPAIR_EVIDENCE_BYTES + 1),
        },
      ),
    ).toThrow(ChatRepairEvidenceStorageError);
    expect(readFileSync(path)).toEqual(before);
    expect((await h.factory().inspectStage(h.identity)).kind).toBe('present');
  });
});
