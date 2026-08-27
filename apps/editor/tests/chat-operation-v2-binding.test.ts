import { describe, expect, test } from 'bun:test';

import {
  applyChatOperationV2BindingCas,
  applyChatOperationV2BindingCommitTerminalCas,
  applyChatOperationV2BindingFallbackReservationCas,
  applyChatOperationV2BindingTerminalCas,
  CHAT_OPERATION_V2_BINDING_RELEASE_REASONS,
  CHAT_OPERATION_V2_BINDING_STATUSES,
  normalizeChatOperationV2TargetCoordinate,
  projectChatOperationV2BindingInventory,
  type ChatOperationV2BindingPublishedRecord,
  type ChatOperationV2BindingRecord,
  type ChatOperationV2BindingReleasedRecord,
  type ChatOperationV2BindingReservedRecord,
  type ChatOperationV2BindingTerminalTransaction,
  type ChatOperationV2BindingCommitTerminalTransaction,
  type ChatOperationV2BindingFallbackReservationTransaction,
  validateChatOperationV2BindingRecord,
  validateChatOperationV2BindingRegistry,
  validateChatOperationV2BindingTerminalTransaction,
  validateChatOperationV2BindingCommitTerminalTransaction,
  validateChatOperationV2BindingFallbackReservationTransaction,
  validateChatOperationV2BindingTransition,
} from '../server/chat-operations/binding.js';

const reservedTarget = normalizeChatOperationV2TargetCoordinate(
  'pipelines/New Pipeline/pipeline.yaml',
  'win32',
);
const forkTarget = normalizeChatOperationV2TargetCoordinate(
  'pipelines/New Pipeline Copy/pipeline.yaml',
  'win32',
);

function reserved(
  overrides: Partial<ChatOperationV2BindingReservedRecord> = {},
): ChatOperationV2BindingReservedRecord {
  return {
    schemaVersion: 1,
    status: 'reserved',
    bindingId: 'binding-1',
    workspaceScopeId: 'scope-1',
    version: 1,
    target: reservedTarget,
    operationId: 'operation-1',
    reservedAtMs: 100,
    ...overrides,
  };
}

function published(
  overrides: Partial<ChatOperationV2BindingPublishedRecord> = {},
): ChatOperationV2BindingPublishedRecord {
  return {
    schemaVersion: 1,
    status: 'published',
    bindingId: 'binding-1',
    workspaceScopeId: 'scope-1',
    version: 2,
    target: reservedTarget,
    ownerSessionId: 'session-1',
    publishedByOperationId: 'operation-1',
    resultId: 'result-1',
    publishedAtMs: 200,
    ...overrides,
  };
}

function released(
  overrides: Partial<ChatOperationV2BindingReleasedRecord> = {},
): ChatOperationV2BindingReleasedRecord {
  return {
    schemaVersion: 1,
    status: 'released',
    bindingId: 'binding-1',
    workspaceScopeId: 'scope-1',
    version: 2,
    target: reservedTarget,
    releasedFrom: 'reserved',
    releaseReason: 'completed_noop',
    releasedByOperationId: 'operation-1',
    previousOwnerSessionId: null,
    releasedAtMs: 200,
    ...overrides,
  };
}

function transitionCodes(previous: unknown, next: unknown, intent: unknown): string[] {
  return validateChatOperationV2BindingTransition(previous, next, intent).violations.map(
    ({ code }) => code,
  );
}

const publishIntent = {
  kind: 'publish',
  operationId: 'operation-1',
  ownerSessionId: 'session-1',
  resultId: 'result-1',
  commitStatus: 'completed',
  terminalOutcome: 'completed_published',
} as const;

const forkIntent = {
  kind: 'fork',
  operationId: 'operation-1',
  ownerSessionId: 'session-1',
  resultId: 'result-1',
  commitStatus: 'completed',
  terminalOutcome: 'completed_forked',
} as const;

describe('ChatTurn Operation V2 target coordinates', () => {
  test('normalizes separators while keeping a display coordinate and platform identity', () => {
    const windows = normalizeChatOperationV2TargetCoordinate(
      'Pipelines\\Alpha//./pipeline.yaml',
      'win32',
    );
    const windowsAlias = normalizeChatOperationV2TargetCoordinate(
      'pipelines/alpha/pipeline.yaml',
      'win32',
    );
    const posixUpper = normalizeChatOperationV2TargetCoordinate(
      'Pipelines/Alpha/pipeline.yaml',
      'posix',
    );
    const posixLower = normalizeChatOperationV2TargetCoordinate(
      'pipelines/alpha/pipeline.yaml',
      'posix',
    );

    expect(windows).toEqual({
      platform: 'win32',
      coordinate: 'Pipelines/Alpha/pipeline.yaml',
      identity: 'pipelines/alpha/pipeline.yaml',
    });
    expect(windowsAlias.identity).toBe(windows.identity);
    expect(posixUpper.identity).toBe('Pipelines/Alpha/pipeline.yaml');
    expect(posixLower.identity).not.toBe(posixUpper.identity);
  });

  test('rejects traversal, absolute, drive-relative, empty, and null-byte coordinates', () => {
    for (const invalid of [
      '',
      '.',
      '../pipeline.yaml',
      'pipelines/../pipeline.yaml',
      'pipelines\\..\\pipeline.yaml',
      '/pipelines/pipeline.yaml',
      '\\pipelines\\pipeline.yaml',
      '\\\\server\\share\\pipeline.yaml',
      'C:\\pipelines\\pipeline.yaml',
      'C:pipeline.yaml',
      'pipelines/\0pipeline.yaml',
      'pipelines/line\nbreak/pipeline.yaml',
    ]) {
      expect(() => normalizeChatOperationV2TargetCoordinate(invalid, 'win32')).toThrow(
        /target coordinate/i,
      );
      expect(() => normalizeChatOperationV2TargetCoordinate(invalid, 'posix')).toThrow(
        /target coordinate/i,
      );
    }
  });
});

