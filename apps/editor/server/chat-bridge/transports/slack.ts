/**
 * Slack transport — @slack/socket-mode (inbound) + @slack/web-api (outbound)
 * behind the ChatTransport interface.
 *
 * Socket Mode = an outbound WebSocket; no inbound port, attack surface stays
 * zero like the other transports.
 *
 * Slack needs TWO tokens (unlike Telegram/Discord):
 *   - an app-level token  `xapp-…`  (Socket Mode connection)
 *   - a bot token         `xoxb-…`  (Web API: post/update messages)
 * The ChatTransport.start() signature is single-token, so we accept them
 * combined as  "<xapp-…>|<xoxb-…>"  and split here. A wrong shape throws a
 * precise error rather than failing deep in the SDK.
 *
 * Setup the user does once (Slack app config):
 *   - enable Socket Mode, create an app-level token with connections:write
 *   - add bot scopes: chat:write, im:history; install to workspace, copy the
 *     xoxb token
 *   - subscribe to bot events: message.im
 *
 * NOT live-verified yet — written against the documented @slack SDK APIs and
 * typechecked; first real round-trip happens in the joint test session.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, type WebClientOptions } from '@slack/web-api';
import type {
  ChatKind,
  ChatTransport,
  IncomingCallback,
  IncomingCommand,
  IncomingMessage,
  InlineButton,
  SentMessageRef,
  TransportProbeResult,
} from './types.js';

const START_TIMEOUT_MS = 15_000;

export function buildSlackWebClientOptions(): WebClientOptions {
  return {
    // The bot-loop already has bounded connect/probe semantics. Slack's
    // default WebClient retry policy can keep a failed API call alive for
    // roughly 30 minutes, so keep transport operations bounded here.
    timeout: START_TIMEOUT_MS,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  };
}

function splitTokens(combined: string): { appToken: string; botToken: string } {
  const parts = combined.split('|').map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      'Slack needs two tokens combined as "<xapp-app-level-token>|<xoxb-bot-token>".',
    );
  }
  const [a, b] = parts;
  const appToken = a.startsWith('xapp-') ? a : b;
  const botToken = a.startsWith('xapp-') ? b : a;
  if (!appToken.startsWith('xapp-') || !botToken.startsWith('xoxb-')) {
    throw new Error(
      'Slack token shape wrong: expected one "xapp-…" (app-level) and one "xoxb-…" (bot) token, "|"-separated.',
    );
  }
  return { appToken, botToken };
}

interface SlackMessageEvent {
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  bot_id?: string;
  subtype?: string;
  channel_type?: string;
}

interface SlackEventsApiBody {
  event_id?: string;
}

interface SlackBlockActionsBody {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  trigger_id?: string;
  actions?: Array<{ value?: string; action_id?: string }>;
}

// Slack retries failed event deliveries for minutes by default, and the
// optional Delayed Events setting can retry hourly for 24 h. Keep processed
// event IDs through that window so a lost ack does not duplicate a model turn.
export const SLACK_EVENT_DEDUPE_TTL_MS = 25 * 60 * 60_000;
const SLACK_EVENT_DEDUPE_MAX_KEYS = 5_000;

export function slackMessageEventKey(
  event: SlackMessageEvent | null | undefined,
  body: SlackEventsApiBody | null | undefined,
): string | null {
  const eventId = body?.event_id?.trim();
  if (eventId) return `event:${eventId}`;
  const channel = event?.channel?.trim();
  const ts = event?.ts?.trim() || event?.event_ts?.trim();
  return channel && ts ? `message:${channel}:${ts}` : null;
}

export function rememberSlackEventOnce(
  seen: Map<string, number>,
  key: string | null,
  now: number,
  ttlMs = SLACK_EVENT_DEDUPE_TTL_MS,
  maxKeys = SLACK_EVENT_DEDUPE_MAX_KEYS,
): boolean {
  if (!key) return true;
  for (const [seenKey, seenAt] of seen) {
    if (seenAt + ttlMs <= now) seen.delete(seenKey);
  }
  if (seen.has(key)) return false;
  while (seen.size >= maxKeys) {
    const oldest = seen.keys().next().value as string | undefined;
    if (!oldest) break;
    seen.delete(oldest);
  }
  seen.set(key, now);
  return true;
}

export function slackMessageChatKind(event: SlackMessageEvent): ChatKind | null {
  // Slack Connect channels can expose bot replies to external workspaces. This
  // desktop bridge carries local workspace context, so Slack stays DM-only
  // until channel support can explicitly verify and confirm shared-channel
  // visibility with the Conversations API.
  return event.channel_type === 'im' ? 'private' : null;
}

/**
 * Actionable message when Slack's INBOUND channel (Socket Mode) is not live.
 *
 * Why this exists: a Slack app with Socket Mode *disabled* still has a valid
 * bot token, so `auth.test()` succeeds. The old probe() checked only that, so
 * the runtime flipped to "connected" (green badge) while no message could
 * ever be received — the bot looked online but never answered. Surface the
 * real cause and the exact fix instead.
 */
