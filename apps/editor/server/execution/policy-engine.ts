export type EnforcementLevel = 'none' | 'application' | 'os';

export type ExecutionClass = 'host' | 'isolated-container';

export interface CapabilityEnforcement {
  readonly level: EnforcementLevel;
  readonly enforcedBy: string;
}

export interface BackendPolicyProfile {
  readonly id: string;
  readonly executionClass: ExecutionClass;
  readonly capabilities: Readonly<Record<string, CapabilityEnforcement>>;
}

export interface MinimumEnforcementRequirement {
  readonly capability: string;
  readonly level: EnforcementLevel;
}

export interface CapabilityEnforcementReport extends CapabilityEnforcement {
  readonly capability: string;
}

export interface UnmetEnforcementReport {
  readonly capability: string;
  readonly required: EnforcementLevel;
  readonly available: EnforcementLevel;
}

export type ExecutionPolicyFailureReason = 'policy_denied' | 'capability_missing';

export interface ExecutionPolicyDecision {
  readonly allowed: boolean;
  readonly reason: ExecutionPolicyFailureReason | null;
  readonly executionClass: ExecutionClass;
  readonly requestedCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
  readonly unsupportedCapabilities: readonly string[];
  readonly enforcement: readonly CapabilityEnforcementReport[];
  readonly unmetEnforcement: readonly UnmetEnforcementReport[];
}

export interface EvaluateExecutionPolicyInput {
  readonly requestedCapabilities: readonly string[];
  readonly grants: readonly string[];
  readonly minimumEnforcement: readonly MinimumEnforcementRequirement[];
  readonly backend: BackendPolicyProfile;
}

const HOST_OS_ENFORCEMENT: CapabilityEnforcement = {
  level: 'none',
  enforcedBy: 'host operating-system user permissions only',
};

const ENFORCEMENT_STRENGTH: Readonly<Record<EnforcementLevel, number>> = {
  none: 0,
  application: 1,
  os: 2,
};

/**
 * Native v1 executes directly as the signed-in operating-system user. Its
 * capabilities describe what the host can do, not a sandbox boundary.
 */
export function nativeBackendPolicyProfile(): BackendPolicyProfile {
  return {
    id: 'native',
    executionClass: 'host',
    capabilities: {
      'fs.workspace.read': { ...HOST_OS_ENFORCEMENT },
      'fs.workspace.write': { ...HOST_OS_ENFORCEMENT },
      'net.outbound': { ...HOST_OS_ENFORCEMENT },
      'process.spawn': { ...HOST_OS_ENFORCEMENT },
    },
  };
}

function backendEnforcement(
  backend: BackendPolicyProfile,
  capability: string,
): CapabilityEnforcement | null {
  if (!Object.prototype.hasOwnProperty.call(backend.capabilities, capability)) return null;
  return backend.capabilities[capability] ?? null;
}

export function evaluateExecutionPolicy(
  input: EvaluateExecutionPolicyInput,
): ExecutionPolicyDecision {
  const requestedCapabilities = [...new Set(input.requestedCapabilities)];
  const grants = new Set(input.grants);
  const grantedCapabilities: string[] = [];
  const deniedCapabilities: string[] = [];
  const unsupportedCapabilities: string[] = [];
  const enforcement: CapabilityEnforcementReport[] = [];

  for (const capability of requestedCapabilities) {
    const supportedEnforcement = backendEnforcement(input.backend, capability);
    if (!supportedEnforcement) {
      unsupportedCapabilities.push(capability);
      continue;
    }
    if (!grants.has(capability)) {
      deniedCapabilities.push(capability);
      continue;
    }

    grantedCapabilities.push(capability);
    enforcement.push({
      capability,
      level: supportedEnforcement.level,
      enforcedBy: supportedEnforcement.enforcedBy,
    });
  }

  const unmetEnforcement = input.minimumEnforcement.flatMap<UnmetEnforcementReport>(
    ({ capability, level: required }) => {
      const available = backendEnforcement(input.backend, capability)?.level ?? 'none';
      if (ENFORCEMENT_STRENGTH[available] >= ENFORCEMENT_STRENGTH[required]) return [];
      return [{ capability, required, available }];
    },
  );

  const reason: ExecutionPolicyFailureReason | null =
    unsupportedCapabilities.length > 0 || unmetEnforcement.length > 0
      ? 'capability_missing'
      : deniedCapabilities.length > 0
        ? 'policy_denied'
        : null;

  return {
    allowed: reason === null,
    reason,
    executionClass: input.backend.executionClass,
    requestedCapabilities,
    grantedCapabilities,
    deniedCapabilities,
    unsupportedCapabilities,
    enforcement,
    unmetEnforcement,
  };
}
