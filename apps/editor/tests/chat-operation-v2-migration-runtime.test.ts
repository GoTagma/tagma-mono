import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createChatOperationV2MigrationRuntime,
  createChatOperationV2ResetKeyMaterial,
  createChatOperationV2StoreMigrationAdapter,
  createNodeChatOperationV2MigrationFileAdapter,
  inspectOfflineChatOperationV2ControlLineage,
  openOfflineChatOperationV2ResetOnlyStore,
  OfflineChatOperationV2ControlLineageError,
  prepareExplicitChatOperationV2ControlReset,
  prepareLegacyV1ChatMigration,
  type ChatOperationV2StoreMigrationExtension,
} from '../server/chat-operations/migration-runtime.js';
import {
  clearChatYamlStageSessionRelocation,
  createChatYamlStage,
  discardChatYamlStage,
  prepareChatYamlStageSessionRelocation,
} from '../server/chat-yaml-staging.js';
import { reserveChatPipelineBinding } from '../server/chat-pipeline-binding.js';
import { tagmaDirOf } from '../server/pipeline-paths.js';
import { __serverRecordAuthTestHooks } from '../server/server-record-auth.js';
import { WorkspaceState } from '../server/workspace-state.js';
import type { ChatOperationV2MigrationExecutionRecord } from '../server/chat-operations/migration-executor.js';
import { planExplicitChatControlReset } from '../server/chat-operations/migration.js';
import { ChatOperationV2Store } from '../server/chat-operations/store.js';

const roots: string[] = [];
const originalKeyFile = process.env.TAGMA_STAGE_RECORD_KEY_FILE;

