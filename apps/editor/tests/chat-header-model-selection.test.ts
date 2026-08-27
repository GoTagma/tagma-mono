import { describe, expect, test } from 'bun:test';
import { chatHeaderControlLocks } from '../src/components/chat/ChatPanel';

describe('Chat Operation V2 header controls', () => {
  test('keeps model and navigation controls enabled while idle', () => {
    expect(
      chatHeaderControlLocks({
        ready: true,
        sending: false,
        operationActive: false,
        yamlEditLocked: true,
      }),
    ).toEqual({
      modelSelectionBlocked: false,
      providerBlocked: true,
      navigationBlocked: false,
    });
  });

  test('blocks all conversation controls while the visible operation is active', () => {
    expect(
      chatHeaderControlLocks({
        ready: true,
        sending: true,
        operationActive: true,
        yamlEditLocked: false,
      }),
    ).toEqual({
      modelSelectionBlocked: true,
      providerBlocked: true,
      navigationBlocked: true,
    });
  });

  test('keeps controls blocked while a retryable operation awaits an explicit action', () => {
    expect(
      chatHeaderControlLocks({
        ready: true,
        sending: false,
        operationActive: true,
        yamlEditLocked: false,
      }),
    ).toEqual({
      modelSelectionBlocked: true,
      providerBlocked: true,
      navigationBlocked: true,
    });
  });

  test('fails closed before V2 bootstrap is ready', () => {
    expect(
      chatHeaderControlLocks({
        ready: false,
        sending: false,
        operationActive: false,
        yamlEditLocked: false,
      }),
    ).toEqual({
      modelSelectionBlocked: true,
      providerBlocked: true,
      navigationBlocked: true,
    });
  });
});
