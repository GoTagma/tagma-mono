import { describe, expect, test } from 'bun:test';
import {
  evaluateSlackProbe,
  SLACK_INBOUND_DOWN_HINT,
} from '../server/chat-bridge/transports/slack';

// Regression: a Slack app with Socket Mode DISABLED still has a valid bot
// token, so the old probe() (auth.test() only) reported ok:true and the
// runtime flipped to "connected" while the inbound socket was dead — the
// user saw a green badge but the bot never answered. probe() must gate on
// real inbound (Socket Mode) liveness, not just outbound token validity.
describe('Slack probe honesty', () => {
  test('inbound socket DOWN but bot token valid → NOT ok, actionable hint, no username', () => {
    const r = evaluateSlackProbe(true, false, { kind: 'ok', username: 'demo_app' });
    expect(r.ok).toBe(false);
    expect(r.username).toBeNull();
    expect(r.error).toBe(SLACK_INBOUND_DOWN_HINT);
  });

  test('inbound socket UP + auth ok → ok with username', () => {
    expect(evaluateSlackProbe(true, true, { kind: 'ok', username: 'demo_app' })).toEqual({
      ok: true,
      username: 'demo_app',
    });
  });

  test('transport not started → "not started"', () => {
    expect(evaluateSlackProbe(false, false, null)).toEqual({
      ok: false,
      username: null,
      error: 'not started',
    });
  });

  test('inbound UP but auth call failed → surfaces the auth error verbatim', () => {
    expect(evaluateSlackProbe(true, true, { kind: 'error', message: 'invalid_auth' })).toEqual({
      ok: false,
      username: null,
      error: 'invalid_auth',
    });
  });

  test('the actionable hint names every common response-blocker + the app config', () => {
    expect(SLACK_INBOUND_DOWN_HINT).toContain('Socket Mode');
    expect(SLACK_INBOUND_DOWN_HINT).toContain('Event Subscriptions');
    // Commonly-missed: without the App Home Messages Tab set to allow user
    // messages, Slack hides the DM compose box and the bot can't be messaged.
    expect(SLACK_INBOUND_DOWN_HINT).toContain('Messages Tab');
    expect(SLACK_INBOUND_DOWN_HINT).toContain('message.im');
    expect(SLACK_INBOUND_DOWN_HINT).not.toContain('message.channels');
    expect(SLACK_INBOUND_DOWN_HINT).toContain('api.slack.com/apps');
  });
});
