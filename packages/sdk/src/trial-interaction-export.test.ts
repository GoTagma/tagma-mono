import { describe, expect, test } from 'bun:test';

import {
  TRIAL_INTERACTION_PROTOCOL_VERSION,
  isTrialInteractionDeclaration,
  type TrialInteractionDeclaration,
} from './index';

describe('@tagma/sdk Trial Interaction Protocol exports', () => {
  test('re-exports the canonical version, declaration type, and runtime guard', () => {
    const declaration = {
      protocolVersion: TRIAL_INTERACTION_PROTOCOL_VERSION,
      interaction: 'none',
      unattended: 'native',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    } satisfies TrialInteractionDeclaration;

    expect(TRIAL_INTERACTION_PROTOCOL_VERSION).toBe(1);
    expect(isTrialInteractionDeclaration(declaration)).toBe(true);
  });
});