export const SLACK_INBOUND_DOWN_HINT =
  'Slack inbound is down: Socket Mode is not connected. The bot token is valid ' +
  '(outbound works) but no messages can be received. Fix at api.slack.com/apps → ' +
  'your app: (1) Socket Mode → Enable; (2) Event Subscriptions → On, subscribe ' +
  'bot event message.im; ' +
  '(3) App Home → enable the Messages Tab AND check "Allow users to send Slash ' +
  'commands and messages from the messages tab" (without this Slack hides the ' +
  'DM box, so the bot can never be messaged); (4) reinstall if scopes changed; ' +
  'then reconnect.';

export type SlackAuthOutcome =
  | { kind: 'ok'; username: string | null }
  | { kind: 'error'; message: string };

/**
 * Pure probe decision. Inbound (Socket Mode) liveness gates everything: a
 * valid bot token is necessary but NOT sufficient — without a live inbound
 * socket the bridge is functionally dead and must report `error`, not
 * `connected`. Extracted pure so the gating logic is unit-tested without a
 * live Slack workspace (mirrors the codebase's pure-logic test style).
 */
export function evaluateSlackProbe(
  started: boolean,
  socketConnected: boolean,
  auth: SlackAuthOutcome | null,
): TransportProbeResult {
  if (!started) return { ok: false, username: null, error: 'not started' };
  if (!socketConnected) return { ok: false, username: null, error: SLACK_INBOUND_DOWN_HINT };
  if (!auth) return { ok: false, username: null, error: 'probe not run' };
  if (auth.kind === 'error') return { ok: false, username: null, error: auth.message };
  return { ok: true, username: auth.username };
}

export class SlackTransport implements ChatTransport {
  readonly platform = 'slack' as const;