describe('ChatTurn Operation V2 binding records', () => {
  test('exposes only the approved strict lifecycle vocabulary', () => {
    expect(CHAT_OPERATION_V2_BINDING_STATUSES).toEqual(['reserved', 'published', 'released']);
    expect(CHAT_OPERATION_V2_BINDING_RELEASE_REASONS).toEqual([
      'completed_noop',
      'cancelled_precommit',
      'discarded',
      'expired',
      'failed_terminal',
      'unused_fallback',
      'fallback_selected',
      'session_deleted',
    ]);
    expect(validateChatOperationV2BindingRecord(reserved())).toMatchObject({ valid: true });
    expect(validateChatOperationV2BindingRecord(published())).toMatchObject({ valid: true });
    expect(validateChatOperationV2BindingRecord(released())).toMatchObject({ valid: true });
  });

  test('keeps a reservation operation-owned and out of session-owned inventory', () => {
    const contaminated = {
      ...reserved(),
      ownerSessionId: 'session-1',
    };
    expect(
      validateChatOperationV2BindingRecord(contaminated).violations.map(({ code }) => code),
    ).toContain('invalid_record_shape');

    const projection = projectChatOperationV2BindingInventory({
      registryAuthentication: 'trusted',
      records: [reserved()],
      inventory: [
        {
          workspaceScopeId: 'scope-1',
          platform: 'win32',
          targetCoordinate: 'pipelines/New Pipeline/pipeline.yaml',
        },
      ],
    });
    expect(projection.entries[0]).toMatchObject({
      ownership: 'unowned',
      bindingId: null,
      ownerSessionId: null,
    });
  });

  test('rejects noncanonical targets, unknown fields, and inconsistent release ownership', () => {
    const hiddenSessionOwner = { ...reserved() };
    Object.defineProperty(hiddenSessionOwner, 'ownerSessionId', {
      value: 'session-1',
      enumerable: false,
    });
    const accessorOperation = { ...reserved() };
    Object.defineProperty(accessorOperation, 'operationId', {
      enumerable: true,
      get() {
        throw new Error('must not invoke record accessors');
      },
    });
    const invalidRecords: unknown[] = [
      { ...reserved(), unexpected: true },
      hiddenSessionOwner,
      accessorOperation,
      { ...reserved(), target: { ...reservedTarget, coordinate: 'pipelines//pipeline.yaml' } },
      { ...released(), previousOwnerSessionId: 'session-1' },
      {
        ...released(),
        releasedFrom: 'published',
        releaseReason: 'session_deleted',
        releasedByOperationId: 'operation-1',
        previousOwnerSessionId: 'session-1',
      },
    ];
    for (const record of invalidRecords) {
      expect(validateChatOperationV2BindingRecord(record).valid).toBe(false);
    }
  });
});

