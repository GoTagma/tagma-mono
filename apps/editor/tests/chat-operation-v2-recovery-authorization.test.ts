import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_LEGACY_RECOVERY_ROUTE_ERRORS,
  ChatOperationV2LegacyRecoveryProtocolError,
  consumeChatOperationV2LegacyRecoveryAuthorization,
  decideChatOperationV2LegacyRecoveryAuthorization,
  parseChatOperationV2LegacyRecoveryAssessment,
  parseChatOperationV2LegacyRecoveryAuthorization,
  parseChatOperationV2LegacyRecoveryRendererMutation,
  validateChatOperationV2LegacyRecoveryAuthorization,
} from '../server/chat-operations/recovery-authorization.js';

const STAGE_DIGEST = 'a'.repeat(64);
const TARGET_HASH = 'b'.repeat(64);
const OTHER_HASH = 'c'.repeat(64);

function recoveryAssessment() {
  return {
    schemaVersion: 1,
    operationId: 'operation-legacy-01',
    generation: 3,
    version: 7,
    sourceProtocol: 'v1',
    legacyStage: true,
    stageAuthenticated: true,
    routeAttestation: 'missing',
    bindingId: null,
    explicitRequestedAction: false,
    stageId: 'stage-legacy-01',
    stageDigest: STAGE_DIGEST,
    observedStageDigest: STAGE_DIGEST,
    stageTargetHash: TARGET_HASH,
    changedTargetHashes: [TARGET_HASH],
  } as const;
}

function rendererMutation() {
  return {
    protocolVersion: 2,
    clientRequestId: 'request-01',
    operationId: 'operation-legacy-01',
    expectedGeneration: 3,
    expectedVersion: 7,
  } as const;
}

function authorizedRecovery() {
  const decision = decideChatOperationV2LegacyRecoveryAuthorization(recoveryAssessment());
  expect(decision.authorized).toBe(true);
  if (!decision.authorized)
    throw new Error('Expected the legacy recovery assessment to authorize.');
  return decision.authorization;
}

function protocolErrorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatOperationV2LegacyRecoveryProtocolError);
    return (error as ChatOperationV2LegacyRecoveryProtocolError).code;
  }
}

