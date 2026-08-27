/* eslint-disable @typescript-eslint/no-explicit-any -- mutation tests intentionally forge sealed plans */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  parseChatOperationV2MigrationPlan,
  planExplicitChatControlReset,
  planWorkspacePathChange,
} from '../server/chat-operations/migration.js';

const hash = (digit: string): string => digit.repeat(64);

function emptyScope(workspaceScopeId: string, digit: string) {
  return {
    workspaceScopeId,
    canonicalPathHmac: hash(digit),
    recordHmac: hash(digit),
    controlGeneration: 1,
    recordsAuthentication: 'trusted' as const,
    empty: true,
    ownership: 'unowned' as const,
    nonterminalOperationIds: [],
    pendingCommitWalIds: [],
    publishedBindingIds: [],
    authoritativeResultIds: [],
  };
}

function adoptionInput() {
  return {
    planId: 'workspace-adoption-plan-1',
    plannedAtMs: 700,
    request: 'adopt_moved_workspace' as const,
    oldPathState: 'missing' as const,
    oldScope: {
      ...emptyScope('scope-old', '2'),
      empty: false,
      ownership: 'owned' as const,
      recordHmac: hash('2'),
      publishedBindingIds: ['binding-1'],
      authoritativeResultIds: ['result-1'],
    },
    newScope: emptyScope('scope-new', '3'),
    adoptedOldScopeRecordHmac: hash('4'),
  };
}