  private socket: SocketModeClient | null = null;
  private web: WebClient | null = null;
  // Real inbound (Socket Mode) liveness, driven by the SDK's connection-state
  // events. probe() gates on this so a dead/flapping inbound socket surfaces
  // as `error` instead of a false `connected` (bot token alone is not health).
  private socketConnected = false;
  private msgHandler: ((m: IncomingMessage) => void) | null = null;
  private cmdHandler: ((c: IncomingCommand) => void) | null = null;
  private cbHandler: ((c: IncomingCallback) => void) | null = null;
  // ackId → where to post an ephemeral toast (Slack's interactive ack itself
  // is done inline in the handler within the 3 s window).
  private readonly ackTargets = new Map<
    string,
    { channel: string; user: string; expiresAt: number }
  >();
  private readonly seenMessageEvents = new Map<string, number>();

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.msgHandler = handler;
  }
  onCommand(handler: (cmd: IncomingCommand) => void): void {
    this.cmdHandler = handler;
  }
  onCallback(handler: (cb: IncomingCallback) => void): void {
    this.cbHandler = handler;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, t] of this.ackTargets) {
      if (t.expiresAt <= now) this.ackTargets.delete(id);
    }
  }

  private registerHandlers(socket: SocketModeClient): void {
    // Events API message. ack() MUST be called promptly (Slack retries
    // unacked deliveries) so we ack first, then route.
    socket.on(
      'message',
      async ({
        event,
        body,
        ack,
      }: {
        event: SlackMessageEvent;
        body?: SlackEventsApiBody;
        ack: () => Promise<void>;
      }) => {
        try {
          await ack();
        } catch {
          /* best-effort */
        }
        const dedupeKey = slackMessageEventKey(event, body);
        if (!rememberSlackEventOnce(this.seenMessageEvents, dedupeKey, Date.now())) {
          return;
        }
        // Skip bot echoes and non-plain message subtypes (edits, joins, etc.).
        if (!event || event.bot_id || (event.subtype && event.subtype !== '')) return;
        const chatId = event.channel;
        const senderId = event.user;
        if (!chatId || !senderId) return;
        const chatKind = slackMessageChatKind(event);
        if (!chatKind) return;
        const text = event.text ?? '';
        const base = {
          platform: this.platform,
          chatId,
          senderId,
          senderLabel: null,
          chatKind,
        };
        if (text.startsWith('/')) {
          const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text);
          if (m) {
            this.cmdHandler?.({ ...base, command: m[1]!.toLowerCase(), arg: m[2]!.trim() });
            return;
          }
        }
        this.msgHandler?.({ ...base, text });
      },
    );

    // Block-kit button taps.
    socket.on(
      'interactive',
      async ({ body, ack }: { body: SlackBlockActionsBody; ack: () => Promise<void> }) => {
        try {
          await ack();
        } catch {
          /* best-effort */
        }
        if (!body || body.type !== 'block_actions') return;
        const action = body.actions?.[0];
        const data = action?.value ?? action?.action_id;
        const chatId = body.channel?.id;
        const senderId = body.user?.id;
        if (!data || !chatId || !senderId) return;
        const ackId = body.trigger_id ?? `${chatId}:${Date.now()}`;
        this.evictExpired();
        this.ackTargets.set(ackId, {
          channel: chatId,
          user: senderId,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        this.cbHandler?.({ platform: this.platform, chatId, senderId, data, ackId });
      },
    );

    // Track real inbound liveness. SocketModeClient emits its connection
    // state as event names ('connected' | 'disconnected' | 'disconnecting' |
    // 'reconnecting' | 'connecting' | 'authenticated'). Only a live socket
    // counts as up; anything else (incl. the disabled-Socket-Mode flap loop)
    // must read as down so probe() reports the real state.
    socket.on('connected', () => {
      this.socketConnected = true;
    });
    socket.on('disconnected', () => {
      this.socketConnected = false;
    });
    socket.on('disconnecting', () => {
      this.socketConnected = false;
    });
    socket.on('reconnecting', () => {
      this.socketConnected = false;
    });
  }

  async start(token: string, signal: AbortSignal): Promise<void> {
    if (this.socket) return;
    const { appToken, botToken } = splitTokens(token);
    const webOptions = buildSlackWebClientOptions();
    const web = new WebClient(botToken, webOptions);
    const socket = new SocketModeClient({ appToken, clientOptions: webOptions });
    this.registerHandlers(socket);

    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `Slack unreachable: socket-mode not connected after ${START_TIMEOUT_MS / 1000}s. ` +
                `Check the app-level token / connectivity, then reconnect.`,
            ),
          ),
        START_TIMEOUT_MS,
      );
      (t as unknown as { unref?: () => void }).unref?.();
      signal.addEventListener('abort', () => reject(new Error('Slack connect aborted.')), {
        once: true,
      });
    });
    try {
      await Promise.race([socket.start(), timeout]);
    } catch (err) {
      try {
        await socket.disconnect();
      } catch {
        /* best-effort */
      }
      throw err;
    }
    this.socket = socket;
    this.web = web;
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.web = null;
    this.socketConnected = false;
    this.ackTargets.clear();
    this.seenMessageEvents.clear();
    if (!socket) return;
    try {
      await socket.disconnect();
    } catch (err) {
      console.warn('[bot-bridge:slack] disconnect() error:', err);
    }
  }

  async probe(): Promise<TransportProbeResult> {
    if (!this.web) return evaluateSlackProbe(false, false, null);
    // Inbound liveness gates everything — don't even spend an auth.test() RTT
    // when the socket is down; the answer is already "error" with the hint.
    if (!this.socketConnected) return evaluateSlackProbe(true, false, null);
    try {
      const res = (await this.web.auth.test()) as { ok?: boolean; user?: string };
      const auth: SlackAuthOutcome =
        res.ok === false
          ? { kind: 'error', message: 'Slack auth.test returned ok:false' }
          : { kind: 'ok', username: res.user ?? null };
      return evaluateSlackProbe(true, this.socketConnected, auth);
    } catch (err) {
      return evaluateSlackProbe(true, this.socketConnected, {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async sendMessage(chatId: string, text: string): Promise<SentMessageRef> {
    if (!this.web) throw new Error('Slack transport not started');
    const res = (await this.web.chat.postMessage({ channel: chatId, text })) as {
      ts?: string;
    };
    if (!res.ts) throw new Error('Slack postMessage returned no ts');
    return { chatId, messageId: res.ts };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.web) throw new Error('Slack transport not started');
    await this.web.chat.update({ channel: chatId, ts: messageId, text });
  }

  async sendButtons(chatId: string, text: string, rows: InlineButton[][]): Promise<SentMessageRef> {
    if (!this.web) throw new Error('Slack transport not started');
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...rows.map((row) => ({
        type: 'actions',
        elements: row.map((b) => ({
          type: 'button',
          text: { type: 'plain_text', text: b.label, emoji: true },
          value: b.data,
          action_id: b.data,
        })),
      })),
    ];
    const res = (await this.web.chat.postMessage({
      channel: chatId,
      text,
      blocks: blocks as never,
    })) as { ts?: string };
    if (!res.ts) throw new Error('Slack postMessage(blocks) returned no ts');
    return { chatId, messageId: res.ts };
  }

  async ackCallback(ackId: string, toast?: string): Promise<void> {
    // The interactive payload was already ack()'d inline (Slack's 3 s rule).
    // Here we only surface an optional ephemeral toast to the tapper.
    if (!toast || !this.web) return;
    const target = this.ackTargets.get(ackId);
    this.ackTargets.delete(ackId);
    if (!target) return;
    try {
      await this.web.chat.postEphemeral({
        channel: target.channel,
        user: target.user,
        text: toast,
      });
    } catch {
      /* best-effort */
    }
  }
}