describe('ChatTurn Operation V2 binding transitions', () => {
  test('allows reserve, commit-complete publish, republish, and conflict fork transitions', () => {
    expect(
      validateChatOperationV2BindingTransition(null, reserved(), {
        kind: 'reserve',
        operationId: 'operation-1',
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateChatOperationV2BindingTransition(reserved(), published(), publishIntent),
    ).toMatchObject({ valid: true });
    expect(
      validateChatOperationV2BindingTransition(
        reserved(),
        published({
          target: normalizeChatOperationV2TargetCoordinate(
            'PIPELINES/NEW PIPELINE/pipeline.yaml',
            'win32',
          ),
        }),
        publishIntent,
      ),
    ).toMatchObject({ valid: true });

    const existing = published();
    const republished = published({
      version: 3,
      publishedByOperationId: 'operation-2',
      resultId: 'result-2',
      publishedAtMs: 300,
    });
    expect(
      validateChatOperationV2BindingTransition(existing, republished, {
        ...publishIntent,
        operationId: 'operation-2',
        resultId: 'result-2',
      }),
    ).toMatchObject({ valid: true });

    expect(
      validateChatOperationV2BindingTransition(
        reserved(),
        published({ target: forkTarget }),
        forkIntent,
      ),
    ).toMatchObject({ valid: true });
    expect(
      validateChatOperationV2BindingTransition(
        existing,
        published({
          version: 3,
          target: forkTarget,
          publishedByOperationId: 'operation-2',
          resultId: 'result-2',
          publishedAtMs: 300,
        }),
        {
          ...forkIntent,
          operationId: 'operation-2',
          resultId: 'result-2',
        },
      ),
    ).toMatchObject({ valid: true });
  });

  test('publishes only after commit completion and never changes authority accidentally', () => {
    expect(
      transitionCodes(reserved(), published(), {
        ...publishIntent,
        commitStatus: 'decided',
      }),
    ).toContain('commit_not_completed');
    expect(
      transitionCodes(reserved(), published(), {
        ...publishIntent,
        operationId: 'operation-other',
      }),
    ).toContain('operation_identity_mismatch');
    expect(transitionCodes(reserved(), published({ target: forkTarget }), publishIntent)).toContain(
      'target_change_forbidden',
    );
    expect(
      transitionCodes(published(), published({ version: 3, ownerSessionId: 'session-other' }), {
        ...publishIntent,
        operationId: 'operation-2',
        resultId: 'result-2',
        ownerSessionId: 'session-other',
      }),
    ).toContain('session_identity_mismatch');
    expect(
      transitionCodes(reserved(), published(), {
        ...forkIntent,
      }),
    ).toContain('fork_target_required');

    const posixUpper = normalizeChatOperationV2TargetCoordinate(
      'Pipelines/Alpha/pipeline.yaml',
      'posix',
    );
    const posixLower = normalizeChatOperationV2TargetCoordinate(
      'pipelines/alpha/pipeline.yaml',
      'posix',
    );
    expect(
      transitionCodes(
        reserved({ target: posixUpper }),
        published({ target: posixLower }),
        publishIntent,
      ),
    ).toContain('target_change_forbidden');
  });

  test('releases every supported non-publishing terminal reservation outcome', () => {
    const cases = [
      ['completed_noop', 'completed_noop'],
      ['cancelled_precommit', 'cancelled_precommit'],
      ['discarded', 'discarded'],
      ['expired', 'expired'],
      ['failed_terminal', 'failed_terminal'],
    ] as const;
    for (const [terminalOutcome, releaseReason] of cases) {
      const next = released({ releaseReason });
      expect(
        validateChatOperationV2BindingTransition(reserved(), next, {
          kind: 'release_reservation',
          operationId: 'operation-1',
          terminalOutcome,
        }),
      ).toMatchObject({ valid: true });
    }

    expect(
      transitionCodes(reserved(), released({ releaseReason: 'discarded' }), {
        kind: 'release_reservation',
        operationId: 'operation-1',
        terminalOutcome: 'completed_noop',
      }),
    ).toContain('release_reason_mismatch');

    for (const releaseReason of ['unused_fallback', 'fallback_selected'] as const) {
      expect(validateChatOperationV2BindingRecord(released({ releaseReason })).valid).toBe(true);
      expect(
        transitionCodes(reserved(), released({ releaseReason }), {
          kind: 'release_reservation',
          operationId: 'operation-1',
          terminalOutcome: 'discarded',
        }),
      ).toContain('release_reason_mismatch');
    }
  });

  test('does not mutate an existing published binding for a no-op', () => {
    const current = published();
    expect(
      validateChatOperationV2BindingTransition(
        current,
        { ...current },
        {
          kind: 'reuse_published_noop',
          operationId: 'operation-2',
          ownerSessionId: 'session-1',
          terminalOutcome: 'completed_noop',
        },
      ),
    ).toMatchObject({ valid: true });
    expect(
      transitionCodes(
        current,
        { ...current, version: 3 },
        {
          kind: 'reuse_published_noop',
          operationId: 'operation-2',
          ownerSessionId: 'session-1',
          terminalOutcome: 'completed_noop',
        },
      ),
    ).toContain('published_noop_mutated');
    expect(
      transitionCodes(
        current,
        released({
          version: 3,
          releasedFrom: 'published',
          releaseReason: 'session_deleted',
          releasedByOperationId: null,
          previousOwnerSessionId: 'session-1',
        }),
        {
          kind: 'reuse_published_noop',
          operationId: 'operation-2',
          ownerSessionId: 'session-1',
          terminalOutcome: 'completed_noop',
        },
      ),
    ).toContain('published_noop_mutated');
  });

  test('treats released as terminal and rejects unsupported lifecycle shortcuts', () => {
    expect(transitionCodes(released(), published({ version: 3 }), publishIntent)).toContain(
      'released_transition_forbidden',
    );
    expect(
      transitionCodes(
        reserved(),
        released({
          releasedFrom: 'published',
          releaseReason: 'session_deleted',
          releasedByOperationId: null,
          previousOwnerSessionId: 'session-1',
        }),
        {
          kind: 'session_deleted',
          ownerSessionId: 'session-1',
        },
      ),
    ).toContain('invalid_lifecycle_transition');
  });
});

describe('ChatTurn Operation V2 binding CAS and target uniqueness', () => {
  test('is first-wins for the same expected binding version', () => {
    const initial = [reserved()] satisfies ChatOperationV2BindingRecord[];
    const first = applyChatOperationV2BindingCas(initial, {
      bindingId: 'binding-1',
      expectedVersion: 1,
      next: published(),
      intent: publishIntent,
    });
    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') throw new Error('expected first CAS to apply');

    const second = applyChatOperationV2BindingCas(first.records, {
      bindingId: 'binding-1',
      expectedVersion: 1,
      next: published(),
      intent: publishIntent,
    });
    expect(second).toMatchObject({
      kind: 'conflict',
      reason: 'version_mismatch',
      currentVersion: 2,
    });
    expect(second.records).toBe(first.records);
  });

  test('enforces one active writable target per scope using platform identity', () => {
    const first = reserved();
    const windowsAlias = reserved({
      bindingId: 'binding-2',
      operationId: 'operation-2',
      target: normalizeChatOperationV2TargetCoordinate(
        'PIPELINES\\NEW PIPELINE\\pipeline.yaml',
        'win32',
      ),
    });
    const sameTarget = applyChatOperationV2BindingCas([first], {
      bindingId: 'binding-2',
      expectedVersion: null,
      next: windowsAlias,
      intent: { kind: 'reserve', operationId: 'operation-2' },
    });
    expect(sameTarget.kind).toBe('rejected');
    if (sameTarget.kind === 'rejected') {
      expect(sameTarget.violations.map(({ code }) => code)).toContain('duplicate_active_target');
    }

    const otherScope = { ...windowsAlias, workspaceScopeId: 'scope-2' };
    expect(
      applyChatOperationV2BindingCas([first], {
        bindingId: 'binding-2',
        expectedVersion: null,
        next: otherScope,
        intent: { kind: 'reserve', operationId: 'operation-2' },
      }).kind,
    ).toBe('applied');

    const posixUpper = reserved({
      target: normalizeChatOperationV2TargetCoordinate('Pipelines/Alpha/pipeline.yaml', 'posix'),
    });
    const posixLower = reserved({
      bindingId: 'binding-2',
      operationId: 'operation-2',
      target: normalizeChatOperationV2TargetCoordinate('pipelines/alpha/pipeline.yaml', 'posix'),
    });
    expect(validateChatOperationV2BindingRegistry([posixUpper, posixLower])).toMatchObject({
      valid: true,
    });
  });

  test('releases a new no-op reservation but leaves a reused published binding byte-for-byte equal', () => {
    const newNoop = applyChatOperationV2BindingCas([reserved()], {
      bindingId: 'binding-1',
      expectedVersion: 1,
      next: released(),
      intent: {
        kind: 'release_reservation',
        operationId: 'operation-1',
        terminalOutcome: 'completed_noop',
      },
    });
    expect(newNoop.kind).toBe('applied');
    if (newNoop.kind !== 'applied') throw new Error('expected release CAS to apply');
    expect(newNoop.record).toMatchObject({ status: 'released', releaseReason: 'completed_noop' });

    const existing = published();
    const reusedNoop = applyChatOperationV2BindingCas([existing], {
      bindingId: 'binding-1',
      expectedVersion: 2,
      next: { ...existing },
      intent: {
        kind: 'reuse_published_noop',
        operationId: 'operation-2',
        ownerSessionId: 'session-1',
        terminalOutcome: 'completed_noop',
      },
    });
    expect(reusedNoop).toMatchObject({ kind: 'noop', record: existing });
    expect(reusedNoop.records).toEqual([existing]);
  });
});

describe('ChatTurn Operation V2 terminal binding transaction', () => {
  test('validates operation, result, binding, commit, and fork target identity as one unit', () => {
    const next = published({ target: forkTarget });
    const transaction: ChatOperationV2BindingTerminalTransaction = {
      operation: {
        operationId: 'operation-1',
        sessionId: 'session-1',
        bindingId: 'binding-1',
        resultId: 'result-1',
        terminalOutcome: 'completed_forked',
      },
      result: {
        resultId: 'result-1',
        operationId: 'operation-1',
        sessionId: 'session-1',
        bindingId: 'binding-1',
        disposition: 'forked',
        target: forkTarget,
      },
      binding: {
        expectedVersion: 1,
        previous: reserved(),
        next,
        intent: forkIntent,
      },
    };

    expect(validateChatOperationV2BindingTerminalTransaction(transaction)).toMatchObject({
      valid: true,
    });
    expect(
      validateChatOperationV2BindingTerminalTransaction({
        ...transaction,
        result: {
          ...transaction.result!,
          target: normalizeChatOperationV2TargetCoordinate(
            'PIPELINES/NEW PIPELINE COPY/pipeline.yaml',
            'win32',
          ),
        },
      }),
    ).toMatchObject({ valid: true });
    expect(applyChatOperationV2BindingTerminalCas([reserved()], transaction)).toMatchObject({
      kind: 'applied',
      record: next,
    });
    expect(
      applyChatOperationV2BindingTerminalCas([reserved({ reservedAtMs: 101 })], transaction),
    ).toMatchObject({
      kind: 'conflict',
      reason: 'record_mismatch',
    });

    const wrongResultTarget = {
      ...transaction,
      result: { ...transaction.result!, target: reservedTarget },
    };
    expect(
      validateChatOperationV2BindingTerminalTransaction(wrongResultTarget).violations.map(
        ({ code }) => code,
      ),
    ).toContain('transaction_target_mismatch');

    const wrongBinding = {
      ...transaction,
      operation: { ...transaction.operation, bindingId: 'binding-other' },
    };
    expect(
      validateChatOperationV2BindingTerminalTransaction(wrongBinding).violations.map(
        ({ code }) => code,
      ),
    ).toContain('transaction_identity_mismatch');
  });

  test('requires no result for all non-publishing terminal binding outcomes', () => {
    for (const terminalOutcome of [
      'completed_noop',
      'cancelled_precommit',
      'discarded',
      'expired',
      'failed_terminal',
    ] as const) {
      const transaction: ChatOperationV2BindingTerminalTransaction = {
        operation: {
          operationId: 'operation-1',
          sessionId: 'session-1',
          bindingId: 'binding-1',
          resultId: null,
          terminalOutcome,
        },
        result: null,
        binding: {
          expectedVersion: 1,
          previous: reserved(),
          next: released({ releaseReason: terminalOutcome }),
          intent: {
            kind: 'release_reservation',
            operationId: 'operation-1',
            terminalOutcome,
          },
        },
      };
      expect(validateChatOperationV2BindingTerminalTransaction(transaction)).toMatchObject({
        valid: true,
      });
      expect(
        validateChatOperationV2BindingTerminalTransaction({
          ...transaction,
          operation: { ...transaction.operation, resultId: 'result-1' },
        }).violations.map(({ code }) => code),
      ).toContain('transaction_result_mismatch');
    }
  });
});

function fallbackReserved(
  overrides: Partial<ChatOperationV2BindingReservedRecord> = {},
): ChatOperationV2BindingReservedRecord {
  return reserved({
    bindingId: 'binding-fallback',
    target: forkTarget,
    reservedAtMs: 110,
    ...overrides,
  });
}

function releasedFallback(
  reason: 'unused_fallback' | 'fallback_selected',
  overrides: Partial<ChatOperationV2BindingReleasedRecord> = {},
): ChatOperationV2BindingReleasedRecord {
  return released({
    bindingId: 'binding-fallback',
    target: forkTarget,
    releaseReason: reason,
    releasedAtMs: 220,
    ...overrides,
  });
}

function primaryCommitTransaction(
  fallback: ChatOperationV2BindingCommitTerminalTransaction['fallback'] = {
    expectedVersion: 1,
    previous: fallbackReserved(),
    next: releasedFallback('unused_fallback'),
  },
): ChatOperationV2BindingCommitTerminalTransaction {
  return {
    operation: {
      operationId: 'operation-1',
      sessionId: 'session-1',
      primaryBindingId: 'binding-1',
      fallbackBindingId: fallback?.previous.bindingId ?? null,
      resultId: 'result-1',
      terminalOutcome: 'completed_published',
    },
    result: {
      resultId: 'result-1',
      operationId: 'operation-1',
      sessionId: 'session-1',
      bindingId: 'binding-1',
      disposition: 'published',
      target: reservedTarget,
    },
    primary: {
      expectedVersion: 1,
      previous: reserved(),
      next: published(),
    },
    fallback,
  };
}

function fallbackCommitTransaction(): ChatOperationV2BindingCommitTerminalTransaction {
  return {
    operation: {
      operationId: 'operation-1',
      sessionId: 'session-1',
      primaryBindingId: 'binding-1',
      fallbackBindingId: 'binding-fallback',
      resultId: 'result-1',
      terminalOutcome: 'completed_forked',
    },
    result: {
      resultId: 'result-1',
      operationId: 'operation-1',
      sessionId: 'session-1',
      bindingId: 'binding-fallback',
      disposition: 'forked',
      target: forkTarget,
    },
    primary: {
      expectedVersion: 1,
      previous: reserved(),
      next: released({ releaseReason: 'fallback_selected', releasedAtMs: 220 }),
    },
    fallback: {
      expectedVersion: 1,
      previous: fallbackReserved(),
      next: published({
        bindingId: 'binding-fallback',
        target: forkTarget,
        publishedAtMs: 220,
      }),
    },
  };
}

function dualReleaseTransaction(
  terminalOutcome:
    'completed_noop' | 'cancelled_precommit' | 'discarded' | 'expired' | 'failed_terminal',
): ChatOperationV2BindingCommitTerminalTransaction {
  return {
    operation: {
      operationId: 'operation-1',
      sessionId: 'session-1',
      primaryBindingId: 'binding-1',
      fallbackBindingId: 'binding-fallback',
      resultId: null,
      terminalOutcome,
    },
    result: null,
    primary: {
      expectedVersion: 1,
      previous: reserved(),
      next: released({ releaseReason: terminalOutcome, releasedAtMs: 220 }),
    },
    fallback: {
      expectedVersion: 1,
      previous: fallbackReserved(),
      next: released({
        bindingId: 'binding-fallback',
        target: forkTarget,
        releaseReason: terminalOutcome,
        releasedAtMs: 220,
      }),
    },
  };
}

describe('ChatTurn Operation V2 commit fallback lease reservation', () => {
  test('atomically reserves a distinct fallback while leaving the primary byte-for-byte unchanged', () => {
    const primary = reserved();
    const transaction: ChatOperationV2BindingFallbackReservationTransaction = {
      operationId: 'operation-1',
      primary: { expectedVersion: 1, previous: primary },
      fallback: { expectedVersion: null, next: fallbackReserved() },
    };
    expect(validateChatOperationV2BindingFallbackReservationTransaction(transaction)).toMatchObject(
      { valid: true },
    );
    const result = applyChatOperationV2BindingFallbackReservationCas([primary], transaction);
    expect(result).toMatchObject({
      kind: 'applied',
      primary,
      fallback: fallbackReserved(),
      records: [primary, fallbackReserved()],
      pipelineMutation: 'none',
    });
    expect(result.records[0]).toBe(primary);
  });

  test('rejects primary drift, reused fallback ids, and duplicate fallback targets without partial state', () => {
    const primary = reserved();
    const base: ChatOperationV2BindingFallbackReservationTransaction = {
      operationId: 'operation-1',
      primary: { expectedVersion: 1, previous: primary },
      fallback: { expectedVersion: null, next: fallbackReserved() },
    };
    const drift = applyChatOperationV2BindingFallbackReservationCas(
      [reserved({ reservedAtMs: 99 })],
      base,
    );
    expect(drift).toMatchObject({ kind: 'conflict', reason: 'primary_record_mismatch' });
    expect(drift.records).toHaveLength(1);

    for (const next of [
      fallbackReserved({ bindingId: 'binding-1' }),
      fallbackReserved({ target: reservedTarget }),
    ]) {
      const rejected = applyChatOperationV2BindingFallbackReservationCas([primary], {
        ...base,
        fallback: { expectedVersion: null, next },
      });
      expect(rejected.kind).toBe('rejected');
      expect(rejected.records).toEqual([primary]);
    }
  });

  test('fails closed for an existing fallback, an unrelated target claim, or a non-data transaction field', () => {
    const primary = reserved();
    const fallback = fallbackReserved();
    const transaction: ChatOperationV2BindingFallbackReservationTransaction = {
      operationId: 'operation-1',
      primary: { expectedVersion: 1, previous: primary },
      fallback: { expectedVersion: null, next: fallback },
    };
    expect(
      applyChatOperationV2BindingFallbackReservationCas([primary, fallback], transaction),
    ).toMatchObject({ kind: 'conflict', reason: 'fallback_already_exists' });

    const unrelated = reserved({
      bindingId: 'binding-unrelated',
      operationId: 'operation-unrelated',
      target: forkTarget,
    });
    const duplicateTarget = applyChatOperationV2BindingFallbackReservationCas(
      [primary, unrelated],
      transaction,
    );
    expect(duplicateTarget.kind).toBe('rejected');
    expect(duplicateTarget.records).toEqual([primary, unrelated]);

    let getterRead = false;
    const accessorBacked = Object.defineProperty(
      { operationId: 'operation-1', fallback: transaction.fallback },
      'primary',
      {
        enumerable: true,
        get() {
          getterRead = true;
          return transaction.primary;
        },
      },
    );
    expect(validateChatOperationV2BindingFallbackReservationTransaction(accessorBacked)).toEqual({
      valid: false,
      violations: [expect.objectContaining({ code: 'invalid_fallback_reservation_transaction' })],
    });
    expect(getterRead).toBe(false);
  });
});

describe('ChatTurn Operation V2 atomic commit multi-lease terminal transaction', () => {
  test('publishes primary and releases an unused fallback in one full-registry update', () => {
    const current = [reserved(), fallbackReserved()] as const;
    const transaction = primaryCommitTransaction();
    expect(validateChatOperationV2BindingCommitTerminalTransaction(transaction)).toMatchObject({
      valid: true,
    });
    const result = applyChatOperationV2BindingCommitTerminalCas(current, transaction);
    expect(result).toMatchObject({
      kind: 'applied',
      chosenBinding: published(),
      primary: published(),
      fallback: releasedFallback('unused_fallback'),
      pipelineMutation: 'none',
    });
    expect(result.records).toEqual([published(), releasedFallback('unused_fallback')]);
    expect(current).toEqual([reserved(), fallbackReserved()]);
  });

  test('fork terminal atomically releases primary and publishes the reserved fallback', () => {
    const current = [reserved(), fallbackReserved()] as const;
    const transaction = fallbackCommitTransaction();
    expect(validateChatOperationV2BindingCommitTerminalTransaction(transaction)).toMatchObject({
      valid: true,
    });
    const result = applyChatOperationV2BindingCommitTerminalCas(current, transaction);
    expect(result).toMatchObject({
      kind: 'applied',
      chosenBinding: transaction.fallback!.next,
      primary: transaction.primary.next,
      fallback: transaction.fallback!.next,
    });
    expect(result.records).toEqual([transaction.primary.next, transaction.fallback!.next]);
  });

  test('keeps safe one-lease primary terminal compatibility', () => {
    const transaction = primaryCommitTransaction(null);
    expect(validateChatOperationV2BindingCommitTerminalTransaction(transaction)).toMatchObject({
      valid: true,
    });
    expect(applyChatOperationV2BindingCommitTerminalCas([reserved()], transaction)).toMatchObject({
      kind: 'applied',
      chosenBinding: published(),
      fallback: null,
      records: [published()],
    });
  });

  test('atomically releases both leases when a precommit terminal outcome wins after fallback prepare', () => {
    for (const terminalOutcome of [
      'completed_noop',
      'cancelled_precommit',
      'discarded',
      'expired',
      'failed_terminal',
    ] as const) {
      const transaction = dualReleaseTransaction(terminalOutcome);
      expect(validateChatOperationV2BindingCommitTerminalTransaction(transaction)).toMatchObject({
        valid: true,
      });
      const current = [reserved(), fallbackReserved()] as const;
      const result = applyChatOperationV2BindingCommitTerminalCas(current, transaction);
      expect(result).toMatchObject({
        kind: 'applied',
        chosenBinding: null,
        primary: expect.objectContaining({ status: 'released', releaseReason: terminalOutcome }),
        fallback: expect.objectContaining({ status: 'released', releaseReason: terminalOutcome }),
        records: [transaction.primary.next, transaction.fallback!.next],
        pipelineMutation: 'none',
      });
      expect(current).toEqual([reserved(), fallbackReserved()]);
    }
  });

  test('rejects partial or result-bearing dual release and applies neither lease on fallback CAS loss', () => {
    const transaction = dualReleaseTransaction('cancelled_precommit');
    for (const invalid of [
      {
        ...transaction,
        operation: { ...transaction.operation, resultId: 'result-1' },
      },
      { ...transaction, result: primaryCommitTransaction().result },
      { ...transaction, fallback: null },
      {
        ...transaction,
        fallback: {
          ...transaction.fallback!,
          next: released({
            bindingId: 'binding-fallback',
            target: forkTarget,
            releaseReason: 'discarded',
            releasedAtMs: 220,
          }),
        },
      },
    ]) {
      const rejected = applyChatOperationV2BindingCommitTerminalCas(
        [reserved(), fallbackReserved()],
        invalid as ChatOperationV2BindingCommitTerminalTransaction,
      );
      expect(rejected.kind).toBe('rejected');
      expect(rejected.records).toEqual([reserved(), fallbackReserved()]);
    }

    const conflict = applyChatOperationV2BindingCommitTerminalCas(
      [reserved(), fallbackReserved({ reservedAtMs: 99 })],
      transaction,
    );
    expect(conflict).toMatchObject({
      kind: 'conflict',
      reason: 'fallback_record_mismatch',
      records: [reserved(), fallbackReserved({ reservedAtMs: 99 })],
    });
  });

  test('rejects identity, result, workspace, target, version, and partial-update mismatches', () => {
    const base = fallbackCommitTransaction();
    const invalid = [
      { ...base, operation: { ...base.operation, operationId: 'other' } },
      { ...base, operation: { ...base.operation, sessionId: 'other' } },
      { ...base, operation: { ...base.operation, primaryBindingId: 'other' } },
      { ...base, operation: { ...base.operation, fallbackBindingId: 'other' } },
      { ...base, result: { ...base.result!, resultId: 'other' } },
      { ...base, result: { ...base.result!, operationId: 'other' } },
      { ...base, result: { ...base.result!, sessionId: 'other' } },
      { ...base, result: { ...base.result!, bindingId: 'binding-1' } },
      { ...base, result: { ...base.result!, disposition: 'published' } },
      {
        ...base,
        fallback: {
          ...base.fallback!,
          previous: fallbackReserved({ workspaceScopeId: 'scope-other' }),
        },
      },
      { ...base, result: { ...base.result!, target: reservedTarget } },
      { ...base, primary: { ...base.primary, expectedVersion: 2 } },
      {
        ...base,
        primary: {
          ...base.primary,
          next: released({
            releaseReason: 'unused_fallback',
            releasedAtMs: 220,
          }),
        },
      },
      {
        ...base,
        fallback: {
          ...base.fallback!,
          next: published({
            bindingId: 'binding-fallback',
            target: forkTarget,
            ownerSessionId: 'other',
            publishedAtMs: 220,
          }),
        },
      },
      { ...base, fallback: null },
      {
        ...base,
        primary: { ...base.primary, next: published() },
      },
    ];
    for (const transaction of invalid) {
      const result = applyChatOperationV2BindingCommitTerminalCas(
        [reserved(), fallbackReserved()],
        transaction as ChatOperationV2BindingCommitTerminalTransaction,
      );
      expect(result.kind).toBe('rejected');
      expect(result.records).toEqual([reserved(), fallbackReserved()]);
    }
  });

  test('preserves unrelated registry records and rejects accessor-backed or extra transaction fields', () => {
    const transaction = primaryCommitTransaction();
    const oldReleased = released({
      bindingId: 'binding-old',
      target: normalizeChatOperationV2TargetCoordinate(
        'pipelines/Old Pipeline/pipeline.yaml',
        'win32',
      ),
    });
    const otherActive = published({
      bindingId: 'binding-other',
      workspaceScopeId: 'scope-other',
      target: normalizeChatOperationV2TargetCoordinate(
        'pipelines/Other Pipeline/pipeline.yaml',
        'win32',
      ),
    });
    const current = [oldReleased, reserved(), otherActive, fallbackReserved()] as const;
    const applied = applyChatOperationV2BindingCommitTerminalCas(current, transaction);
    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') throw new Error('terminal transaction must apply');
    expect(applied.records).toEqual([
      oldReleased,
      transaction.primary.next,
      otherActive,
      transaction.fallback!.next,
    ]);
    expect(applied.records[0]).toBe(oldReleased);
    expect(applied.records[2]).toBe(otherActive);

    expect(
      validateChatOperationV2BindingCommitTerminalTransaction({
        ...transaction,
        unexpected: true,
      }).valid,
    ).toBe(false);
    let getterRead = false;
    const accessorBacked = Object.defineProperty(
      { result: transaction.result, primary: transaction.primary, fallback: transaction.fallback },
      'operation',
      {
        enumerable: true,
        get() {
          getterRead = true;
          return transaction.operation;
        },
      },
    );
    expect(validateChatOperationV2BindingCommitTerminalTransaction(accessorBacked).valid).toBe(
      false,
    );
    expect(getterRead).toBe(false);
  });

  test('returns CAS conflicts for either lease without applying the other', () => {
    const transaction = fallbackCommitTransaction();
    for (const [current, reason] of [
      [[fallbackReserved()], 'primary_missing'],
      [[reserved()], 'fallback_missing'],
      [[reserved({ version: 2 }), fallbackReserved()], 'primary_version_mismatch'],
      [[reserved(), fallbackReserved({ version: 2 })], 'fallback_version_mismatch'],
      [[reserved({ reservedAtMs: 99 }), fallbackReserved()], 'primary_record_mismatch'],
      [[reserved(), fallbackReserved({ reservedAtMs: 99 })], 'fallback_record_mismatch'],
    ] as const) {
      const result = applyChatOperationV2BindingCommitTerminalCas(current, transaction);
      expect(result).toMatchObject({ kind: 'conflict', reason });
      expect(result.records).toEqual(current);
    }
  });

  test('property matrix preserves registry validity, versions, chosen identity, and input immutability', () => {
    for (let index = 0; index < 64; index += 1) {
      const primaryTarget = normalizeChatOperationV2TargetCoordinate(
        `pipelines/primary-${index}/pipeline.yaml`,
        index % 2 === 0 ? 'win32' : 'posix',
      );
      const fallbackTarget = normalizeChatOperationV2TargetCoordinate(
        `pipelines/fallback-${index}/pipeline.yaml`,
        index % 2 === 0 ? 'win32' : 'posix',
      );
      const primary = reserved({ target: primaryTarget, reservedAtMs: index });
      const fallback = fallbackReserved({ target: fallbackTarget, reservedAtMs: index + 1 });
      const transaction = fallbackCommitTransaction();
      const specialized: ChatOperationV2BindingCommitTerminalTransaction = {
        ...transaction,
        result: { ...transaction.result!, target: fallbackTarget },
        primary: {
          ...transaction.primary,
          previous: primary,
          next: released({
            target: primaryTarget,
            releaseReason: 'fallback_selected',
            releasedAtMs: index + 2,
          }),
        },
        fallback: {
          ...transaction.fallback!,
          previous: fallback,
          next: published({
            bindingId: fallback.bindingId,
            target: fallbackTarget,
            publishedAtMs: index + 2,
          }),
        },
      };
      const input = [primary, fallback] as const;
      const snapshot = structuredClone(input);
      const result = applyChatOperationV2BindingCommitTerminalCas(input, specialized);
      expect(result.kind).toBe('applied');
      if (result.kind !== 'applied') throw new Error('property transaction must apply');
      expect(validateChatOperationV2BindingRegistry(result.records).valid).toBe(true);
      expect(result.primary.version).toBe(primary.version + 1);
      expect(result.fallback?.version).toBe(fallback.version + 1);
      expect(result.chosenBinding?.bindingId).toBe(fallback.bindingId);
      expect(input).toEqual(snapshot);
    }
  });
});

describe('ChatTurn Operation V2 ownership release and recovery projection', () => {
  test('session deletion releases ownership and explicitly preserves pipeline bytes', () => {
    const current = published();
    const next = released({
      version: 3,
      releasedFrom: 'published',
      releaseReason: 'session_deleted',
      releasedByOperationId: null,
      previousOwnerSessionId: 'session-1',
      releasedAtMs: 300,
      target: normalizeChatOperationV2TargetCoordinate(
        'PIPELINES/NEW PIPELINE/pipeline.yaml',
        'win32',
      ),
    });
    const result = applyChatOperationV2BindingCas([current], {
      bindingId: 'binding-1',
      expectedVersion: 2,
      next,
      intent: { kind: 'session_deleted', ownerSessionId: 'session-1' },
    });
    expect(result).toMatchObject({
      kind: 'applied',
      record: next,
      pipelineMutation: 'none',
    });

    const projection = projectChatOperationV2BindingInventory({
      registryAuthentication: 'trusted',
      records: result.records,
      inventory: [
        {
          workspaceScopeId: 'scope-1',
          platform: 'win32',
          targetCoordinate: 'pipelines/New Pipeline/pipeline.yaml',
        },
      ],
    });
    expect(projection.entries[0]).toMatchObject({ ownership: 'unowned' });
    expect(projection.pathMutations).toEqual([]);
  });

  test('projects authenticated published ownership but never reserved or released ownership', () => {
    const projection = projectChatOperationV2BindingInventory({
      registryAuthentication: 'trusted',
      records: [
        published(),
        reserved({
          bindingId: 'binding-2',
          operationId: 'operation-2',
          target: forkTarget,
        }),
        released({
          bindingId: 'binding-3',
          target: normalizeChatOperationV2TargetCoordinate(
            'pipelines/Released/pipeline.yaml',
            'win32',
          ),
        }),
      ],
      inventory: [
        {
          workspaceScopeId: 'scope-1',
          platform: 'win32',
          targetCoordinate: 'PIPELINES\\NEW PIPELINE\\pipeline.yaml',
        },
        {
          workspaceScopeId: 'scope-1',
          platform: 'win32',
          targetCoordinate: 'pipelines/New Pipeline Copy/pipeline.yaml',
        },
        {
          workspaceScopeId: 'scope-1',
          platform: 'win32',
          targetCoordinate: 'pipelines/Released/pipeline.yaml',
        },
      ],
    });
    expect(projection.trusted).toBe(true);
    expect(projection.entries.map(({ ownership }) => ownership)).toEqual([
      'session_owned',
      'unowned',
      'unowned',
    ]);
    expect(projection.entries[0]).toMatchObject({
      bindingId: 'binding-1',
      ownerSessionId: 'session-1',
    });
  });

  test('fails invalid HMAC or malformed registry recovery closed without mutating path text', () => {
    const authoredCoordinate = 'Pipelines\\Alpha\\pipeline.yaml';
    const inventory = [
      {
        workspaceScopeId: 'scope-1',
        platform: 'win32' as const,
        targetCoordinate: authoredCoordinate,
      },
    ];

    const invalidHmac = projectChatOperationV2BindingInventory({
      registryAuthentication: 'invalid_hmac',
      records: [
        {
          ...published(),
          target: { platform: 'win32', coordinate: '../../escape', identity: '../../escape' },
        },
      ],
      inventory,
    });
    expect(invalidHmac).toMatchObject({ trusted: false, reason: 'invalid_hmac' });
    expect(invalidHmac.entries[0]).toMatchObject({
      targetCoordinate: authoredCoordinate,
      ownership: 'unowned',
      bindingId: null,
      ownerSessionId: null,
    });
    expect(invalidHmac.pathMutations).toEqual([]);

    const invalidRegistry = projectChatOperationV2BindingInventory({
      registryAuthentication: 'trusted',
      records: [{ ...published(), unexpected: true }],
      inventory,
    });
    expect(invalidRegistry).toMatchObject({ trusted: false, reason: 'invalid_registry' });
    expect(invalidRegistry.entries[0]).toMatchObject({ ownership: 'unowned' });
    expect(invalidRegistry.entries[0]?.targetCoordinate).toBe(authoredCoordinate);
    expect(invalidRegistry.pathMutations).toEqual([]);
  });
});
