/**
 * Transport abstraction for the bot bridge.
 *
 * Everything platform-specific about a messenger collapses to two surfaces:
 *
 *   1. INBOUND  — the platform hands us messages, slash-commands, and
 *                 button taps (callbacks). The transport normalizes each
 *                 into a flat shape and invokes the registered handler.
 *   2. OUTBOUND — we send / edit text, send inline-button prompts, ack a
 *                 button tap, show a typing indicator.
 *
 * The shared conductor (conductor.ts) drives pairing / allowlist / opencode
 * orchestration purely through this interface, so adding Discord or Slack is
 * "write one more `ChatTransport`", not "fork the orchestration".
 *
 * Message ids are STRINGS here even though Telegram's are numeric — Discord
 * snowflakes and Slack `ts` values are strings, so string is the only common
 * denominator. Each transport converts at its own boundary.
 */

// Single source of truth lives in ../types.ts. Import for local use in the
// interfaces below AND re-export so transport code can pull Platform from the
// transport barrel without reaching up a level.
import type { Platform } from '../types.js';
export type { Platform };

export type ChatKind = 'private' | 'group';

/** A free-text (non-command) inbound message. */
export interface IncomingMessage {
  platform: Platform;
  /** Platform-native conversation id (Telegram chat.id, Discord channel id, Slack channel). */
  chatId: string;
  /** Platform-native sender id (Telegram from.id, Discord user id, Slack user id). */
  senderId: string;
  /** Best-effort human label (first name / username / display name) or null. */
  senderLabel: string | null;
  chatKind: ChatKind;
  text: string;
}

/** A slash-command inbound message (`/pair 123456` → command='pair', arg='123456'). */
export interface IncomingCommand {
  platform: Platform;
  chatId: string;
  senderId: string;
  senderLabel: string | null;
  chatKind: ChatKind;
  /** lowercased command word without the leading slash or @botname suffix */
  command: string;
  /** everything after the command word, trimmed */
  arg: string;
}

/** A button tap. `data` is the opaque payload we put on the button. */
export interface IncomingCallback {
  platform: Platform;
  chatId: string;
  senderId: string;
  data: string;
  /** Opaque token the transport needs in order to ack/answer the tap. */
  ackId: string;
}

export interface SentMessageRef {
  chatId: string;
  /** String-normalized platform message id. */
  messageId: string;
}

export interface InlineButton {
  /** Visible button label. */
  label: string;
  /** Callback payload delivered back via onCallback. Keep <=48 chars — Telegram caps callback_data at 64 bytes. */
  data: string;
}

/**
 * Minimal outbound surface the stream-renderer needs. A `ChatTransport` is a
 * superset of this; the renderer only ever touches these two so it stays
 * platform-agnostic and trivially mockable in tests.
 */
export interface MessageSink {
  sendMessage(chatId: string, text: string): Promise<SentMessageRef>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
}

export interface TransportProbeResult {
  ok: boolean;
  /** Bot account handle if the platform exposes one (Telegram @username). */
  username: string | null;
  error?: string;
}

export interface ChatTransport extends MessageSink {
  readonly platform: Platform;

  /**
   * Hard per-message character cap for this platform, if it's tighter than
   * the renderer's default (~3800). Telegram: omit (4096, default headroom
   * fine). Discord: 2000. Slack: omit (very large). The stream-renderer reads
   * this to chunk long answers so they never trip the platform's hard limit.
   */
  readonly maxMessageChars?: number;

  /**
   * Connect + begin receiving. MUST resolve only once the transport is
   * actually up (so the runtime can flip status to 'connected'); MUST reject
   * fast (bounded) if the platform is unreachable so a UI "Connect" can't
   * hang forever. `signal` aborts a slow connect.
   */
  start(token: string, signal: AbortSignal): Promise<void>;

  /** Stop receiving and release the connection. Idempotent. */
  stop(): Promise<void>;

  /** Cheap reachability/auth check used by the periodic heartbeat. */
  probe(): Promise<TransportProbeResult>;

  /** Send an inline-button prompt. Returns the message ref so we can edit it on tap. */
  sendButtons(chatId: string, text: string, rows: InlineButton[][]): Promise<SentMessageRef>;

  /** Acknowledge a button tap (Telegram answerCallbackQuery / Discord defer). */
  ackCallback(ackId: string, toast?: string): Promise<void>;

  /** Optional "typing…" affordance; no-op on platforms without one. */
  sendTyping?(chatId: string): Promise<void>;

  /** Register the inbound handlers. Called once before `start`. */
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onCommand(handler: (cmd: IncomingCommand) => void): void;
  onCallback(handler: (cb: IncomingCallback) => void): void;
}
