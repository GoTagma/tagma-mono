import { types } from 'node:util';

export type CompileErrorPhase =
  | 'stage_creation'
  | 'stage_compile'
  | 'managed_layout_read'
  | 'managed_layout_parse'
  | 'managed_layout_shape'
  | 'managed_layout_dependency'
  | 'managed_layout_write';

export type CompileErrorObservation = Readonly<{
  phase: CompileErrorPhase;
  /** The current direct prototype class, not the original constructor identity. */
  errorClass: 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'unknown';
  systemCode: string | null;
}>;

const prototypeClasses = new Map<object, CompileErrorObservation['errorClass']>([
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'],
]);
const systemCodes = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EINVAL',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EXDEV',
]);
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isProxy = types.isProxy;
const isNativeError = types.isNativeError;
const observations = new WeakMap<object, CompileErrorObservation>();
const carriedObservations = new WeakMap<object, CompileErrorObservation>();

function safePhase(phase: CompileErrorPhase): CompileErrorPhase {
  switch (phase) {
    case 'stage_creation':
    case 'stage_compile':
    case 'managed_layout_read':
    case 'managed_layout_parse':
    case 'managed_layout_shape':
    case 'managed_layout_dependency':
    case 'managed_layout_write':
      return phase;
    default:
      return 'stage_compile';
  }
}

function observation(
  phase: CompileErrorPhase,
  errorClass: CompileErrorObservation['errorClass'] = 'unknown',
  systemCode: string | null = null,
): CompileErrorObservation {
  const result = Object.freeze({ phase: safePhase(phase), errorClass, systemCode });
  observations.set(result, result);
  return result;
}

/**
 * @internal Trusted dependency injection for native-guard compatibility tests.
 * Never use caller-supplied guards to inspect an untrusted exception.
 */
export function createCompileErrorObserver(guards: {
  readonly isProxy?: (value: unknown) => unknown;
  readonly isNativeError?: (value: unknown) => unknown;
}): (phase: CompileErrorPhase, error?: unknown) => CompileErrorObservation {
  const proxyGuard = guards.isProxy;
  const nativeErrorGuard = guards.isNativeError;
  return (phase, error) => {
    if (typeof error !== 'object' || error === null) return observation(phase);
    try {
      // Reflection can invoke Proxy traps even inside try/catch. Native guards
      // must succeed before any reflection; unavailable guards have no fallback.
      if (
        typeof proxyGuard !== 'function' ||
        typeof nativeErrorGuard !== 'function' ||
        proxyGuard(error) !== false ||
        nativeErrorGuard(error) !== true
      ) {
        return observation(phase);
      }
      const errorClass = prototypeClasses.get(getPrototypeOf(error));
      // A custom or foreign prototype may itself be a Proxy. Compare identity
      // only, and never traverse or inspect the returned prototype.
      if (errorClass === undefined) return observation(phase);
      const code = getOwnPropertyDescriptor(error, 'code');
      const systemCode =
        code && 'value' in code && typeof code.value === 'string' && systemCodes.has(code.value)
          ? code.value
          : null;
      return observation(phase, errorClass, systemCode);
    } catch {
      return observation(phase);
    }
  };
}

export const observeCompileError = createCompileErrorObserver({ isProxy, isNativeError });

function trustedObservation(value: CompileErrorObservation): CompileErrorObservation {
  // WeakMap lookup neither reflects on its key nor invokes Proxy/getter traps.
  return observations.get(value) ?? observation('stage_compile');
}

/** Fixed finite text for the existing compile feedback shape, never exception content. */
export function formatCompileErrorObservation(value: CompileErrorObservation): string {
  const approved = trustedObservation(value);
  return (
    `Compile setup is unavailable. Host phase: ${approved.phase}; ` +
    `error class: ${approved.errorClass}; system code: ${approved.systemCode ?? 'unknown'}.`
  );
}

/** Host-internal carrier. Its descriptor has no readable or enumerable error property. */
export class CompileErrorObservationError extends Error {
  constructor(value: CompileErrorObservation) {
    super('Host-managed new-pipeline layout synchronization failed.');
    carriedObservations.set(this, trustedObservation(value));
  }
}

export function readCompileErrorObservation(error: unknown): CompileErrorObservation | null {
  if (typeof error !== 'object' || error === null) return null;
  try {
    if (typeof isProxy !== 'function' || isProxy(error) !== false) return null;
    return carriedObservations.get(error) ?? null;
  } catch {
    return null;
  }
}
