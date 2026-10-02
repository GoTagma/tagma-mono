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

  test('allows model recovery and navigation while preserving a retryable draft', () => {
    expect(
      chatHeaderControlLocks({
        ready: true,
        sending: false,
        operationActive: true,
        retryable: true,
        yamlEditLocked: false,
      }),
    ).toEqual({
      modelSelectionBlocked: false,
      providerBlocked: false,
      navigationBlocked: false,
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
