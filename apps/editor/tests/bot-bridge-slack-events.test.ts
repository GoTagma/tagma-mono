import { describe, expect, test } from 'bun:test';
import {
  buildSlackWebClientOptions,
  rememberSlackEventOnce,
  slackMessageChatKind,
  slackMessageEventKey,
} from '../server/chat-bridge/transports/slack';

describe('Slack event normalization', () => {
  test('dedupe key prefers the Events API event_id', () => {
    expect(
      slackMessageEventKey(
        { channel: 'D1', user: 'U1', text: 'hi', ts: '111.000001' },
        { event_id: 'Ev123' },
      ),
    ).toBe('event:Ev123');
  });

  test('dedupe key falls back to channel timestamp for message events', () => {
    expect(
      slackMessageEventKey({ channel: 'D1', user: 'U1', text: 'hi', ts: '111.000001' }, null),
    ).toBe('message:D1:111.000001');
  });

  test('duplicate Slack events are accepted once within the TTL', () => {
    const seen = new Map<string, number>();
    expect(rememberSlackEventOnce(seen, 'event:Ev123', 1_000, 60_000)).toBe(true);
    expect(rememberSlackEventOnce(seen, 'event:Ev123', 2_000, 60_000)).toBe(false);
  });

  test('expired Slack event keys can be accepted again', () => {
    const seen = new Map<string, number>();
    expect(rememberSlackEventOnce(seen, 'event:Ev123', 1_000, 60_000)).toBe(true);
    expect(rememberSlackEventOnce(seen, 'event:Ev123', 62_000, 60_000)).toBe(true);
  });

  test('default dedupe TTL covers Slack delayed event retries for a day', () => {
    const seen = new Map<string, number>();
    expect(rememberSlackEventOnce(seen, 'event:Ev-delayed', 1_000)).toBe(true);
    expect(rememberSlackEventOnce(seen, 'event:Ev-delayed', 23 * 60 * 60_000)).toBe(false);
    expect(rememberSlackEventOnce(seen, 'event:Ev-delayed', 26 * 60 * 60_000)).toBe(true);
  });

  test('Slack Web API calls are bounded instead of using the SDK long-retry default', () => {
    expect(buildSlackWebClientOptions()).toMatchObject({
      timeout: 15_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  });

  test('Slack accepts only direct-message events by default', () => {
    expect(slackMessageChatKind({ channel_type: 'im' })).toBe('private');
    expect(slackMessageChatKind({ channel_type: 'channel' })).toBeNull();
    expect(slackMessageChatKind({ channel_type: 'group' })).toBeNull();
    expect(slackMessageChatKind({ channel_type: 'mpim' })).toBeNull();
  });
});