function resetArchiveSuffix(planId: string): string {
  return createHash('sha256')
    .update('tagma.chat-operation-v2.control-reset-archive\0', 'utf8')
    .update(planId, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function resignPlan<T extends Record<string, any>>(value: T): T {
  const { planHash: _planHash, ...base } = value;
  return {
    ...base,
    planHash: createHash('sha256')
      .update(JSON.stringify(canonicalJson(base)))
      .digest('hex'),
  } as unknown as T;
}

describe('ChatTurn Operation V2 workspace path protocol', () => {
  test('keeps a new path unowned and distinguishes an active old path as a clone without move inference', () => {
    const oldScope = {
      ...emptyScope('scope-old', '2'),
      empty: false,
      ownership: 'owned' as const,
      publishedBindingIds: ['binding-1'],
      authoritativeResultIds: ['result-1'],
    };
    const newScope = emptyScope('scope-new', '3');
    const common = {
      planId: 'workspace-path-plan-1',
      plannedAtMs: 600,
      request: 'observe_path_change' as const,
      oldScope,
      newScope,
      adoptedOldScopeRecordHmac: null,
    };

    const clone = planWorkspacePathChange({ ...common, oldPathState: 'active' });
    const unknownMove = planWorkspacePathChange({ ...common, oldPathState: 'missing' });

    expect(clone).toMatchObject({
      classification: 'clone',
      ownershipDisposition: 'new_scope_unowned',
      pathInference: 'forbidden',
      sqliteTransaction: { atomic: true, mode: 'immediate', mutations: [] },
    });
    expect(unknownMove).toMatchObject({
      classification: 'new_path',
      ownershipDisposition: 'new_scope_unowned',
      pathInference: 'forbidden',
      sqliteTransaction: { atomic: true, mode: 'immediate', mutations: [] },
    });
    expect(clone.fileMutations).toEqual({ delete: [], move: [], rewrite: [] });
    expect(parseChatOperationV2MigrationPlan(clone)).toEqual(clone);
    expect(parseChatOperationV2MigrationPlan(unknownMove)).toEqual(unknownMove);

    const nonAtomic = JSON.parse(JSON.stringify(clone)) as Record<string, any>;
    nonAtomic.sqliteTransaction.atomic = false;
    expect(() => parseChatOperationV2MigrationPlan(nonAtomic)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
  });

  test('adopts an explicitly moved workspace through one content-minimized atomic SQLite mutation', () => {
    const plan = planWorkspacePathChange(adoptionInput());

    expect(plan).toMatchObject({
      request: 'adopt_moved_workspace',
      classification: 'moved',
      ownershipDisposition: 'old_scope_adopted',
      pathInference: 'forbidden',
      sqliteTransaction: { atomic: true, mode: 'immediate' },
    });
    expect(plan.sqliteTransaction.mutations).toEqual([
      expect.objectContaining({
        kind: 'replace_empty_scope_with_adopted_scope',
        workspaceScopeId: 'scope-old',
        emptyNewScopeId: 'scope-new',
        fromCanonicalPathHmac: hash('2'),
        toCanonicalPathHmac: hash('3'),
        expectedOldRecordHmac: hash('2'),
        expectedEmptyNewRecordHmac: hash('3'),
        adoptedRecordHmac: hash('4'),
        controlGeneration: 1,
        pathCoordinateSource: 'authenticated_new_scope',
      }),
    ]);
    expect(JSON.stringify(plan)).not.toContain('canonicalPath"');
    expect(plan.fileMutations).toEqual({ delete: [], move: [], rewrite: [] });
    expect(parseChatOperationV2MigrationPlan(plan)).toEqual(plan);
    expect(
      planWorkspacePathChange({ ...adoptionInput(), oldPathState: 'deactivated' }).classification,
    ).toBe('moved');

    const guessed = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    guessed.sqliteTransaction.mutations[0].pathCoordinateSource = 'guessed_path';
    expect(() => parseChatOperationV2MigrationPlan(guessed)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
  });

  test('rejects every failed adoption precondition instead of guessing or partially transferring authority', () => {
    const base = adoptionInput();
    const cases: Array<{
      reason: string;
      input: Parameters<typeof planWorkspacePathChange>[0];
    }> = [
      { reason: 'old_path_active_clone', input: { ...base, oldPathState: 'active' } },
      {
        reason: 'old_scope_has_nonterminal_operation',
        input: {
          ...base,
          oldScope: { ...base.oldScope, nonterminalOperationIds: ['operation-live'] },
        },
      },
      {
        reason: 'old_scope_has_pending_commit_wal',
        input: {
          ...base,
          oldScope: { ...base.oldScope, pendingCommitWalIds: ['commit-live'] },
        },
      },
      {
        reason: 'record_authentication_failed',
        input: {
          ...base,
          oldScope: { ...base.oldScope, recordsAuthentication: 'invalid_hmac' },
        },
      },
      {
        reason: 'record_authentication_failed',
        input: {
          ...base,
          newScope: { ...base.newScope, recordsAuthentication: 'invalid_hmac' },
        },
      },
      {
        reason: 'record_authentication_failed',
        input: {
          ...base,
          newScope: { ...base.newScope, recordsAuthentication: 'corrupt' },
        },
      },
      {
        reason: 'new_scope_not_empty',
        input: { ...base, newScope: { ...base.newScope, empty: false } },
      },
      {
        reason: 'new_scope_owned',
        input: {
          ...base,
          newScope: { ...base.newScope, empty: false, ownership: 'owned' },
        },
      },
      {
        reason: 'new_scope_has_nonterminal_operation',
        input: {
          ...base,
          newScope: {
            ...base.newScope,
            empty: false,
            nonterminalOperationIds: ['operation-live'],
          },
        },
      },
      {
        reason: 'new_scope_has_pending_commit_wal',
        input: {
          ...base,
          newScope: {
            ...base.newScope,
            empty: false,
            pendingCommitWalIds: ['commit-live'],
          },
        },
      },
      {
        reason: 'new_scope_has_published_binding',
        input: {
          ...base,
          newScope: {
            ...base.newScope,
            empty: false,
            publishedBindingIds: ['binding-live'],
          },
        },
      },
      {
        reason: 'new_scope_has_authoritative_result',
        input: {
          ...base,
          newScope: {
            ...base.newScope,
            empty: false,
            authoritativeResultIds: ['result-live'],
          },
        },
      },
      {
        reason: 'adopted_record_hmac_missing',
        input: { ...base, adoptedOldScopeRecordHmac: null },
      },
    ];

    for (const { reason, input } of cases) {
      expect(() => planWorkspacePathChange(input)).toThrow(
        expect.objectContaining({
          code: 'adoption_precondition_failed',
          reasons: expect.arrayContaining([reason]),
        }),
      );
    }
    expect(() =>
      planWorkspacePathChange({ ...base, adoptedOldScopeRecordHmac: 'not-a-hmac' }),
    ).toThrow(expect.objectContaining({ code: 'invalid_hash' }));
  });
});

function resetInput(): Parameters<typeof planExplicitChatControlReset>[0] {
  const planId = 'reset-plan-1';
  const archiveSuffix = resetArchiveSuffix(planId);
  return {
    planId,
    requestedAtMs: 700,
    trigger: 'corrupt_key',
    authorization: {
      kind: 'explicit_user_reset',
      requestId: 'reset-request-1',
      confirmationHash: hash('5'),
    },
    oldControl: {
      lineageId: 'lineage-old',
      controlGeneration: 7,
      databaseId: 'control-database-old',
      databaseHash: hash('6'),
      keyId: `sha256:${hash('9')}`,
      keyState: 'corrupt',
    },
    archive: {
      platform: 'posix',
      sourceDatabasePath: '/state/server-control/chat-operation-v2.sqlite',
      archiveDatabasePath: `/state/server-control/chat-operation-v2.sqlite.${archiveSuffix}.archive`,
      expectedDatabaseHash: hash('6'),
      sourceKeyPath: '/state/server-control/control-hmac-v2.key',
      archiveKeyPath: `/state/server-control/control-hmac-v2.key.${archiveSuffix}.archive`,
      expectedKeyHash: hash('8'),
    },
    newControl: {
      lineageId: 'lineage-new',
      controlGeneration: 8,
      keyId: `sha256:${hash('7')}`,
    },
    inventory: [
      {
        inventoryId: 'pipeline-1',
        platform: 'posix',
        targetCoordinate: 'pipelines/one/pipeline.yaml',
      },
    ],
  };
}

describe('ChatTurn Operation V2 explicit control reset protocol', () => {
  test('archives the old database, starts a new lineage, releases ownership, and preserves pipeline bytes', () => {
    const plan = planExplicitChatControlReset(resetInput());

    expect(plan).toMatchObject({
      kind: 'reset_chat_control_data',
      trigger: 'corrupt_key',
      authorization: { kind: 'explicit_user_reset', requestId: 'reset-request-1' },
      oldDatabaseDisposition: 'archived',
      oldKeyDisposition: 'archived',
      ownershipDisposition: 'all_released',
      keyRecovery: 'explicit_only',
      pathSelection: 'caller_supplied_exact',
      newControl: { lineageId: 'lineage-new', controlGeneration: 8 },
    });
    expect(plan.controlFileActions).toEqual([
      {
        kind: 'archive_control_database',
        archiveId: `reset-database-archive-${resetArchiveSuffix('reset-plan-1')}`,
        databaseId: 'control-database-old',
        platform: 'posix',
        sourceDatabasePath: '/state/server-control/chat-operation-v2.sqlite',
        archiveDatabasePath: `/state/server-control/chat-operation-v2.sqlite.${resetArchiveSuffix('reset-plan-1')}.archive`,
        expectedDatabaseHash: hash('6'),
      },
      {
        kind: 'archive_control_key',
        archiveId: `reset-key-archive-${resetArchiveSuffix('reset-plan-1')}`,
        platform: 'posix',
        sourceKeyPath: '/state/server-control/control-hmac-v2.key',
        archiveKeyPath: `/state/server-control/control-hmac-v2.key.${resetArchiveSuffix('reset-plan-1')}.archive`,
        expectedKeyHash: hash('8'),
      },
    ]);
    expect(plan.sqliteTransaction).toEqual({
      atomic: true,
      mode: 'immediate',
      mutations: [
        {
          kind: 'initialize_new_control_lineage',
          lineageId: 'lineage-new',
          controlGeneration: 8,
          keyId: `sha256:${hash('7')}`,
          ownershipImport: 'none',
        },
      ],
    });
    expect(plan.inventoryProjection).toEqual([
      {
        inventoryId: 'pipeline-1',
        platform: 'posix',
        targetCoordinate: 'pipelines/one/pipeline.yaml',
        targetIdentity: 'pipelines/one/pipeline.yaml',
        ownership: 'unowned',
        bindingId: null,
      },
    ]);
    expect(plan.pipelineFileMutations).toEqual({ delete: [], move: [], rewrite: [] });
    expect(parseChatOperationV2MigrationPlan(plan)).toEqual(plan);
  });

  test('never treats a missing or corrupt key as implicit reset authorization', () => {
    for (const [trigger, keyState] of [
      ['missing_key', 'missing'],
      ['corrupt_key', 'corrupt'],
    ] as const) {
      const input = resetInput();
      expect(() =>
        planExplicitChatControlReset({
          ...input,
          trigger,
          authorization: { ...input.authorization, kind: 'automatic_recovery' },
          oldControl: { ...input.oldControl, keyState },
        }),
      ).toThrow(expect.objectContaining({ code: 'reset_requires_explicit_authorization' }));
    }

    const missingKey = resetInput();
    expect(
      planExplicitChatControlReset({
        ...missingKey,
        trigger: 'missing_key',
        oldControl: { ...missingKey.oldControl, keyState: 'missing' },
        archive: {
          ...missingKey.archive,
          archiveKeyPath: null,
          expectedKeyHash: null,
        },
      }).trigger,
    ).toBe('missing_key');
  });

  test('rejects archive guessing, lineage reuse, skipped generations, and reset-plan tampering', () => {
    const base = resetInput();
    const invalidInputs: Array<{
      code: string;
      input: Parameters<typeof planExplicitChatControlReset>[0];
    }> = [
      {
        code: 'reset_generation_invalid',
        input: {
          ...base,
          newControl: { ...base.newControl, controlGeneration: 7 },
        },
      },
      {
        code: 'reset_generation_invalid',
        input: {
          ...base,
          newControl: { ...base.newControl, lineageId: 'lineage-old' },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: { ...base.archive, expectedDatabaseHash: hash('8') },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: {
            ...base.archive,
            sourceDatabasePath: '/state/server-control/../chat-operation-v2.sqlite',
          },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: {
            ...base.archive,
            archiveDatabasePath: '/other/chat-operation-v2.sqlite.700.archive',
          },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: { ...base.archive, archiveKeyPath: null },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: { ...base.archive, expectedKeyHash: null },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          trigger: 'user_requested',
          oldControl: { ...base.oldControl, keyState: 'available' },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          oldControl: {
            ...base.oldControl,
            keyId: `sha256:${base.archive.expectedKeyHash}`,
          },
        },
      },
      {
        code: 'reset_archive_invalid',
        input: {
          ...base,
          archive: {
            ...base.archive,
            archiveKeyPath: '/state/server-control/control-hmac-v2.key.guessed.archive',
          },
        },
      },
    ];
    for (const { code, input } of invalidInputs) {
      expect(() => planExplicitChatControlReset(input)).toThrow(expect.objectContaining({ code }));
    }

    const plan = planExplicitChatControlReset(base);
    const tampered = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    tampered.pipelineFileMutations.delete.push('pipelines/one/pipeline.yaml');
    expect(() => parseChatOperationV2MigrationPlan(tampered)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
    const ownershipTampered = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    ownershipTampered.inventoryProjection[0].ownership = 'session_owned';
    ownershipTampered.inventoryProjection[0].bindingId = 'binding-1';
    expect(() => parseChatOperationV2MigrationPlan(ownershipTampered)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );

    for (const field of ['move', 'rewrite'] as const) {
      const bytesTampered = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
      bytesTampered.pipelineFileMutations[field].push('pipelines/one/pipeline.yaml');
      expect(() => parseChatOperationV2MigrationPlan(bytesTampered)).toThrow(
        expect.objectContaining({ code: 'invalid_plan' }),
      );
    }
    const extraArchive = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    extraArchive.controlFileActions.push(extraArchive.controlFileActions[0]);
    expect(() => parseChatOperationV2MigrationPlan(extraArchive)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
    const resignedArchiveIdentity = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    resignedArchiveIdentity.controlFileActions[1].archiveId = 'attacker-selected-key-archive';
    expect(() => parseChatOperationV2MigrationPlan(resignPlan(resignedArchiveIdentity))).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
    const guessedPath = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    guessedPath.pathSelection = 'guessed';
    expect(() => parseChatOperationV2MigrationPlan(guessedPath)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
    const nonAtomic = JSON.parse(JSON.stringify(plan)) as Record<string, any>;
    nonAtomic.sqliteTransaction.mode = 'deferred';
    expect(() => parseChatOperationV2MigrationPlan(nonAtomic)).toThrow(
      expect.objectContaining({ code: 'invalid_plan' }),
    );
  });
});
