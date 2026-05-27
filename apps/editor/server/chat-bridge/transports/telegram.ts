/**
 * Telegram transport — grammy long-polling behind the ChatTransport interface.
 *
 * Everything grammy-specific lives here: Bot construction, bounded init,
 * long-poll lifecycle, the getMe heartbeat probe, and translating grammy
 * Context objects into the transport's flat IncomingMessage/Command/Callback
 * shapes. The conductor never imports grammy.
 *
 * Long-poll keeps the sidecar's inbound attack surface at zero — grammy
 * issues outbound getUpdates calls; nothing from the network reaches us.
 */

import { Bot, GrammyError, HttpError, InlineKeyboard, type Context } from 'grammy';
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

// grammy's default API timeout is 500 s (the Bot API long-poll ceiling) —
// right for getUpdates, far too long for getMe/sendMessage/editMessageText.
// 30 s bounds those without truncating the long-poll (grammy applies the
// poll timeout separately).
const API_TIMEOUT_SECONDS = 30;
// init() is a getMe call with no timeout of its own. If Telegram is
// unreachable an unbounded init() hangs the caller (and the UI "Connect"
// button) forever. Bound it so an unreachable Telegram fails fast.
const INIT_TIMEOUT_MS = 15_000;

function chatKindOf(ctx: Context): ChatKind {
  return ctx.chat?.type === 'private' ? 'private' : 'group';
}

function senderLabelOf(ctx: Context): string | null {
  return ctx.from?.first_name ?? ctx.from?.username ?? null;
}

export class TelegramTransport implements ChatTransport {
  readonly platform = 'telegram' as const;

  private bot: Bot | null = null;
  private msgHandler: ((m: IncomingMessage) => void) | null = null;
  private cmdHandler: ((c: IncomingCommand) => void) | null = null;
  private cbHandler: ((c: IncomingCallback) => void) | null = null;

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.msgHandler = handler;
  }
  onCommand(handler: (cmd: IncomingCommand) => void): void {
    this.cmdHandler = handler;
  }
  onCallback(handler: (cb: IncomingCallback) => void): void {
    this.cbHandler = handler;
  }

  private registerHandlers(bot: Bot): void {
    // One text handler classifies command vs free-text so the conductor —
    // not grammy — owns the command vocabulary. `/cmd@botname arg` and
    // `/cmd arg` both normalize to { command, arg }.
    bot.on('message:text', (ctx) => {
      const chatId = ctx.chat?.id;
      const senderId = ctx.from?.id;
      if (chatId == null || senderId == null) return;
      const text = ctx.message?.text ?? '';
      const base = {
        platform: this.platform,
        chatId: String(chatId),
        senderId: String(senderId),
        senderLabel: senderLabelOf(ctx),
        chatKind: chatKindOf(ctx),
      };
      if (text.startsWith('/')) {
        const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text);
        if (m) {
          this.cmdHandler?.({
            ...base,
            command: m[1]!.toLowerCase(),
            arg: m[2]!.trim(),
          });
          return;
        }
      }
      this.msgHandler?.({ ...base, text });
    });

    bot.on('callback_query:data', (ctx) => {
      const chatId = ctx.chat?.id;
      const senderId = ctx.from?.id;
      const data = ctx.callbackQuery?.data;
      const ackId = ctx.callbackQuery?.id;
      if (chatId == null || senderId == null || data == null || ackId == null) return;
      this.cbHandler?.({
        platform: this.platform,
        chatId: String(chatId),
        senderId: String(senderId),
        data,
        ackId,
      });
    });

    bot.catch((err) => {
      const cause = err.error;
      if (cause instanceof GrammyError) {
        console.error('[bot-bridge:telegram] API error:', cause.description);
      } else if (cause instanceof HttpError) {
        console.error('[bot-bridge:telegram] transport error:', cause);
      } else {
        console.error('[bot-bridge:telegram] unhandled error:', cause);
      }
    });
  }

  async start(token: string, signal: AbortSignal): Promise<void> {
    if (this.bot) return;
    const bot = new Bot(token, { client: { timeoutSeconds: API_TIMEOUT_SECONDS } });
    this.registerHandlers(bot);

    // Bound init() with whichever fires first: the caller's abort signal or
    // our own ceiling. grammy aborts its internal retry-delay by throwing a
    // plain Error("Aborted delay") (name === 'Error'), so we detect the
    // timeout via the signal's own `aborted` flag, not error-name sniffing.
    const timeoutSignal = AbortSignal.timeout(INIT_TIMEOUT_MS);
    const initSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      await bot.init(initSignal);
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new Error(
          `Telegram unreachable: bot.init() timed out after ${INIT_TIMEOUT_MS / 1000}s. ` +
            `Check connectivity / proxy, then reconnect.`,
        );
      }
      if (signal.aborted) throw new Error('Telegram connect aborted.');
      throw err;
    }

    // start() resolves only when the bot is told to stop, so kick it off
    // without awaiting — init() above already confirmed we're up.
    void bot
      .start({
        drop_pending_updates: true,
        onStart: (info) => {
          console.log(`[bot-bridge:telegram] @${info.username} long-poll started`);
        },
      })
      .catch((err) => {
        console.error('[bot-bridge:telegram] long-poll stopped with error:', err);
      });
    this.bot = bot;
  }

  async stop(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (!bot) return;
    try {
      await bot.stop();
    } catch (err) {
      console.warn('[bot-bridge:telegram] stop() error:', err);
    }
  }

  async probe(): Promise<TransportProbeResult> {
    if (!this.bot) return { ok: false, username: null, error: 'not started' };
    try {
      const me = await this.bot.api.getMe();
      return { ok: true, username: me.username ?? null };
    } catch (err) {
      return {
        ok: false,
        username: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendMessage(chatId: string, text: string): Promise<SentMessageRef> {
    if (!this.bot) throw new Error('Telegram transport not started');
    const sent = await this.bot.api.sendMessage(chatId, text);
    return { chatId, messageId: String(sent.message_id) };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram transport not started');
    await this.bot.api.editMessageText(chatId, Number(messageId), text);
  }

  async sendButtons(chatId: string, text: string, rows: InlineButton[][]): Promise<SentMessageRef> {
    if (!this.bot) throw new Error('Telegram transport not started');
    const kb = new InlineKeyboard();
    rows.forEach((row, i) => {
      if (i > 0) kb.row();
      for (const b of row) kb.text(b.label, b.data);
    });
    const sent = await this.bot.api.sendMessage(chatId, text, { reply_markup: kb });
    return { chatId, messageId: String(sent.message_id) };
  }

  async ackCallback(ackId: string, toast?: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.answerCallbackQuery(ackId, toast ? { text: toast } : undefined);
    } catch {
      /* best-effort — an un-acked callback just shows a spinner briefly */
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch {
      /* best-effort */
    }
  }
}
