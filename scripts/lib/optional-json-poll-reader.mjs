import { createHash } from 'node:crypto';

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

// For unsealed, concurrently produced optional metadata only. The caller keeps
// its exact no-follow/scope/private/size/stability read guards. Bound files must
// continue to use their strict digest-bound JSON parser.
export function createOptionalJSONPollReader({ readBytes, now = Date.now, graceMs = 1000 } = {}) {
  if (
    typeof readBytes !== 'function' ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(graceMs) ||
    graceMs <= 0 ||
    graceMs > 1000
  )
    fail('operator_optional_json_poll_configuration_invalid');
  const pending = new Map();
  const timeFor = (prior) => {
    const time = now();
    if (!Number.isSafeInteger(time) || (prior && time < prior.lastObservedAt))
      fail('operator_optional_json_poll_clock_invalid');
    return time;
  };
  return async function optionalJSON(path) {
    const data = await readBytes(path, { optional: true });
    const prior = pending.get(path);
    if (data === null) {
      if (prior) {
        const time = timeFor(prior);
        if (time - prior.firstObservedAt >= graceMs) fail('operator_optional_json_unsettled');
        prior.lastObservedAt = time;
      }
      return null;
    }
    let value;
    try {
      value = JSON.parse(data.toString('utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const time = timeFor(prior);
      const digest = createHash('sha256').update(data).digest('hex');
      const state = prior ?? {
        firstObservedAt: time,
        lastObservedAt: time,
        digest,
        changed: false,
      };
      state.changed ||= state.digest !== digest;
      state.digest = digest;
      state.lastObservedAt = time;
      pending.set(path, state);
      if (time - state.firstObservedAt >= graceMs)
        fail(
          state.changed ? 'operator_optional_json_unsettled' : 'operator_optional_json_malformed',
        );
      // No object, authority, reservation, or typed reply is derived from a
      // partial/invalid document. The normal observer loop performs the poll.
      return null;
    }
    pending.delete(path);
    return value;
  };
}
