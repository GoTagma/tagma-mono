// Pure ordered teardown. The caller supplies only its already owned cleanup hooks.
// This module never creates, discovers, signals, closes or persists resources itself.
const STEP = /^[a-z][a-z0-9_]{0,79}$/;
const CODE = /^[A-Za-z0-9_]{1,100}$/;
const TYPE = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
function typedFailure(error) {
  let code = 'finalization_step_failed',
    type = 'UnknownError';
  // Even an unusual thrown object cannot interrupt the remaining owned cleanup.
  try {
    const value = error?.code;
    if (typeof value === 'string' && CODE.test(value)) code = value;
  } catch {
    /* bounded fallback */
  }
  try {
    const value = error?.name;
    if (typeof value === 'string' && TYPE.test(value)) type = value;
  } catch {
    /* bounded fallback */
  }
  return { code, type };
}

/** Run each declared owned step once, in order, despite earlier failures.
 * The primary error is retained by identity for the caller, not serialized here.
 * Fault projections contain no message, stack, result, paths or private handles.
 * A fulfilled hook is not proof of paid settlement, owner closure or publication.
 */
export async function finalizeOwnedResources({ steps, primaryError = null } = {}) {
  const count = Array.isArray(steps) ? steps.length : 0;
  const invalid = () => {
    const error = new Error('owned_finalization_steps_invalid');
    error.code = 'owned_finalization_steps_invalid';
    throw error;
  };
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) invalid();
  // Read each caller-supplied field once before validation. Neither a getter nor
  // a later callback may substitute an unchecked name or owned cleanup hook.
  const plan = [];
  for (let i = 0; i < count; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object' || Array.isArray(step)) invalid();
    const name = step.name,
      run = step.run;
    if (typeof name !== 'string' || !STEP.test(name) || typeof run !== 'function') invalid();
    plan.push(Object.freeze({ name, run }));
  }
  if (new Set(plan.map((step) => step.name)).size !== count) invalid();
  const faults = [],
    stepResults = [];
  for (const step of plan) {
    try {
      await step.run();
      stepResults.push(Object.freeze({ step: step.name, status: 'fulfilled' }));
    } catch (error) {
      const failure = Object.freeze({ step: step.name, ...typedFailure(error) });
      faults.push(failure);
      stepResults.push(Object.freeze({ step: step.name, status: 'rejected', failure }));
    }
  }
  return Object.freeze({
    primaryError,
    faults: Object.freeze(faults),
    stepResults: Object.freeze(stepResults),
  });
}
