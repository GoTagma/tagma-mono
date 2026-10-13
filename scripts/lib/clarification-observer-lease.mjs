// Callbacks read saved metadata and write finite choice
// metadata only. The normal ancestor owns live Control validation and replies.
import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const check = (value, code) => {
  if (!value) fail(code);
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function clarificationObservationSlot(observation) {
  const op = observation?.operation,
    pending = observation?.pending;
  check(
    ID.test(op?.operationId ?? '') &&
      Number.isSafeInteger(op?.generation) &&
      op.generation > 0 &&
      ID.test(pending?.clarificationId ?? '') &&
      typeof observation.workspace === 'string',
    'observer_identity_unavailable',
  );
  // Same slot as the public broker: changed text/version never unlocks repost.
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspace: observation.workspace,
        operationId: op.operationId,
        generation: op.generation,
        clarificationId: pending.clarificationId,
      }),
    )
    .digest('hex');
}

export function createClarificationObserverLease({
  runId,
  configSha256,
  sourceSha256,
  caseIds,
  now,
  pollMs = 250,
  observedFreshnessMs = 3000,
  answerWindowMs = 60000,
}) {
  check(
    ID.test(runId ?? '') &&
      SHA.test(configSha256 ?? '') &&
      SHA.test(sourceSha256 ?? '') &&
      Array.isArray(caseIds) &&
      caseIds.length > 0 &&
      caseIds.every((id) => ID.test(id)) &&
      new Set(caseIds).size === caseIds.length &&
      typeof now === 'function',
    'observer_configuration_unavailable',
  );
  check(
    Number.isSafeInteger(pollMs) &&
      pollMs >= 25 &&
      pollMs <= 1000 &&
      observedFreshnessMs === 3000 &&
      answerWindowMs === 60000,
    'observer_time_contract_mismatch',
  );
  const slots = new Map();
  let armProof = null,
    launchProof = null,
    completed = false;
  let writerAttempts = 0,
    metadataWrites = 0,
    tickRunning = false;
  const events = [];
  const event = (kind, value = {}) => {
    const e = freeze({ kind, at: now(), ...value });
    events.push(e);
    return e;
  };

  function arm(proof) {
    check(
      !armProof &&
        !launchProof &&
        proof?.exclusiveLeaseAcquired === true &&
        proof.actualRunRootAbsent === true &&
        proof.runId === runId &&
        proof.configSha256 === configSha256 &&
        proof.sourceSha256 === sourceSha256 &&
        Number.isSafeInteger(proof.armedAt) &&
        now() - proof.armedAt >= 0 &&
        now() - proof.armedAt <= observedFreshnessMs,
      'observer_must_arm_exclusively_before_launch',
    );
    armProof = freeze({ ...proof });
    return event('observer_armed_before_launch', { runId, configSha256, sourceSha256 });
  }
  function observeLaunch(proof) {
    check(
      armProof &&
        !completed &&
        proof?.runId === runId &&
        proof.configSha256 === configSha256 &&
        proof.sourceManifestSha256 === sourceSha256 &&
        Number.isSafeInteger(proof.startedAt) &&
        proof.startedAt >= armProof.armedAt,
      'observer_actual_launch_binding_mismatch',
    );
    if (launchProof)
      check(
        JSON.stringify(launchProof) === JSON.stringify(proof),
        'observer_launch_binding_changed',
      );
    else {
      launchProof = freeze({ ...proof });
      event('observer_launch_observed');
    }
  }
  function complete(proof) {
    check(
      launchProof &&
        proof?.runId === runId &&
        proof.allStartedCasesKnownClosed === true &&
        proof.rootOwnedWrapperNaturallyClosed === true,
      'observer_current_completion_unavailable',
    );
    completed = true;
    return event('observer_completed_current_known_run');
  }
  async function tick({ observeCase, reserveSlot, writeChoice, onUnknown = () => {} }) {
    check(
      armProof &&
        !completed &&
        !tickRunning &&
        typeof observeCase === 'function' &&
        typeof reserveSlot === 'function' &&
        typeof writeChoice === 'function',
      'observer_tick_state_invalid',
    );
    tickRunning = true;
    try {
      if (!launchProof) return { waitingForActualLaunch: true, dispatched: 0 };
      let dispatched = 0;
      for (const caseId of caseIds) {
        const observation = await observeCase(caseId);
        if (!observation) continue;
        check(
          observation.runId === runId &&
            observation.caseId === caseId &&
            observation.configBinding?.sha256 === configSha256 &&
            observation.sourceSHA256 === sourceSha256,
          'observer_saved_scope_mismatch',
        );
        const slot = clarificationObservationSlot(observation);
        let state = slots.get(slot);
        if (!state) {
          state = {
            firstSeenAt: now(),
            status: 'observed',
            attempted: false,
            acknowledgement: 'UNKNOWN_NOT_DERIVED_FROM_METADATA_WRITE',
          };
          slots.set(slot, state);
        }
        const receipt = observation.normalDelegatedReceipts?.find(
          (row) => row.reservationKey === slot,
        );
        if (receipt) {
          state.acknowledgement = ['executed', 'UNKNOWN_HELD'].includes(receipt.status)
            ? receipt.status
            : 'UNKNOWN';
          if (receipt.status === 'executed' || receipt.status === 'UNKNOWN_HELD')
            state.status = 'normal_ancestor_slot_retained';
        }
        if (state.attempted || state.status === 'normal_ancestor_slot_retained') continue;
        const current = now(),
          pending = observation.pending,
          op = observation.operation;
        check(
          SHA.test(pending.questionSHA256 ?? '') &&
            typeof pending.question === 'string' &&
            createHash('sha256').update(pending.question).digest('hex') === pending.questionSHA256,
          'observer_question_digest_mismatch',
        );
        if (
          !Number.isSafeInteger(observation.observedAt) ||
          current < observation.observedAt ||
          current - observation.observedAt > observedFreshnessMs ||
          current - state.firstSeenAt >= answerWindowMs ||
          !Number.isSafeInteger(pending.requestedAt) ||
          !Number.isSafeInteger(pending.expiresAt) ||
          current < pending.requestedAt ||
          current >= pending.expiresAt ||
          op.executionState !== 'waiting_for_user' ||
          op.phase !== 'awaiting_input' ||
          op.waitReason !== 'clarification'
        ) {
          const issue = event('observer_stale_or_closed_question_held', {
            caseId,
            slot,
            acknowledgement: state.acknowledgement,
          });
          await onUnknown(issue);
          continue;
        }
        const choice = observation.resolvedAlreadyAuthorizedChoice;
        if (!choice || !['named_new_pipeline', 'new_pipeline_goal'].includes(choice.replyKind)) {
          const issue = event('observer_unknown_semantic_choice_held', {
            caseId,
            slot,
            questionSHA256: pending.questionSHA256,
          });
          await onUnknown(issue);
          continue;
        }
        // Reserve before awaiting any writer; failed/unknown writes never repost.
        state.attempted = true;
        state.status = 'metadata_write_reserved';
        const reservation = freeze({
          runId,
          caseId,
          slot,
          configSha256,
          sourceSha256,
          observedAt: observation.observedAt,
          questionSHA256: pending.questionSHA256,
          firstSeenAt: state.firstSeenAt,
          reservedAt: current,
          automaticRepost: false,
        });
        try {
          const reserved = await reserveSlot(reservation);
          check(reserved?.created === true, 'observer_exclusive_question_slot_unavailable');
          check(
            now() - observation.observedAt >= 0 &&
              now() - observation.observedAt <= observedFreshnessMs &&
              now() < pending.expiresAt,
            'observer_observation_expired_before_writer',
          );
          ++writerAttempts;
          const result = await writeChoice({
            caseId,
            questionSha256: pending.questionSHA256,
            replyKind: choice.replyKind,
            requestedFilename: choice.requestedFilename ?? null,
            observation,
          });
          check(
            result?.metadataChoicePrepared === true && result.writerTypedPostCount === 0,
            'observer_writer_result_not_metadata_only',
          );
          ++metadataWrites;
          ++dispatched;
          state.status = 'metadata_choice_prepared';
          event('observer_metadata_choice_prepared', {
            caseId,
            slot,
            normalAcknowledgement: state.acknowledgement,
            originalSendAdded: 0,
            manualRetryAdded: 0,
            typedPOSTCount: 0,
            automaticRepost: false,
          });
        } catch (error) {
          state.status = 'metadata_write_failed_or_unknown_held';
          const issue = event('observer_write_failed_or_unknown_no_repost', {
            caseId,
            slot,
            failureCode: error.code ?? 'UNKNOWN',
            acknowledgement: state.acknowledgement,
            automaticRepost: false,
          });
          await onUnknown(issue);
        }
      }
      return { waitingForActualLaunch: false, dispatched };
    } finally {
      tickRunning = false;
    }
  }
  function summary() {
    return freeze({
      runId,
      configSha256,
      sourceSha256,
      pollMs,
      armedBeforeActualLaunch:
        !!armProof && (!launchProof || armProof.armedAt <= launchProof.startedAt),
      armProof,
      launchProof,
      completed,
      writerAttempts,
      metadataWrites,
      originalSendAdded: 0,
      manualRetryAdded: 0,
      directTypedPOSTCount: 0,
      modelProbeCount: 0,
      slots: [...slots].map(([slot, value]) => ({ slot, ...value })),
      events: [...events],
      normalExecutionNeverDerivedFromMetadataWrites: true,
    });
  }
  return Object.freeze({ arm, observeLaunch, tick, complete, summary });
}
