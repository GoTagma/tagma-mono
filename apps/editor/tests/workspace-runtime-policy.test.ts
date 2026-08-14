import { describe, expect, test } from 'bun:test';
import {
  evaluateExecutionPolicy,
  nativeBackendPolicyProfile,
  type BackendPolicyProfile,
} from '../server/execution/policy-engine';

describe('workspace runtime execution policy', () => {
  test('allows only capabilities present in both grants and backend support', () => {
    const decision = evaluateExecutionPolicy({
      requestedCapabilities: ['fs.workspace.read'],
      grants: ['fs.workspace.read', 'fs.workspace.write'],
      minimumEnforcement: [],
      backend: nativeBackendPolicyProfile(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.executionClass).toBe('host');
    expect(decision.grantedCapabilities).toEqual(['fs.workspace.read']);
    expect(decision.deniedCapabilities).toEqual([]);
    expect(decision.enforcement).toEqual([
      {
        capability: 'fs.workspace.read',
        level: 'none',
        enforcedBy: 'host operating-system user permissions only',
      },
    ]);
  });

  test('canonicalizes duplicate requests before evaluating them', () => {
    const decision = evaluateExecutionPolicy({
      requestedCapabilities: [
        'fs.workspace.read',
        'fs.workspace.read',
        'fs.workspace.write',
        'fs.workspace.write',
      ],
      grants: ['fs.workspace.read'],
      minimumEnforcement: [],
      backend: nativeBackendPolicyProfile(),
    });

    expect(decision.requestedCapabilities).toEqual(['fs.workspace.read', 'fs.workspace.write']);
    expect(decision.grantedCapabilities).toEqual(['fs.workspace.read']);
    expect(decision.deniedCapabilities).toEqual(['fs.workspace.write']);
    expect(decision.unsupportedCapabilities).toEqual([]);
    expect(decision.enforcement.map(({ capability }) => capability)).toEqual(['fs.workspace.read']);
  });

  test('classifies an unknown capability as unsupported with or without a grant', () => {
    const withGrant = evaluateExecutionPolicy({
      requestedCapabilities: ['typo.cap'],
      grants: ['typo.cap'],
      minimumEnforcement: [],
      backend: nativeBackendPolicyProfile(),
    });
    const withoutGrant = evaluateExecutionPolicy({
      requestedCapabilities: ['typo.cap'],
      grants: [],
      minimumEnforcement: [],
      backend: nativeBackendPolicyProfile(),
    });

    for (const decision of [withGrant, withoutGrant]) {
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('capability_missing');
      expect(decision.grantedCapabilities).toEqual([]);
      expect(decision.deniedCapabilities).toEqual([]);
      expect(decision.unsupportedCapabilities).toEqual(['typo.cap']);
      expect(decision.enforcement).toEqual([]);
    }
  });

  test('distinguishes a user grant denial from a missing backend capability', () => {
    const profile: BackendPolicyProfile = {
      id: 'limited-backend',
      executionClass: 'isolated-container',
      capabilities: {
        'fs.workspace.read': {
          level: 'os',
          enforcedBy: 'read-only container mount',
        },
      },
    };

    const deniedByGrant = evaluateExecutionPolicy({
      requestedCapabilities: ['fs.workspace.read'],
      grants: [],
      minimumEnforcement: [],
      backend: profile,
    });
    expect(deniedByGrant.allowed).toBe(false);
    expect(deniedByGrant.reason).toBe('policy_denied');
    expect(deniedByGrant.deniedCapabilities).toEqual(['fs.workspace.read']);

    const missingFromBackend = evaluateExecutionPolicy({
      requestedCapabilities: ['net.outbound'],
      grants: ['net.outbound'],
      minimumEnforcement: [],
      backend: profile,
    });
    expect(missingFromBackend.allowed).toBe(false);
    expect(missingFromBackend.reason).toBe('capability_missing');
    expect(missingFromBackend.unsupportedCapabilities).toEqual(['net.outbound']);
  });

  test('fails when the backend cannot meet a minimum enforcement level', () => {
    const decision = evaluateExecutionPolicy({
      requestedCapabilities: ['fs.workspace.write'],
      grants: ['fs.workspace.write'],
      minimumEnforcement: [{ capability: 'fs.workspace.write', level: 'os' }],
      backend: nativeBackendPolicyProfile(),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('capability_missing');
    expect(decision.unmetEnforcement).toEqual([
      {
        capability: 'fs.workspace.write',
        required: 'os',
        available: 'none',
      },
    ]);
  });

  test('never describes the native backend as isolated or sandboxed', () => {
    const profile = nativeBackendPolicyProfile();
    expect(profile.executionClass).toBe('host');
    expect(JSON.stringify(profile).toLowerCase()).not.toContain('sandbox');
    expect(JSON.stringify(profile).toLowerCase()).not.toContain('isolated');
  });
});