describe('ChatTurn Operation V2 legacy recovery authorization', () => {
  test('uses the exact route error taxonomy and authorizes only missing legacy evidence', () => {
    expect(CHAT_OPERATION_V2_LEGACY_RECOVERY_ROUTE_ERRORS).toEqual([
      'legacy_route_evidence_missing',
      'route_mode_conflict',
      'multi_target_mutation',
      'route_target_violation',
      'binding_mismatch',
    ]);

    const decision = decideChatOperationV2LegacyRecoveryAuthorization(recoveryAssessment());
    expect(decision).toMatchObject({
      authorized: true,
      errorType: 'legacy_route_evidence_missing',
      authorization: {
        schemaVersion: 1,
        state: 'legacy_recovery_authorized',
        routeErrorType: 'legacy_route_evidence_missing',
        operationId: 'operation-legacy-01',
        generation: 3,
        issuedAtVersion: 7,
        stageId: 'stage-legacy-01',
        stageDigest: STAGE_DIGEST,
        targetHash: TARGET_HASH,
      },
      evidence: {
        schemaVersion: 1,
        outcome: 'authorized',
        errorType: 'legacy_route_evidence_missing',
        authenticatedV1LegacyStage: true,
        attestationMissing: true,
        bindingPresent: false,
        explicitRequestedActionPresent: false,
        changedTargetCount: 1,
        changedTargetMatchesStage: true,
        stageDigestUnchanged: true,
      },
    });
    expect(Object.isFrozen(decision)).toBe(true);
    if (!decision.authorized) throw new Error('Expected missing legacy evidence to authorize.');
    expect(Object.isFrozen(decision.authorization)).toBe(true);
    expect(Object.isFrozen(decision.evidence)).toBe(true);

    const serializedEvidence = JSON.stringify(decision.evidence);
    expect(serializedEvidence).not.toContain('operation-legacy-01');
    expect(serializedEvidence).not.toContain('stage-legacy-01');
    expect(serializedEvidence).not.toContain(STAGE_DIGEST);
    expect(serializedEvidence).not.toContain(TARGET_HASH);
    expect(serializedEvidence.toLowerCase()).not.toContain('grant');
    expect(serializedEvidence.toLowerCase()).not.toContain('token');
  });

  test('denies every unsafe precondition with its stable route error type', () => {
    const cases = [
      {
        label: 'non-V1 source',
        assessment: { ...recoveryAssessment(), sourceProtocol: 'v2' },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'non-legacy stage',
        assessment: { ...recoveryAssessment(), legacyStage: false },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'unauthenticated stage',
        assessment: { ...recoveryAssessment(), stageAuthenticated: false },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'attestation exists',
        assessment: { ...recoveryAssessment(), routeAttestation: 'present' },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'attestation is invalid rather than absent',
        assessment: { ...recoveryAssessment(), routeAttestation: 'invalid' },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'explicit requested action exists',
        assessment: { ...recoveryAssessment(), explicitRequestedAction: true },
        errorType: 'route_mode_conflict',
      },
      {
        label: 'binding already exists',
        assessment: { ...recoveryAssessment(), bindingId: 'binding-01' },
        errorType: 'binding_mismatch',
      },
      {
        label: 'multiple targets changed',
        assessment: {
          ...recoveryAssessment(),
          changedTargetHashes: [TARGET_HASH, OTHER_HASH],
        },
        errorType: 'multi_target_mutation',
      },
      {
        label: 'no target changed',
        assessment: { ...recoveryAssessment(), changedTargetHashes: [] },
        errorType: 'route_target_violation',
      },
      {
        label: 'a different target changed',
        assessment: { ...recoveryAssessment(), changedTargetHashes: [OTHER_HASH] },
        errorType: 'route_target_violation',
      },
      {
        label: 'stage digest changed',
        assessment: { ...recoveryAssessment(), observedStageDigest: OTHER_HASH },
        errorType: 'route_target_violation',
      },
    ] as const;

    for (const fixture of cases) {
      const decision = decideChatOperationV2LegacyRecoveryAuthorization(fixture.assessment);
      expect(decision.authorized, fixture.label).toBe(false);
      expect(decision.errorType, fixture.label).toBe(fixture.errorType);
      expect(decision.evidence.outcome, fixture.label).toBe('denied');
      expect('authorization' in decision, fixture.label).toBe(false);
    }
  });

  test('strictly parses internal assessments and authorization records', () => {
    const parsed = parseChatOperationV2LegacyRecoveryAssessment(recoveryAssessment());
    expect(parsed).toEqual(recoveryAssessment());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.changedTargetHashes)).toBe(true);

    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAssessment({
          ...recoveryAssessment(),
          targetPath: 'D:\\workspace\\pipeline.yaml',
        }),
      ),
    ).toBe('invalid_keys');
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAssessment({
          ...recoveryAssessment(),
          stageDigest: 'A'.repeat(64),
        }),
      ),
    ).toBe('invalid_hash');
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAssessment({
          ...recoveryAssessment(),
          changedTargetHashes: [TARGET_HASH, TARGET_HASH],
        }),
      ),
    ).toBe('invalid_target_set');

    const sparseTargets = new Array(1) as unknown[] & { padding?: string };
    sparseTargets.padding = TARGET_HASH;
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAssessment({
          ...recoveryAssessment(),
          changedTargetHashes: sparseTargets,
        }),
      ),
    ).toBe('invalid_target_set');
    const accessorTargets = [TARGET_HASH];
    Object.defineProperty(accessorTargets, '0', {
      enumerable: true,
      get: () => TARGET_HASH,
    });
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAssessment({
          ...recoveryAssessment(),
          changedTargetHashes: accessorTargets,
        }),
      ),
    ).toBe('invalid_target_set');

    const accessor = { ...recoveryAssessment() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'bindingId', {
      enumerable: true,
      get: () => null,
    });
    expect(protocolErrorCode(() => parseChatOperationV2LegacyRecoveryAssessment(accessor))).toBe(
      'invalid_shape',
    );
    const withSymbol = { ...recoveryAssessment() } as Record<PropertyKey, unknown>;
    withSymbol[Symbol('hidden-grant')] = true;
    expect(protocolErrorCode(() => parseChatOperationV2LegacyRecoveryAssessment(withSymbol))).toBe(
      'invalid_shape',
    );

    const authorization = authorizedRecovery();
    expect(parseChatOperationV2LegacyRecoveryAuthorization(authorization)).toEqual(authorization);
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAuthorization({
          ...authorization,
          independentRecovery: true,
        }),
      ),
    ).toBe('invalid_keys');
    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryAuthorization({
          ...authorization,
          routeErrorType: 'route_target_violation',
        }),
      ),
    ).toBe('invalid_authorization');
  });

  test('never accepts renderer-supplied recovery authority or bearer-like grants', () => {
    expect(parseChatOperationV2LegacyRecoveryRendererMutation(rendererMutation())).toEqual(
      rendererMutation(),
    );

    for (const forged of [
      { independentRecovery: true },
      { independent_recovery: true },
      { recoveryAuthorization: 'grant-01' },
      { 'Recovery-Authorization': 'grant-01' },
      { legacyRecoveryGrant: 'grant-01' },
      { recoveryToken: 'secret' },
      { bearer: 'secret' },
      { authorization: 'Bearer secret' },
      { metadata: { recoveryAuthorization: 'grant-01' } },
    ]) {
      expect(
        protocolErrorCode(() =>
          parseChatOperationV2LegacyRecoveryRendererMutation({
            ...rendererMutation(),
            ...forged,
          }),
        ),
        JSON.stringify(forged),
      ).toBe('forbidden_renderer_authority');
    }

    expect(
      protocolErrorCode(() =>
        parseChatOperationV2LegacyRecoveryRendererMutation({
          ...rendererMutation(),
          unrelated: true,
        }),
      ),
    ).toBe('invalid_keys');
  });

  test('compile and Trial validate without consuming or changing the authorization', () => {
    const authorization = authorizedRecovery();

    for (const checkpoint of ['compile', 'trial'] as const) {
      const result = validateChatOperationV2LegacyRecoveryAuthorization(authorization, {
        schemaVersion: 1,
        checkpoint,
        operationId: authorization.operationId,
        generation: authorization.generation,
        operationVersion: authorization.issuedAtVersion + 2,
        stageId: authorization.stageId,
        stageDigest: authorization.stageDigest,
        targetHash: authorization.targetHash,
      });
      expect(result).toEqual({ valid: true, authorization });
      expect(result.authorization).toBe(authorization);
      expect(authorization.state).toBe('legacy_recovery_authorized');
      expect(authorization).not.toHaveProperty('consumedAtVersion');
    }
  });

  test('validation fails closed on operation, generation, version, stage, digest, or target drift', () => {
    const authorization = authorizedRecovery();
    const base = {
      schemaVersion: 1,
      checkpoint: 'compile',
      operationId: authorization.operationId,
      generation: authorization.generation,
      operationVersion: authorization.issuedAtVersion,
      stageId: authorization.stageId,
      stageDigest: authorization.stageDigest,
      targetHash: authorization.targetHash,
    } as const;
    const cases = [
      [{ ...base, operationId: 'operation-other' }, 'operation_mismatch'],
      [{ ...base, generation: authorization.generation + 1 }, 'generation_mismatch'],
      [{ ...base, operationVersion: authorization.issuedAtVersion - 1 }, 'version_regressed'],
      [{ ...base, stageId: 'stage-other' }, 'stage_mismatch'],
      [{ ...base, stageDigest: OTHER_HASH }, 'stage_digest_mismatch'],
      [{ ...base, targetHash: OTHER_HASH }, 'target_mismatch'],
    ] as const;

    for (const [request, reason] of cases) {
      expect(validateChatOperationV2LegacyRecoveryAuthorization(authorization, request)).toEqual({
        valid: false,
        reason,
        authorization,
      });
    }
  });

  test('only commit_decided consumes once and advances the operation version under CAS', () => {
    const authorization = authorizedRecovery();
    const request = {
      schemaVersion: 1,
      checkpoint: 'commit_decided',
      operationId: authorization.operationId,
      expectedGeneration: authorization.generation,
      expectedVersion: 12,
      currentGeneration: authorization.generation,
      currentVersion: 12,
      stageId: authorization.stageId,
      stageDigest: authorization.stageDigest,
      targetHash: authorization.targetHash,
    } as const;

    const consumed = consumeChatOperationV2LegacyRecoveryAuthorization(authorization, request);
    expect(consumed).toMatchObject({
      applied: true,
      nextOperationVersion: 13,
      authorization: {
        ...authorization,
        state: 'legacy_recovery_consumed',
        consumedAtVersion: 13,
      },
    });
    if (!consumed.applied) throw new Error('Expected commit_decided to consume authorization.');
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed.authorization)).toBe(true);

    expect(
      consumeChatOperationV2LegacyRecoveryAuthorization(consumed.authorization, {
        ...request,
        expectedVersion: consumed.nextOperationVersion,
        currentVersion: consumed.nextOperationVersion,
      }),
    ).toEqual({
      applied: false,
      reason: 'authorization_consumed',
      authorization: consumed.authorization,
    });
  });

  test('commit consumption rejects CAS loss and bound-authority drift without consuming', () => {
    const authorization = authorizedRecovery();
    const base = {
      schemaVersion: 1,
      checkpoint: 'commit_decided',
      operationId: authorization.operationId,
      expectedGeneration: authorization.generation,
      expectedVersion: 12,
      currentGeneration: authorization.generation,
      currentVersion: 12,
      stageId: authorization.stageId,
      stageDigest: authorization.stageDigest,
      targetHash: authorization.targetHash,
    } as const;

    expect(
      consumeChatOperationV2LegacyRecoveryAuthorization(authorization, {
        ...base,
        expectedVersion: 11,
      }),
    ).toEqual({ applied: false, reason: 'cas_mismatch', authorization });
    expect(
      consumeChatOperationV2LegacyRecoveryAuthorization(authorization, {
        ...base,
        expectedGeneration: authorization.generation - 1,
      }),
    ).toEqual({ applied: false, reason: 'cas_mismatch', authorization });

    const driftCases = [
      [{ ...base, operationId: 'operation-other' }, 'operation_mismatch'],
      [
        {
          ...base,
          expectedGeneration: authorization.generation + 1,
          currentGeneration: authorization.generation + 1,
        },
        'generation_mismatch',
      ],
      [{ ...base, stageId: 'stage-other' }, 'stage_mismatch'],
      [{ ...base, stageDigest: OTHER_HASH }, 'stage_digest_mismatch'],
      [{ ...base, targetHash: OTHER_HASH }, 'target_mismatch'],
    ] as const;
    for (const [request, reason] of driftCases) {
      expect(consumeChatOperationV2LegacyRecoveryAuthorization(authorization, request)).toEqual({
        applied: false,
        reason,
        authorization,
      });
    }
    expect(authorization.state).toBe('legacy_recovery_authorized');
  });

  test('strict checkpoint parsers prevent compile/Trial from being used as consumption requests', () => {
    const authorization = authorizedRecovery();
    const compileLikeConsume = {
      schemaVersion: 1,
      checkpoint: 'compile',
      operationId: authorization.operationId,
      expectedGeneration: authorization.generation,
      expectedVersion: 7,
      currentGeneration: authorization.generation,
      currentVersion: 7,
      stageId: authorization.stageId,
      stageDigest: authorization.stageDigest,
      targetHash: authorization.targetHash,
    };
    expect(
      protocolErrorCode(() =>
        consumeChatOperationV2LegacyRecoveryAuthorization(authorization, compileLikeConsume),
      ),
    ).toBe('invalid_checkpoint');

    expect(
      protocolErrorCode(() =>
        validateChatOperationV2LegacyRecoveryAuthorization(authorization, {
          ...compileLikeConsume,
          checkpoint: 'commit_decided',
          generation: authorization.generation,
          operationVersion: 7,
        }),
      ),
    ).toBe('invalid_checkpoint');
  });
});
