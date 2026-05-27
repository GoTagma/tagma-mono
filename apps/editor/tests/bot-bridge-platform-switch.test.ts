import { describe, expect, test } from 'bun:test';
import { botPlatformSwitchLocked } from '../server/chat-bridge/platform-switch-lock';

describe('bot bridge platform switch lock', () => {
  test('locks switching while a bridge is running or still starting', () => {
    expect(botPlatformSwitchLocked({ running: false, startInFlight: false })).toBe(false);
    expect(botPlatformSwitchLocked({ running: true, startInFlight: false })).toBe(true);
    expect(botPlatformSwitchLocked({ running: false, startInFlight: true })).toBe(true);
  });
});
