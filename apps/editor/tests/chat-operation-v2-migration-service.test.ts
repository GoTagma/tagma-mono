import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CHAT_OPERATION_V2_RESET_CONFIRMATION,
  createChatOperationV2MigrationService,
  deriveChatOperationV2ResetPlanId,
  deriveChatOperationV2ResetRequestIdentity,
  ChatOperationV2MigrationServiceError,
  isChatOperationV2MigrationServiceEnabled,
} from '../server/chat-operations/migration-service.js';
import { ChatOperationV2Store } from '../server/chat-operations/store.js';
import { WorkspaceState } from '../server/workspace-state.js';
import { tagmaDirOf } from '../server/pipeline-paths.js';

const roots: string[] = [];

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup(label: string) {
  const root = join(
    tmpdir(),
    `tagma-v2-migration-service-${label}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  roots.push(root);
  const tagmaDir = tagmaDirOf(root);
  const pipelinePath = join(tagmaDir, 'sample', 'sample.yaml');
  mkdirSync(dirname(pipelinePath), { recursive: true });
  writeFileSync(pipelinePath, 'pipeline:\n  name: Sample\n  version: 1.0.0\n', 'utf8');
  const controlDir = join(root, 'server-control');
  const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const key = Buffer.alloc(32, 21);
  const keyId = `sha256:${sha256(key)}`;
  writeFileSync(keyPath, key, { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(controlDir, 0o700);
    chmodSync(keyPath, 0o600);
  }
  const store = new ChatOperationV2Store({ databasePath, keyId });
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  return {
    root,
    pipelinePath,
    controlPaths: { controlDir, databasePath, keyPath },
    keyId,
    store,
    ws,
  };
}

function stop(fixture: ReturnType<typeof setup>): void {
  try {
    fixture.store.close();
  } catch {
    // Reset tests may have handed authority to another Store instance.
  }
  fixture.ws.watcher.stopWatching();
  fixture.ws.layoutWatcher.stopWatching();
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Chat Operation V2 migration service facade', () => {
  test('uses exact opt-in and explicit reset confirmation constants', () => {
    expect(
      isChatOperationV2MigrationServiceEnabled({ TAGMA_CHAT_OPERATION_V2_MIGRATION: '1' }),
    ).toBe(true);
    for (const value of [undefined, '', '0', 'true', ' 1']) {
      expect(
        isChatOperationV2MigrationServiceEnabled({
          TAGMA_CHAT_OPERATION_V2_MIGRATION: value,
        }),
      ).toBe(false);
    }
    expect(CHAT_OPERATION_V2_RESET_CONFIRMATION).toBe('RESET CHAT CONTROL DATA');
    expect(deriveChatOperationV2ResetPlanId('client-reset-1')).toBe(
      deriveChatOperationV2ResetPlanId('client-reset-1'),
    );
    expect(deriveChatOperationV2ResetPlanId('client-reset-1')).not.toBe(
      deriveChatOperationV2ResetPlanId('client-reset-2'),
    );
    expect(deriveChatOperationV2ResetRequestIdentity('client-reset-1')).toEqual(
      deriveChatOperationV2ResetRequestIdentity('client-reset-1'),
    );
  });

  test('disabled construction is side-effect free', () => {
    let touched = false;
    const service = createChatOperationV2MigrationService({
      enabled: false,
      get controlPaths() {
        touched = true;
        throw new Error('must not be read');
      },
    } as never);
    expect(service).toBeNull();
    expect(touched).toBe(false);
  });

  test('wrong reset confirmation cannot touch Store, files, or key generation', () => {
    let closed = 0;
    let randomCalls = 0;
    const service = createChatOperationV2MigrationService({
      enabled: true,
      controlPaths: {
        controlDir: 'D:\\never',
        databasePath: 'D:\\never\\chat-operation-v2.sqlite',
        keyPath: 'D:\\never\\control-hmac-v2.key',
      },
      getTrustedStore() {
        throw new Error('must not be reached');
      },
      closeTrustedStoreForReset() {
        closed += 1;
      },
      randomBytes(size) {
        randomCalls += 1;
        return Buffer.alloc(size);
      },
    })!;

    expect(() =>
      service.resetControlData({
        workspace: new WorkspaceState('D:\\never'),
        planId: deriveChatOperationV2ResetPlanId('reset-denied-request'),
        requestedAtMs: 1,
        clientRequestId: 'reset-denied-request',
        confirmation: 'reset please',
        newLineageId: 'lineage-denied',
      }),
    ).toThrow(expect.objectContaining({ code: 'reset_confirmation_required' }));
    expect(closed).toBe(0);
    expect(randomCalls).toBe(0);

    expect(() =>
      service.resetControlData({
        workspace: new WorkspaceState('D:\\never'),
        planId: '../reset',
        requestedAtMs: 1,
        clientRequestId: 'reset-invalid-request',
        confirmation: CHAT_OPERATION_V2_RESET_CONFIRMATION,
        newLineageId: 'lineage-invalid',
      }),
    ).toThrow(expect.objectContaining({ code: 'control_reset_failed' }));
    expect(closed).toBe(0);
    expect(randomCalls).toBe(0);
  });

  test('runs startup import and observed path checks with receipt-only diagnostics', () => {
    const fixture = setup('startup');
    const oldScope = fixture.store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-old',
      canonicalPath: join(fixture.root, 'old'),
      canonicalPathHmac: '1'.repeat(64),
      recordHmac: '2'.repeat(64),
      createdAt: 1,
      controlGeneration: 1,
    });
    const newScope = fixture.store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-new',
      canonicalPath: join(fixture.root, 'new'),
      canonicalPathHmac: '3'.repeat(64),
      recordHmac: '4'.repeat(64),
      createdAt: 2,
      controlGeneration: 1,
    });
    const service = createChatOperationV2MigrationService({
      enabled: true,
      controlPaths: fixture.controlPaths,
      getTrustedStore: () => fixture.store,
      closeTrustedStoreForReset: () => fixture.store.closeForOfflineMigrationInspection(),
      now: () => 100,
    })!;
    try {
      const startup = service.runStartupLegacyImport({
        workspace: fixture.ws,
        workspaceScopeId: oldScope.workspaceScopeId,
        migrationId: 'startup-migration',
        plannedAtMs: 90,
        completedResults: [],
      });
      expect(startup).toMatchObject({
        receipt: { disposition: 'legacy_imported', replayed: false },
        diagnostics: {
          kind: 'legacy_startup',
          registryDisposition: 'imported',
          isolatedStageCount: 0,
        },
      });
      expect(JSON.stringify(startup)).not.toContain(fixture.root);

      const observed = service.applyWorkspacePathCheck({
        workspace: fixture.ws,
        plan: {
          planId: 'observe-workspace-path',
          plannedAtMs: 91,
          request: 'observe_path_change',
          oldPathState: 'active',
          oldScope: {
            ...oldScope,
            recordsAuthentication: 'trusted',
            empty: false,
            ownership: 'owned',
            nonterminalOperationIds: [],
            pendingCommitWalIds: [],
            publishedBindingIds: [],
            authoritativeResultIds: [],
          },
          newScope: {
            ...newScope,
            recordsAuthentication: 'trusted',
            empty: true,
            ownership: 'unowned',
            nonterminalOperationIds: [],
            pendingCommitWalIds: [],
            publishedBindingIds: [],
            authoritativeResultIds: [],
          },
          adoptedOldScopeRecordHmac: null,
        },
      });
      expect(observed.diagnostics).toEqual({
        kind: 'workspace_path_change',
        request: 'observe_path_change',
        classification: 'clone',
        ownershipDisposition: 'new_scope_unowned',
      });
    } finally {
      stop(fixture);
    }
  });

  test('serializes migration work process-wide across service instances', () => {
    const fixture = setup('serialization');
    const scope = fixture.store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-serialize',
      canonicalPath: fixture.root,
      canonicalPathHmac: '5'.repeat(64),
      recordHmac: '6'.repeat(64),
      createdAt: 1,
      controlGeneration: 1,
    });
    let nestedError: unknown;
    let first = true;
    const service = createChatOperationV2MigrationService({
      enabled: true,
      controlPaths: fixture.controlPaths,
      getTrustedStore() {
        if (first) {
          first = false;
          try {
            service.runStartupLegacyImport({
              workspace: fixture.ws,
              workspaceScopeId: scope.workspaceScopeId,
              migrationId: 'nested-migration',
              plannedAtMs: 2,
              completedResults: [],
            });
          } catch (error) {
            nestedError = error;
          }
        }
        return fixture.store;
      },
      closeTrustedStoreForReset: () => fixture.store.close(),
      now: () => 3,
    })!;
    try {
      service.runStartupLegacyImport({
        workspace: fixture.ws,
        workspaceScopeId: scope.workspaceScopeId,
        migrationId: 'outer-migration',
        plannedAtMs: 2,
        completedResults: [],
      });
      expect(nestedError).toBeInstanceOf(ChatOperationV2MigrationServiceError);
      expect(nestedError).toMatchObject({ code: 'migration_busy' });
    } finally {
      stop(fixture);
    }
  });

  test('explicit facade reset archives corrupt key/DB, zeros generated bytes, and returns no paths', () => {
    const fixture = setup('reset');
    const pipelineBefore = readFileSync(fixture.pipelinePath);
    writeFileSync(fixture.controlPaths.keyPath, Buffer.from('corrupt-key'));
    if (process.platform !== 'win32') chmodSync(fixture.controlPaths.keyPath, 0o600);
    const generated = Buffer.alloc(32, 31);
    let activated = 0;
    let aborted = 0;
    const service = createChatOperationV2MigrationService({
      enabled: true,
      controlPaths: fixture.controlPaths,
      getTrustedStore: () => fixture.store,
      closeTrustedStoreForReset: () => fixture.store.closeForOfflineMigrationInspection(),
      onResetActivated: () => {
        activated += 1;
      },
      onResetAborted: () => {
        aborted += 1;
      },
      now: () => 200,
      randomBytes: () => generated,
    })!;
    try {
      const clientRequestId = 'facade-reset-request';
      const resetIdentity = deriveChatOperationV2ResetRequestIdentity(clientRequestId);
      const result = service.resetControlData({
        workspace: fixture.ws,
        ...resetIdentity,
        clientRequestId,
        confirmation: CHAT_OPERATION_V2_RESET_CONFIRMATION,
      });
      expect(result).toMatchObject({
        receipt: { disposition: 'control_reset', replayed: false },
        diagnostics: {
          kind: 'control_reset',
          trigger: 'corrupt_key',
          oldKeyDisposition: 'archived',
          controlGeneration: 2,
        },
      });
      expect(generated.every((byte) => byte === 0)).toBe(true);
      expect(activated).toBe(1);
      expect(aborted).toBe(0);
      expect(JSON.stringify(result)).not.toContain(fixture.root);
      expect(readFileSync(fixture.pipelinePath)).toEqual(pipelineBefore);
      expect(readFileSync(fixture.controlPaths.keyPath)).toEqual(Buffer.alloc(32, 31));
    } finally {
      stop(fixture);
    }
  });

  test('replays a client request from the new lineage without another close, key, or reset', () => {
    const fixture = setup('reset-replay');
    writeFileSync(fixture.controlPaths.keyPath, Buffer.from('corrupt-key'));
    if (process.platform !== 'win32') chmodSync(fixture.controlPaths.keyPath, 0o600);
    const generated = Buffer.alloc(32, 47);
    const generatedKeyId = `sha256:${sha256(generated)}`;
    let activeStore = fixture.store;
    let closeCalls = 0;
    let randomCalls = 0;
    let activated = 0;
    let aborted = 0;
    const service = createChatOperationV2MigrationService({
      enabled: true,
      controlPaths: fixture.controlPaths,
      getTrustedStore: () => activeStore,
      closeTrustedStoreForReset() {
        closeCalls += 1;
        activeStore.closeForOfflineMigrationInspection();
      },
      onResetActivated() {
        activated += 1;
        activeStore = new ChatOperationV2Store({
          databasePath: fixture.controlPaths.databasePath,
          keyId: generatedKeyId,
        });
      },
      onResetAborted() {
        aborted += 1;
      },
      now: () => 300,
      randomBytes() {
        randomCalls += 1;
        return generated;
      },
    })!;
    const clientRequestId = 'facade-reset-replay-request';
    const resetIdentity = deriveChatOperationV2ResetRequestIdentity(clientRequestId);
    const input = {
      workspace: fixture.ws,
      ...resetIdentity,
      clientRequestId,
      confirmation: CHAT_OPERATION_V2_RESET_CONFIRMATION,
    } as const;
    try {
      const first = service.resetControlData(input);
      const replay = service.resetControlData(input);
      expect(replay.receipt).toEqual({ ...first.receipt, replayed: true });
      expect(replay.diagnostics).toEqual(first.diagnostics);
      expect(closeCalls).toBe(1);
      expect(randomCalls).toBe(1);
      expect(activated).toBe(1);
      expect(aborted).toBe(0);
      expect(generated.every((byte) => byte === 0)).toBe(true);

      for (const conflict of [
        { ...input, requestedAtMs: 298 },
        { ...input, newLineageId: 'facade-other-lineage' },
        { ...input, clientRequestId: 'facade-other-request' },
        {
          ...input,
          workspace: {
            workDir: join(fixture.root, 'other-workspace'),
          } as WorkspaceState,
        },
      ]) {
        expect(() => service.resetControlData(conflict)).toThrow(
          expect.objectContaining({ code: 'control_reset_failed' }),
        );
      }
      expect(closeCalls).toBe(1);
      expect(randomCalls).toBe(1);
      expect(activated).toBe(1);
      expect(aborted).toBe(0);
    } finally {
      activeStore.close();
      stop(fixture);
    }
  });
});
