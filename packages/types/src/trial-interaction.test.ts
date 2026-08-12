import { describe, expect, test } from 'bun:test';

import {
  TRIAL_INTERACTION_PROTOCOL_VERSION,
  isTrialInteractionDeclaration,
  type TrialInteractionDeclaration,
} from './index.js';

const VALID_DECLARATION = {
  protocolVersion: 1,
  interaction: 'credential',
  unattended: 'host-adapter',
  filesystem: 'workspace-write',
  network: 'write',
  secrets: 'real-required',
  runtime: 'bounded',
} as const satisfies TrialInteractionDeclaration;

describe('Trial Interaction Protocol v1', () => {
  test('recognizes an exact v1 declaration through the public runtime guard', () => {
    expect(TRIAL_INTERACTION_PROTOCOL_VERSION).toBe(1);
    expect(isTrialInteractionDeclaration(VALID_DECLARATION)).toBe(true);
  });

  test('rejects malformed and version-skewed declarations', () => {
    expect(isTrialInteractionDeclaration(undefined)).toBe(false);
    expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, protocolVersion: 2 })).toBe(false);
    expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, interaction: 'tty' })).toBe(false);
    expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, runtime: undefined })).toBe(false);
    expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, futureField: true })).toBe(false);
  });

  test('accepts every protocol v1 enum member', () => {
    for (const interaction of [
      'none',
      'approval',
      'external-event',
      'credential',
      'interactive-stdio',
      'browser-auth',
      'unknown',
    ] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, interaction })).toBe(true);
    }
    for (const unattended of [
      'native',
      'fixture',
      'host-adapter',
      'virtualized',
      'unsupported',
    ] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, unattended })).toBe(true);
    }
    for (const filesystem of [
      'temp-only',
      'workspace-read',
      'workspace-write',
      'external-write',
    ] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, filesystem })).toBe(true);
    }
    for (const network of ['none', 'loopback', 'read', 'write'] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, network })).toBe(true);
    }
    for (const secrets of ['none', 'synthetic-ok', 'real-required'] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, secrets })).toBe(true);
    }
    for (const runtime of ['bounded', 'long-lived'] as const) {
      expect(isTrialInteractionDeclaration({ ...VALID_DECLARATION, runtime })).toBe(true);
    }
  });

  test('returns false instead of throwing for hostile getters and proxy traps', () => {
    const throwingGetter = { ...VALID_DECLARATION };
    Object.defineProperty(throwingGetter, 'interaction', {
      enumerable: true,
      get() {
        throw new Error('hostile interaction getter');
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile ownKeys trap');
        },
      },
    );

    expect(() => isTrialInteractionDeclaration(throwingGetter)).not.toThrow();
    expect(isTrialInteractionDeclaration(throwingGetter)).toBe(false);
    expect(() => isTrialInteractionDeclaration(throwingProxy)).not.toThrow();
    expect(isTrialInteractionDeclaration(throwingProxy)).toBe(false);
  });
});
