import { describe, expect, test } from 'bun:test';
import { chatHeaderControlLocks } from '../src/components/chat/ChatPanel';

describe('chat header model selection', () => {
  test('keeps model controls enabled in an idle conversation while another runs', () => {
    const locks = chatHeaderControlLocks({
      ready: true,
      hiddenTurnActive: true,
      sending: false,
      pendingUserText: null,
      queuedMessages: [],
      reconciling: false,
      flushing: false,
      yamlEditLocked: true,
    });

    expect(locks).toEqual({
      modelSelectionBlocked: false,
      providerBlocked: true,
      navigationBlocked: false,
    });
  });

  test('keeps model controls blocked while the visible conversation is active', () => {
    const locks = chatHeaderControlLocks({
      ready: true,
      hiddenTurnActive: false,
      sending: true,
      pendingUserText: 'current prompt',
      queuedMessages: [],
      reconciling: false,
      flushing: false,
      yamlEditLocked: true,
    });

    expect(locks.modelSelectionBlocked).toBe(true);
    expect(locks.providerBlocked).toBe(true);
  });
});
