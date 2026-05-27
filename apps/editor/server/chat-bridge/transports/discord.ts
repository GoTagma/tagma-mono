/**
 * Discord transport — discord.js v14 Gateway behind the ChatTransport
 * interface.
 *
 * Gateway = an outbound WebSocket to Discord; like Telegram long-poll it
 * needs NO inbound port, so the sidecar's attack surface stays zero.
 *
 * Setup the user must do once (Discord Developer Portal):
 *   - create an application + bot, copy the bot token
 *   - enable the "Message Content Intent" privileged intent (without it
 *     message.content is empty and the bridge can't read prompts)
 *   - invite the bot with scopes: bot; perms: View Channels, Send Messages,
 *     Send Messages in Threads, Read Message History, Add Reactions
 *
 * NOT live-verified yet — written against the documented discord.js v14 API
 * and typechecked; first real round-trip happens in the joint test session.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type Interaction,
  type Message,
} from 'discord.js';
import type {
  ChatTransport,
  IncomingCallback,
  IncomingCommand,
  IncomingMessage,
  InlineButton,
  SentMessageRef,
  TransportProbeResult,
} from './types.js';

// Discord caps a single message at 2000 chars — well under the renderer's
// 3800 default, so we advertise it and the stream-renderer chunks tighter.
const DISCORD_MAX_MESSAGE = 2000;
const LOGIN_TIMEOUT_MS = 15_000;
const BUTTON_INTERACTION_TTL_MS = 10 * 60 * 1000;

export function awaitDiscordLoginReady(
  login: Promise<unknown>,
  ready: Promise<void>,
  timeout: Promise<never>,
): Promise<void> {
  return Promise.race([login.then(() => ready), timeout]);
}

export interface PendingDiscordButtonInteraction {
  interaction: ButtonInteraction;
  expiresAt: number;
  ackStarted: Promise<void>;
}

export function beginDiscordButtonAck(
  interaction: ButtonInteraction,
): PendingDiscordButtonInteraction {
  return {
    interaction,
    expiresAt: Date.now() + BUTTON_INTERACTION_TTL_MS,
    // Discord requires an interaction acknowledgement promptly. Start it at
    // receipt time; the conductor can do slower permission work afterward.
    ackStarted: interaction.deferUpdate().then(
      () => undefined,
      () => undefined,
    ),
  };
}

export async function finishDiscordButtonAck(
  entry: PendingDiscordButtonInteraction,
  toast?: string,
): Promise<void> {
  await entry.ackStarted;
  if (!toast) return;
  await entry.interaction.followUp({ content: toast, ephemeral: true });
}

export function isDiscordSelfMessage(
  author: { id?: string | null } | null | undefined,
  selfUserId: string | null | undefined,
): boolean {
  return Boolean(author?.id && selfUserId && String(author.id) === String(selfUserId));
}

export class DiscordTransport implements ChatTransport {
  readonly platform = 'discord' as const;
  readonly maxMessageChars = DISCORD_MAX_MESSAGE;

  private client: Client | null = null;
  private msgHandler: ((m: IncomingMessage) => void) | null = null;
  private cmdHandler: ((c: IncomingCommand) => void) | null = null;
  private cbHandler: ((c: IncomingCallback) => void) | null = null;
  // Button taps must be answered through the same interaction object Discord
  // delivered (it carries a one-shot token). Start the protocol ack
  // immediately, then keep it keyed by interaction id so ackCallback can send
  // an optional ephemeral follow-up after conductor work finishes.
  private readonly pendingInteractions = new Map<string, PendingDiscordButtonInteraction>();

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.msgHandler = handler;
  }
  onCommand(handler: (cmd: IncomingCommand) => void): void {
    this.cmdHandler = handler;
  }
  onCallback(handler: (cb: IncomingCallback) => void): void {
    this.cbHandler = handler;
  }

  private evictExpiredInteractions(): void {
    const now = Date.now();
    for (const [id, e] of this.pendingInteractions) {
      if (e.expiresAt <= now) this.pendingInteractions.delete(id);
    }
  }

  private registerHandlers(client: Client): void {
    client.on(Events.MessageCreate, (message: Message) => {
      // Ignore only our own outbound messages. Other bot accounts still pass
      // through the same allowlist gate as users, matching nanobot's Discord
      // channel behavior for explicitly authorized automation.
      if (isDiscordSelfMessage(message.author, client.user?.id)) return;
      const chatId = message.channelId;
      const senderId = message.author?.id;
      if (!chatId || !senderId) return;
      const text = message.content ?? '';
      const base = {
        platform: this.platform,
        chatId,
        senderId,
        senderLabel: message.author?.username ?? null,
        chatKind: message.guild ? ('group' as const) : ('private' as const),
      };
      if (text.startsWith('/')) {
        const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text);
        if (m) {
          this.cmdHandler?.({ ...base, command: m[1]!.toLowerCase(), arg: m[2]!.trim() });
          return;
        }
      }
      this.msgHandler?.({ ...base, text });
    });

    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!interaction.isButton()) return;
      this.evictExpiredInteractions();
      this.pendingInteractions.set(interaction.id, beginDiscordButtonAck(interaction));
      const chatId = interaction.channelId;
      const senderId = interaction.user?.id;
      if (!chatId || !senderId) return;
      this.cbHandler?.({
        platform: this.platform,
        chatId,
        senderId,
        data: interaction.customId,
        ackId: interaction.id,
      });
    });

    client.on(Events.Error, (err) => {
      console.error('[bot-bridge:discord] client error:', err);
    });
  }

  async start(token: string, signal: AbortSignal): Promise<void> {
    if (this.client) return;
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Channel/Message partials let DM + uncached-message events fire.
      partials: [Partials.Channel, Partials.Message],
    });
    this.registerHandlers(client);

    // Bound login: an unreachable Discord must fail fast, not hang /connect.
    const ready = new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve());
      client.once(Events.Error, reject);
    });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `Discord unreachable: gateway not ready after ${LOGIN_TIMEOUT_MS / 1000}s. ` +
                `Check the bot token / connectivity, then reconnect.`,
            ),
          ),
        LOGIN_TIMEOUT_MS,
      );
      (t as unknown as { unref?: () => void }).unref?.();
      signal.addEventListener('abort', () => reject(new Error('Discord connect aborted.')), {
        once: true,
      });
    });
    try {
      await awaitDiscordLoginReady(client.login(token), ready, timeout);
    } catch (err) {
      try {
        await client.destroy();
      } catch {
        /* best-effort */
      }
      throw err;
    }
    this.client = client;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.pendingInteractions.clear();
    if (!client) return;
    try {
      await client.destroy();
    } catch (err) {
      console.warn('[bot-bridge:discord] destroy() error:', err);
    }
  }

  async probe(): Promise<TransportProbeResult> {
    const client = this.client;
    if (!client || !client.isReady()) {
      return { ok: false, username: null, error: 'not ready' };
    }
    return { ok: true, username: client.user?.username ?? null };
  }

  private async sendableChannel(chatId: string) {
    if (!this.client) throw new Error('Discord transport not started');
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${chatId} is not a sendable text channel`);
    }
    return channel;
  }

  async sendMessage(chatId: string, text: string): Promise<SentMessageRef> {
    const channel = await this.sendableChannel(chatId);
    const sent = await channel.send(text);
    return { chatId, messageId: sent.id };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const channel = await this.sendableChannel(chatId);
    const msg = await channel.messages.fetch(messageId);
    // Clear components on every edit so a verdict edit also strips stale
    // buttons; the streaming live message never had any so this is a no-op
    // there.
    await msg.edit({ content: text, components: [] });
  }

  async sendButtons(chatId: string, text: string, rows: InlineButton[][]): Promise<SentMessageRef> {
    const channel = await this.sendableChannel(chatId);
    const components = rows.map((row) => {
      const r = new ActionRowBuilder<ButtonBuilder>();
      for (const b of row) {
        r.addComponents(
          new ButtonBuilder().setCustomId(b.data).setLabel(b.label).setStyle(ButtonStyle.Secondary),
        );
      }
      return r;
    });
    const sent = await channel.send({ content: text, components });
    return { chatId, messageId: sent.id };
  }

  async ackCallback(ackId: string, toast?: string): Promise<void> {
    const entry = this.pendingInteractions.get(ackId);
    this.pendingInteractions.delete(ackId);
    if (!entry) return;
    try {
      // The deferUpdate call already started at receipt time. Here we only
      // wait for it and optionally surface a follow-up toast.
      await finishDiscordButtonAck(entry, toast);
    } catch {
      /* best-effort — an un-acked button just shows a transient error */
    }
  }
}