function makeRoot(label: string): string {
  const root = join(
    tmpdir(),
    `tagma-v2-migration-runtime-${label}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function resetArchiveSuffix(planId: string): string {
  return createHash('sha256')
    .update('tagma.chat-operation-v2.control-reset-archive\0', 'utf8')
    .update(planId, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function setupWorkspace(label: string) {
  const root = makeRoot(label);
  const keyPath = join(root, 'stable-control', 'stage-record-hmac.key');
  process.env.TAGMA_STAGE_RECORD_KEY_FILE = keyPath;
  __serverRecordAuthTestHooks.resetKeyCache();
  const tagmaDir = tagmaDirOf(root);
  const sourcePath = join(tagmaDir, 'source', 'source.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    'pipeline:\n  name: Source\n  version: 1.0.0\ntracks:\n  main:\n    tasks:\n      work:\n        type: command\n        command: echo ok\n',
    'utf8',
  );
  writeFileSync(
    join(tagmaDir, 'editor-settings.json'),
    JSON.stringify({ opencodeChatTrialRunEnabled: false }),
    'utf8',
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.yamlEditLock = {
    id: 'yaml-lock-01',
    owner: 'chat',
    reason: 'migration fixture',
    acquiredAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    yamlPath: sourcePath,
  };
  return { root, tagmaDir, sourcePath, ws };
}

function stopWorkspace(ws: WorkspaceState): void {
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
}

afterEach(() => {
  if (originalKeyFile === undefined) delete process.env.TAGMA_STAGE_RECORD_KEY_FILE;
  else process.env.TAGMA_STAGE_RECORD_KEY_FILE = originalKeyFile;
  __serverRecordAuthTestHooks.resetKeyCache();
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Chat Operation V2 production migration runtime', () => {
  test('prepares certified V1 bindings and a complete active-stage recovery from real records', () => {
    const fixture = setupWorkspace('legacy');
    const published = reserveChatPipelineBinding(fixture.ws, {
      sessionId: 'session-published',
      bindingRequestId: 'binding-request-published',
      intent: 'edit',
      originRelativePath: 'source/source.yaml',
    });
    const publishedPath = join(fixture.tagmaDir, ...published.targetRelativePath.split('/'));
    mkdirSync(dirname(publishedPath), { recursive: true });
    writeFileSync(publishedPath, 'pipeline:\n  name: Published\n  version: 1.0.0\n', 'utf8');

    const stage = createChatYamlStage(fixture.ws, {
      activePath: fixture.sourcePath,
      pipelineBinding: {
        sessionId: 'session-stage',
        bindingRequestId: 'binding-request-stage',
        intent: 'edit',
      },
    });
    const relocation = prepareChatYamlStageSessionRelocation(fixture.ws, {
      stageId: stage.id,
      sessionId: 'session-stage',
      relocationId: 'relocation-stage',
    });

    try {
      const prepared = prepareLegacyV1ChatMigration({
        workspace: fixture.ws,
        workspaceScopeId: 'workspace-scope-01',
        migrationId: 'migration-runtime-01',
        plannedAtMs: Date.now(),
        completedResults: [],
        inspectSession(sessionId) {
          return sessionId === 'session-stage'
            ? { sessionId, directory: relocation.sourceDirectory, status: 'idle' }
            : null;
        },
      });

      expect(prepared.plan.registryDisposition).toBe('imported');
      if (prepared.plan.registryDisposition !== 'imported') throw new Error('Expected import.');
      const bindings = prepared.plan.sqliteTransaction.mutations.filter(
        (mutation) => mutation.kind === 'import_legacy_binding',
      );
      expect(bindings.map(({ status }) => status).sort()).toEqual(['published', 'released']);
      const recovery = prepared.plan.sqliteTransaction.mutations.find(
        (mutation) => mutation.kind === 'import_legacy_stage_recovery',
      );
      expect(recovery).toMatchObject({
        sessionId: 'session-stage',
        executionAuthority: 'none',
        publicationAuthority: 'none',
      });
      expect(prepared.diagnostics).toEqual([]);

      for (const mutation of bindings) {
        const evidence = prepared.files.verifyLegacyBindingEvidence(mutation);
        expect(evidence).toMatchObject({
          status: mutation.status,
          sourceRecordHash: mutation.sourceRecordHash,
          evidenceHash: mutation.evidenceHash,
          targetIdentity: mutation.target.identity,
        });
      }
      if (!recovery || recovery.kind !== 'import_legacy_stage_recovery') {
        throw new Error('Expected stage recovery mutation.');
      }
      expect(prepared.files.verifyLegacyStageEvidence(recovery)).toMatchObject({
        sourceRecordHash: recovery.sourceRecordHash,
        evidenceHashes: recovery.evidenceHashes,
        sessionId: recovery.sessionId,
      });

      writeFileSync(publishedPath, 'pipeline:\n  name: Third Party Drift\n', 'utf8');
      expect(
        prepared.files.verifyLegacyBindingEvidence(
          bindings.find((mutation) => mutation.status === 'published')!,
        ).evidenceHash,
      ).not.toBe(bindings.find((mutation) => mutation.status === 'published')!.evidenceHash);
    } finally {
      clearChatYamlStageSessionRelocation(fixture.ws, {
        stageId: stage.id,
        sessionId: 'session-stage',
        relocationId: 'relocation-stage',
        expectedPhase: 'prepared',
        verifiedHomeDirectory: relocation.sourceDirectory,
      });
      discardChatYamlStage(fixture.ws, stage.id);
      stopWorkspace(fixture.ws);
    }
  });

  test('quarantines a tampered authenticated registry without interpreting ownership', () => {
    const fixture = setupWorkspace('quarantine');
    reserveChatPipelineBinding(fixture.ws, {
      sessionId: 'session-one',
      bindingRequestId: 'binding-request-one',
      intent: 'edit',
      originRelativePath: 'source/source.yaml',
    });
    const registryPath = join(fixture.tagmaDir, '.chat-pipeline-bindings', 'bindings.json');
    const tampered = readFileSync(registryPath, 'utf8').replace('session-one', 'session-evil');
    writeFileSync(registryPath, tampered, 'utf8');

    try {
      const prepared = prepareLegacyV1ChatMigration({
        workspace: fixture.ws,
        workspaceScopeId: 'workspace-scope-01',
        migrationId: 'migration-quarantine-01',
        plannedAtMs: Date.now(),
        completedResults: [],
      });
      expect(prepared.plan.registryDisposition).toBe('quarantined');
      expect(prepared.plan.inventoryProjection).not.toHaveLength(0);
      expect(
        prepared.plan.inventoryProjection.every(({ ownership }) => ownership === 'unowned'),
      ).toBe(true);
      expect(prepared.diagnostics).toEqual([
        { kind: 'legacy_registry_quarantined', id: 'registry', reason: 'invalid_hmac' },
      ]);
    } finally {
      stopWorkspace(fixture.ws);
    }
  });

  test('isolates an active stage lacking complete relocation/session evidence without deleting it', () => {
    const fixture = setupWorkspace('incomplete-stage');
    const stage = createChatYamlStage(fixture.ws, {
      activePath: fixture.sourcePath,
      pipelineBinding: {
        sessionId: 'session-incomplete',
        bindingRequestId: 'binding-request-incomplete',
        intent: 'edit',
      },
    });
    try {
      const prepared = prepareLegacyV1ChatMigration({
        workspace: fixture.ws,
        workspaceScopeId: 'workspace-scope-01',
        migrationId: 'migration-incomplete-stage-01',
        plannedAtMs: Date.now(),
        completedResults: [],
      });
      expect(
        prepared.plan.sqliteTransaction.mutations.some(
          (mutation) => mutation.kind === 'import_legacy_stage_recovery',
        ),
      ).toBe(false);
      expect(prepared.diagnostics).toContainEqual({
        kind: 'legacy_stage_isolated',
        id: stage.id,
        reason: 'stage_relocation_missing',
      });
      expect(existsSync(stage.rootDir)).toBe(true);
      expect(readFileSync(stage.activeStagedPath!, 'utf8')).toContain('name: Source');
    } finally {
      discardChatYamlStage(fixture.ws, stage.id);
      stopWorkspace(fixture.ws);
    }
  });

  test('archives DB+old key, O_EXCL installs the sealed new key, and restores both on failure', () => {
    const root = makeRoot('archive');
    const controlDir = join(root, 'server-control');
    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    const planId = 'reset-runtime-test';
    const suffix = resetArchiveSuffix(planId);
    const archivePath = join(controlDir, `chat-operation-v2.sqlite.${suffix}.archive`);
    const keyArchivePath = join(controlDir, `control-hmac-v2.key.${suffix}.archive`);
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    writeFileSync(databasePath, 'exact-old-control-bytes', { mode: 0o600 });
    const oldKey = Buffer.from('corrupt-old-key-bytes', 'utf8');
    writeFileSync(keyPath, oldKey, { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(controlDir, 0o700);
      chmodSync(databasePath, 0o600);
      chmodSync(keyPath, 0o600);
    }
    const expectedDatabaseHash = sha256('exact-old-control-bytes');
    const expectedKeyHash = sha256(oldKey);
    const generatedNewKey = Buffer.alloc(32, 9);
    const resetKeyMaterial = createChatOperationV2ResetKeyMaterial(() => generatedNewKey);
    expect(generatedNewKey.every((byte) => byte === 0)).toBe(true);
    const plan = planExplicitChatControlReset({
      planId,
      requestedAtMs: 1,
      trigger: 'corrupt_key',
      authorization: {
        kind: 'explicit_user_reset',
        requestId: 'reset-runtime-request',
        confirmationHash: sha256('confirmed'),
      },
      oldControl: {
        lineageId: 'lineage-old',
        controlGeneration: 1,
        databaseId: 'database-old',
        databaseHash: expectedDatabaseHash,
        keyId: `sha256:${sha256(Buffer.alloc(32, 7))}`,
        keyState: 'corrupt',
      },
      archive: {
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        sourceDatabasePath: databasePath,
        archiveDatabasePath: archivePath,
        expectedDatabaseHash,
        sourceKeyPath: keyPath,
        archiveKeyPath: keyArchivePath,
        expectedKeyHash,
      },
      newControl: {
        lineageId: 'lineage-new',
        controlGeneration: 2,
        keyId: resetKeyMaterial.keyId,
      },
      inventory: [],
    });
    const files = createNodeChatOperationV2MigrationFileAdapter({
      controlPaths: { controlDir, databasePath, keyPath },
      resetKeyMaterial,
    });

    expect(files.inspectControlArchives(plan)).toEqual({
      database: {
        sourceKind: 'regular',
        sourceHash: expectedDatabaseHash,
        archiveExists: false,
      },
      key: { sourceKind: 'regular', sourceHash: expectedKeyHash, archiveExists: false },
    });
    expect(files.archiveControlFiles(plan)).toEqual({
      database: {
        sourcePresent: false,
        archiveKind: 'regular',
        archiveHash: expectedDatabaseHash,
      },
      key: { sourcePresent: false, archiveKind: 'regular', archiveHash: expectedKeyHash },
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
    expect(readFileSync(archivePath, 'utf8')).toBe('exact-old-control-bytes');
    expect(readFileSync(keyArchivePath)).toEqual(oldKey);
    expect(files.installNewControlKey(plan.newControl)).toEqual({ keyId: plan.newControl.keyId });
    expect(readFileSync(keyPath)).toEqual(Buffer.alloc(32, 9));

    files.discardFailedNewControlKey(plan.newControl);
    files.restoreControlFiles(plan);
    files.disposeControlResetKey();
    expect(readFileSync(databasePath, 'utf8')).toBe('exact-old-control-bytes');
    expect(readFileSync(keyPath)).toEqual(oldKey);
    expect(existsSync(archivePath)).toBe(false);
    expect(existsSync(keyArchivePath)).toBe(false);
  });

  test('handles explicit lost-key reset without inventing an old key archive', () => {
    const root = makeRoot('missing-key');
    const controlDir = join(root, 'server-control');
    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    writeFileSync(databasePath, 'old-db-with-lost-key', { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(controlDir, 0o700);
      chmodSync(databasePath, 0o600);
    }
    const planId = 'reset-missing-key';
    const suffix = resetArchiveSuffix(planId);
    const material = createChatOperationV2ResetKeyMaterial(() => Buffer.alloc(32, 6));
    const plan = planExplicitChatControlReset({
      planId,
      requestedAtMs: 1,
      trigger: 'missing_key',
      authorization: {
        kind: 'explicit_user_reset',
        requestId: 'missing-key-request',
        confirmationHash: sha256('confirmed-missing'),
      },
      oldControl: {
        lineageId: 'lineage-old',
        controlGeneration: 1,
        databaseId: 'database-old',
        databaseHash: sha256('old-db-with-lost-key'),
        keyId: `sha256:${sha256(Buffer.alloc(32, 2))}`,
        keyState: 'missing',
      },
      archive: {
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        sourceDatabasePath: databasePath,
        archiveDatabasePath: join(controlDir, `chat-operation-v2.sqlite.${suffix}.archive`),
        expectedDatabaseHash: sha256('old-db-with-lost-key'),
        sourceKeyPath: keyPath,
        archiveKeyPath: null,
        expectedKeyHash: null,
      },
      newControl: {
        lineageId: 'lineage-new',
        controlGeneration: 2,
        keyId: material.keyId,
      },
      inventory: [],
    });
    const files = createNodeChatOperationV2MigrationFileAdapter({
      controlPaths: { controlDir, databasePath, keyPath },
      resetKeyMaterial: material,
    });

    expect(files.inspectControlArchives(plan).key).toEqual({
      sourceKind: 'missing',
      sourceHash: null,
      archiveExists: false,
    });
    expect(files.archiveControlFiles(plan).key).toBeNull();
    expect(files.installNewControlKey(plan.newControl)).toEqual({ keyId: plan.newControl.keyId });
    expect(readFileSync(keyPath)).toEqual(Buffer.alloc(32, 6));

    files.discardFailedNewControlKey(plan.newControl);
    files.restoreControlFiles(plan);
    files.disposeControlResetKey();
    expect(readFileSync(databasePath, 'utf8')).toBe('old-db-with-lost-key');
    expect(existsSync(keyPath)).toBe(false);
  });

  test('offline reset inspector reads only sealed migration/control-lineage metadata', () => {
    const root = makeRoot('offline-lineage');
    const controlDir = join(root, 'server-control');
    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    const sqlite = new Database(databasePath, { create: true, strict: true });
    const keyId = `sha256:${sha256(Buffer.alloc(32, 5))}`;
    const lineage = {
      activatedAtMs: 12,
      controlGeneration: 3,
      keyId,
      lineageId: 'lineage-offline',
      ownershipImport: 'none',
    };
    const canonical = JSON.stringify(lineage);
    sqlite.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE migration_records (
        schema_version INTEGER PRIMARY KEY,
        control_key_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE control_lineages (
        singleton INTEGER PRIMARY KEY,
        lineage_id TEXT NOT NULL,
        control_generation INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        ownership_import TEXT NOT NULL,
        activated_at_ms INTEGER NOT NULL,
        control_lineage_hash TEXT NOT NULL,
        control_lineage_canonical BLOB NOT NULL
      ) STRICT;
    `);
    sqlite
      .query('INSERT INTO migration_records (schema_version, control_key_id) VALUES (1, ?)')
      .run(keyId);
    sqlite
      .query(
        `INSERT INTO control_lineages (
          singleton, lineage_id, control_generation, key_id, ownership_import,
          activated_at_ms, control_lineage_hash, control_lineage_canonical
        ) VALUES (1, ?, ?, ?, 'none', ?, ?, ?)`,
      )
      .run(
        lineage.lineageId,
        lineage.controlGeneration,
        lineage.keyId,
        lineage.activatedAtMs,
        sha256(canonical),
        Buffer.from(canonical),
      );
    sqlite.close();
    if (process.platform !== 'win32') {
      chmodSync(controlDir, 0o700);
      chmodSync(databasePath, 0o600);
    }
    const controlPaths = { controlDir, databasePath, keyPath };
    const workspace = new WorkspaceState(root);
    workspace.workDir = root;

    const inspection = inspectOfflineChatOperationV2ControlLineage(controlPaths);
    expect(inspection).toMatchObject({
      lineageId: 'lineage-offline',
      controlGeneration: 3,
      keyId,
      ownershipImport: 'none',
    });
    expect(inspection.databaseId).toMatch(/^control-database-[0-9a-f]{32}$/);
    expect(inspection.databaseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(readFileSync(databasePath))).toBe(inspection.databaseHash);
    const material = createChatOperationV2ResetKeyMaterial(() => Buffer.alloc(32, 8));
    const prepared = prepareExplicitChatOperationV2ControlReset({
      workspace,
      controlPaths,
      inspection,
      planId: 'offline-reset-plan',
      requestedAtMs: 20,
      trigger: 'missing_key',
      authorization: {
        kind: 'explicit_user_reset',
        requestId: 'offline-reset-request',
        confirmationHash: sha256('offline-confirmed'),
      },
      oldKeyState: 'missing',
      newLineageId: 'lineage-after-offline-reset',
      keyMaterial: material,
    });
    expect(prepared.plan.oldControl).toMatchObject({
      lineageId: 'lineage-offline',
      controlGeneration: 3,
      keyId,
      keyState: 'missing',
    });
    expect(prepared.plan.controlFileActions).toHaveLength(1);
    prepared.keyMaterial.dispose();

    const drift = new Database(databasePath, { readwrite: true, create: false, strict: true });
    drift.exec('CREATE TABLE unrelated_drift (id INTEGER PRIMARY KEY) STRICT');
    drift.close();
    const staleMaterial = createChatOperationV2ResetKeyMaterial(() => Buffer.alloc(32, 10));
    expect(() =>
      prepareExplicitChatOperationV2ControlReset({
        workspace,
        controlPaths,
        inspection,
        planId: 'offline-reset-stale-plan',
        requestedAtMs: 21,
        trigger: 'missing_key',
        authorization: {
          kind: 'explicit_user_reset',
          requestId: 'offline-reset-stale-request',
          confirmationHash: sha256('offline-stale-confirmed'),
        },
        oldKeyState: 'missing',
        newLineageId: 'lineage-after-stale-reset',
        keyMaterial: staleMaterial,
      }),
    ).toThrow('changed after lineage inspection');

    const tamper = new Database(databasePath, { readwrite: true, create: false, strict: true });
    tamper
      .query('UPDATE control_lineages SET control_lineage_hash = ? WHERE singleton = 1')
      .run('0'.repeat(64));
    tamper.close();
    expect(() => inspectOfflineChatOperationV2ControlLineage(controlPaths)).toThrow(
      OfflineChatOperationV2ControlLineageError,
    );
    stopWorkspace(workspace);
  });

  test('service reset surface retains forensic DB/key archives and activates only the fresh lineage', () => {
    const fixture = setupWorkspace('full-reset');
    const pipelineBefore = readFileSync(fixture.sourcePath);
    const controlDir = join(fixture.root, 'server-control');
    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    writeFileSync(databasePath, 'old-database', { mode: 0o600 });
    writeFileSync(keyPath, Buffer.alloc(32, 3), { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(controlDir, 0o700);
      chmodSync(databasePath, 0o600);
      chmodSync(keyPath, 0o600);
    }
    const planId = 'reset-full-runtime';
    const suffix = resetArchiveSuffix(planId);
    const material = createChatOperationV2ResetKeyMaterial(() => Buffer.alloc(32, 4));
    const plan = planExplicitChatControlReset({
      planId,
      requestedAtMs: 10,
      trigger: 'user_requested',
      authorization: {
        kind: 'explicit_user_reset',
        requestId: 'reset-full-request',
        confirmationHash: sha256('confirmed-full'),
      },
      oldControl: {
        lineageId: 'lineage-old',
        controlGeneration: 3,
        databaseId: 'database-old',
        databaseHash: sha256('old-database'),
        keyId: `sha256:${sha256(Buffer.alloc(32, 3))}`,
        keyState: 'available',
      },
      archive: {
        platform: process.platform === 'win32' ? 'win32' : 'posix',
        sourceDatabasePath: databasePath,
        archiveDatabasePath: join(controlDir, `chat-operation-v2.sqlite.${suffix}.archive`),
        expectedDatabaseHash: sha256('old-database'),
        sourceKeyPath: keyPath,
        archiveKeyPath: join(controlDir, `control-hmac-v2.key.${suffix}.archive`),
        expectedKeyHash: sha256(Buffer.alloc(32, 3)),
      },
      newControl: {
        lineageId: 'lineage-new',
        controlGeneration: 4,
        keyId: material.keyId,
      },
      inventory: [],
    });
    const executions = new Map<string, ChatOperationV2MigrationExecutionRecord>();
    const extension: ChatOperationV2StoreMigrationExtension = {
      readMigrationExecution: (id) => executions.get(id) ?? null,
      runMigrationImmediate() {
        throw new Error('not used');
      },
      beginMigrationControlReset(resetPlan) {
        const replay = executions.get(resetPlan.planId);
        if (replay) return { kind: 'replayed', execution: replay };
        return {
          kind: 'ready',
          session: {
            abort() {},
            closeOldControl() {},
            initializeNewLineage(input) {
              writeFileSync(databasePath, 'new-database', { mode: 0o600 });
              if (process.platform !== 'win32') chmodSync(databasePath, 0o600);
              executions.set(input.execution.planId, input.execution);
              return {
                lineageId: resetPlan.newControl.lineageId,
                controlGeneration: resetPlan.newControl.controlGeneration,
                keyId: resetPlan.newControl.keyId,
                ownershipImport: 'none',
              };
            },
            discardFailedNewLineage() {
              rmSync(databasePath, { force: true });
            },
            restorePreviousControl() {},
          },
        };
      },
    };
    const runtime = createChatOperationV2MigrationRuntime({
      workspace: fixture.ws,
      store: createChatOperationV2StoreMigrationAdapter(extension),
      controlPaths: { controlDir, databasePath, keyPath },
      now: () => 11,
    });

    try {
      expect(() =>
        (runtime.execute as (candidate: unknown, files: unknown) => unknown)(plan, {}),
      ).toThrow('only through resetControlData');
      const receipt = runtime.resetControlData(plan, material);
      expect(receipt).toMatchObject({
        disposition: 'control_reset',
        controlGeneration: 4,
        replayed: false,
      });
      expect(receipt.controlArchiveSetHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain(controlDir);
      expect(JSON.stringify(receipt)).not.toContain(material.keyId);
      expect(readFileSync(databasePath, 'utf8')).toBe('new-database');
      expect(readFileSync(keyPath)).toEqual(Buffer.alloc(32, 4));
      expect(readFileSync(plan.controlFileActions[0].archiveDatabasePath, 'utf8')).toBe(
        'old-database',
      );
      expect(readFileSync(plan.controlFileActions[1]!.archiveKeyPath)).toEqual(Buffer.alloc(32, 3));
      expect(readFileSync(fixture.sourcePath)).toEqual(pipelineBefore);
    } finally {
      stopWorkspace(fixture.ws);
    }
  });

  test('real Store + Node control runtime resets a corrupt raw key without reading operation rows', () => {
    const fixture = setupWorkspace('real-store-reset');
    const pipelineBefore = readFileSync(fixture.sourcePath);
    const controlDir = join(fixture.root, 'server-control');
    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    const oldKey = Buffer.alloc(32, 11);
    const oldKeyId = `sha256:${sha256(oldKey)}`;
    writeFileSync(keyPath, oldKey, { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(controlDir, 0o700);
      chmodSync(keyPath, 0o600);
    }
    const initialStore = new ChatOperationV2Store({ databasePath, keyId: oldKeyId });
    initialStore.close();
    const controlPaths = { controlDir, databasePath, keyPath };
    const inspection = inspectOfflineChatOperationV2ControlLineage(controlPaths);
    expect(inspection.keyId).toBe(oldKeyId);

    writeFileSync(keyPath, Buffer.from('corrupt-raw-key', 'utf8'));
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
    const material = createChatOperationV2ResetKeyMaterial(() => Buffer.alloc(32, 12));
    const prepared = prepareExplicitChatOperationV2ControlReset({
      workspace: fixture.ws,
      controlPaths,
      inspection,
      planId: 'real-store-reset-plan',
      requestedAtMs: 100,
      trigger: 'corrupt_key',
      authorization: {
        kind: 'explicit_user_reset',
        requestId: 'real-store-reset-request',
        confirmationHash: sha256('real-store-confirmed'),
      },
      oldKeyState: 'corrupt',
      newLineageId: 'real-store-new-lineage',
      keyMaterial: material,
    });
    const resetAuthority = openOfflineChatOperationV2ResetOnlyStore(controlPaths, inspection);
    const runtime = createChatOperationV2MigrationRuntime({
      workspace: fixture.ws,
      store: resetAuthority.store,
      controlPaths,
      now: () => 101,
    });
    try {
      const receipt = runtime.resetControlData(prepared.plan, prepared.keyMaterial);
      expect(receipt).toMatchObject({
        disposition: 'control_reset',
        controlGeneration: inspection.controlGeneration + 1,
      });
      const { replayed: _replayed, ...execution } = receipt;
      expect(resetAuthority.readExecution(prepared.plan.planId)).toEqual(execution);
      expect(readFileSync(keyPath)).toEqual(Buffer.alloc(32, 12));
      expect(
        readFileSync(prepared.plan.controlFileActions[0].archiveDatabasePath),
      ).not.toHaveLength(0);
      expect(readFileSync(prepared.plan.controlFileActions[1]!.archiveKeyPath, 'utf8')).toBe(
        'corrupt-raw-key',
      );
      expect(readFileSync(fixture.sourcePath)).toEqual(pipelineBefore);
    } finally {
      resetAuthority.close();
      stopWorkspace(fixture.ws);
    }
  });

  test('exposes a service-callable runtime over the queued ChatOperationV2Store extension', () => {
    const fixture = setupWorkspace('runtime');
    const executions = new Map<string, ChatOperationV2MigrationExecutionRecord>();
    const extension: ChatOperationV2StoreMigrationExtension = {
      readMigrationExecution(planId) {
        return executions.get(planId) ?? null;
      },
      runMigrationImmediate(run) {
        return run({
          getExecution: (planId) => executions.get(planId) ?? null,
          recordExecution(record) {
            executions.set(record.planId, record);
          },
          importLegacyBinding() {},
          importLegacyStageRecovery() {},
          quarantineLegacyRegistry() {},
          recordLegacyHistory() {},
          replaceInventoryProjection() {},
          inspectWorkspaceAdoption() {
            throw new Error('not used');
          },
          adoptMovedWorkspace() {},
        });
      },
      beginMigrationControlReset() {
        throw new Error('not used');
      },
    };
    const runtime = createChatOperationV2MigrationRuntime({
      workspace: fixture.ws,
      store: createChatOperationV2StoreMigrationAdapter(extension),
      controlPaths: {
        controlDir: join(fixture.root, 'server-control'),
        databasePath: join(fixture.root, 'server-control', 'chat-operation-v2.sqlite'),
        keyPath: join(fixture.root, 'server-control', 'control-hmac-v2.key'),
      },
      now: () => 5_000,
    });

    try {
      const result = runtime.migrateLegacyV1({
        workspaceScopeId: 'workspace-scope-01',
        migrationId: 'migration-callable-01',
        plannedAtMs: 4_000,
        completedResults: [],
      });
      expect(result.receipt).toMatchObject({
        disposition: 'legacy_imported',
        replayed: false,
      });
      expect(result.prepared.plan.planHash).toBe(result.receipt.planHash);
      expect(executions.has('migration-callable-01')).toBe(true);
    } finally {
      stopWorkspace(fixture.ws);
    }
  });
});
