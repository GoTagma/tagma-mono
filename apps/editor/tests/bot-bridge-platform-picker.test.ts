import { describe, expect, test } from 'bun:test';
import {
  buildBotPlatformPickerState,
  shouldApplyBotBridgeStatusPoll,
  type BotPlatformPickerSnapshot,
} from '../src/components/chat/bot-bridge-status-logic';

const baseSnapshot: BotPlatformPickerSnapshot = {
  status: 'disabled',
  platform: 'telegram',
  platforms: ['telegram', 'discord', 'slack'],
};

describe('bot bridge platform picker state', () => {
  test('shows the pending provider and locks the picker while a switch is running', () => {
    const state = buildBotPlatformPickerState(baseSnapshot, {
      pendingPlatform: 'discord',
      platformBusy: true,
      settlingPlatform: null,
    });

    expect(state.current).toBe('discord');
    expect(state.locked).toBe(true);
    expect(state.busyText).toBe('Switching to Discord...');
    expect(state.lockText).toBeNull();
  });

  test('keeps the disconnect guidance for live bridges when no switch is running', () => {
    const state = buildBotPlatformPickerState(
      { ...baseSnapshot, status: 'connected' },
      { pendingPlatform: null, platformBusy: false, settlingPlatform: null },
    );

    expect(state.current).toBe('telegram');
    expect(state.locked).toBe(true);
    expect(state.busyText).toBeNull();
    expect(state.lockText).toBe('Disconnect to switch provider.');
  });

  test('keeps the picker locked after the platform request resolves until status confirms it', () => {
    const state = buildBotPlatformPickerState(
      { ...baseSnapshot, platform: 'discord' },
      {
        pendingPlatform: null,
        platformBusy: false,
        settlingPlatform: 'discord',
      },
    );

    expect(state.current).toBe('discord');
    expect(state.locked).toBe(true);
    expect(state.busyText).toBe('Switching to Discord...');
    expect(state.lockText).toBeNull();
  });

  test('rejects status poll results that raced with a manual status update', () => {
    expect(
      shouldApplyBotBridgeStatusPoll({
        startedEpoch: 1,
        currentEpoch: 2,
        activeManualUpdates: 0,
      }),
    ).toBe(false);
    expect(
      shouldApplyBotBridgeStatusPoll({
        startedEpoch: 2,
        currentEpoch: 2,
        activeManualUpdates: 1,
      }),
    ).toBe(false);
    expect(
      shouldApplyBotBridgeStatusPoll({
        startedEpoch: 3,
        currentEpoch: 3,
        activeManualUpdates: 0,
      }),
    ).toBe(true);
  });
});
