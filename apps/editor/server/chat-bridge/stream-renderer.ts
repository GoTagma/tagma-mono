/**
 * Streaming renderer — turns opencode SSE part updates into Telegram message
 * edits with throttling + chunking.
 *
 * Design constraints:
 *   - Telegram caps single-message text at 4096 chars. We chunk at 3800 to
 *     leave headroom for our "…(cont)" trailer.
 *   - Telegram caps editMessageText rate at ~1/sec per chat. Going over =
 *     429 + retry-after. We throttle to 1.5 s minimum gap.
 *   - opencode `message.part.updated` carries the FULL accumulated text
 *     for that part (not a delta), so we overwrite by `part.id` rather than
 *     append. Multiple parts can exist within one assistant message (text +
 *     tool-call + reasoning); we render them in source order.
 *
 * Lifecycle:
 *   `createTurn(opts)` — starts a turn bound to one bot message id.
 *   `turn.applyPart(part)` — accumulates / schedules a throttled flush.
 *   `turn.appendToolLine(line)` — pushes a one-line tool entry below the text.
 *   `turn.finalize(footer?)` — flushes immediately and seals the message.
 *
 * The caller (bot-loop.ts) is responsible for filtering by sessionID and
 * routing events through the right turn instance — this module is pure
 * render.
 */

import type { MessageSink } from './transports/types.js';

const MIN_EDIT_GAP_MS = 1500;
// Default chunk ceiling. Telegram's hard cap is 4096; 3800 leaves headroom
// for the "…(continued)" trailer. Discord caps a message at 2000, so its
// transport overrides this via CreateOpts.maxChars (see ChatTransport
// .maxMessageChars). Slack's text limit is far higher; default is fine.
const DEFAULT_CHUNK_LIMIT = 3800;
const CONTINUATION_HEADER = '…(continued)\n';
const TRAILER_WHEN_SPLIT = '\n…(continued in next message)';

interface SectionPart {
  /** Stable id from opencode (part.id). */
  id: string;
  /** Order in which this part was first seen. */
  order: number;
  /** What this part is — drives rendering. */
  kind: 'text' | 'reasoning';
  /** Latest accumulated text. */
  text: string;
}

export interface StreamTurnHandle {
  applyTextPart(partId: string, text: string): void;
  applyReasoningPart(partId: string, text: string): void;
  appendToolLine(line: string): void;
  finalize(footer?: string): Promise<void>;
  abort(reason: string): Promise<void>;
}

interface CreateOpts {
  sink: MessageSink;
  chatId: string;
  /** Platform message id of the placeholder, created by the caller before this turn. */
  initialMessageId: string;
  /**
   * Max characters per platform message. Telegram ≈ 3800 (default), Discord
   * 2000, Slack large. The renderer chunks/splits to stay under this so a
   * long answer never trips the platform's hard cap.
   */
  maxChars?: number;
}

interface RenderState {
  parts: Map<string, SectionPart>;
  partOrder: number;
  toolLog: string[];
  /** Platform message ids for rendered chunks. Index 0 is always the placeholder. */
  messageIds: string[];
  /** Last text written per message id, so repeated flushes can skip no-op edits. */
  writtenTextByMessageId: Map<string, string>;
  /** Wall-clock of last successful editMessageText call. */
  lastEditAt: number;
  /** Pending flush timer, if any. */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** True after finalize() — further part events become no-ops. */
  sealed: boolean;
  /** True while a flush is mid-air (prevents reentrant edit storms). */
  flushing: boolean;
}

function renderBody(state: RenderState, isFinal: boolean): string {
  const ordered = [...state.parts.values()].sort((a, b) => a.order - b.order);
  const blocks: string[] = [];
  // Reasoning: collapse into a single 🤔 line summarizing total length.
  // Power users can later get a "show reasoning" toggle; for now just signal
  // that the model thought before answering.
  let reasoningChars = 0;
  for (const p of ordered) {
    if (p.kind === 'reasoning') reasoningChars += p.text.length;
  }
  if (reasoningChars > 0) {
    blocks.push(`🤔 thinking (${reasoningChars} chars)`);
  }
  for (const p of ordered) {
    if (p.kind === 'text' && p.text.trim().length > 0) {
      blocks.push(p.text);
    }
  }
  if (state.toolLog.length > 0) {
    blocks.push(state.toolLog.join('\n'));
  }
  let body = blocks.join('\n\n').trim();
  if (!isFinal && body.length === 0) {
    body = '⏳ working…';
  }
  return body;
}

/**
 * Split a body into Telegram-sized chunks. The first chunk has no
 * continuation header (it lives in the original message); subsequent chunks
 * get a "…(continued)" prefix.
 */
function chunkBody(body: string, limit: number): string[] {
  if (body.length <= limit) return [body];
  const chunks: string[] = [];
  let cursor = 0;
  let first = true;
  while (cursor < body.length) {
    // Try to break on a newline near the limit to keep rendering tidy.
    const window = body.slice(cursor, cursor + limit);
    let splitAt = window.length;
    if (cursor + window.length < body.length) {
      const nl = window.lastIndexOf('\n', limit - 1);
      if (nl > limit * 0.5) splitAt = nl + 1;
    }
    const slice = window.slice(0, splitAt);
    chunks.push(first ? slice : CONTINUATION_HEADER + slice);
    first = false;
    cursor += splitAt;
  }
  return chunks;
}

export function createStreamTurn(opts: CreateOpts): StreamTurnHandle {
  // Clamp to a sane floor — a tiny limit would shred output into dozens of
  // messages; even Discord's 2000 is comfortably above this.
  const chunkLimit = Math.max(500, opts.maxChars ?? DEFAULT_CHUNK_LIMIT);
  const state: RenderState = {
    parts: new Map(),
    partOrder: 0,
    toolLog: [],
    messageIds: [opts.initialMessageId],
    writtenTextByMessageId: new Map(),
    lastEditAt: 0,
    flushTimer: null,
    sealed: false,
    flushing: false,
  };

  const scheduleFlush = () => {
    if (state.sealed) return;
    if (state.flushTimer) return;
    const elapsed = Date.now() - state.lastEditAt;
    const delay = Math.max(0, MIN_EDIT_GAP_MS - elapsed);
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void flush(false);
    }, delay);
  };

  const flush = async (isFinal: boolean): Promise<void> => {
    if (state.flushing) {
      // A flush is already underway — schedule another one for after if we're
      // not final, so the latest pending text catches up without overlapping
      // edit calls.
      if (!isFinal) scheduleFlush();
      return;
    }
    state.flushing = true;
    try {
      const fullBody = renderBody(state, isFinal);
      const chunks = chunkBody(fullBody, chunkLimit);
      const rendered = chunks.map((chunk, index) =>
        index === chunks.length - 1 ? chunk : chunk + TRAILER_WHEN_SPLIT,
      );
      for (let i = 0; i < rendered.length; i++) {
        const text = rendered[i]!;
        const existingMessageId = state.messageIds[i];
        try {
          if (existingMessageId !== undefined) {
            if (state.writtenTextByMessageId.get(existingMessageId) === text) continue;
            await opts.sink.editMessage(opts.chatId, existingMessageId, text);
            state.writtenTextByMessageId.set(existingMessageId, text);
          } else {
            const sent = await opts.sink.sendMessage(opts.chatId, text);
            state.messageIds[i] = sent.messageId;
            state.writtenTextByMessageId.set(sent.messageId, text);
          }
        } catch (err) {
          // 400 "message is not modified" can sneak through if Telegram
          // server-side dedupes harder than our local guard. Swallow it —
          // any other error gets logged so the user can diagnose.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/not modified/i.test(msg)) {
            console.warn('[bot-bridge] chunk render failed:', msg);
          }
          break;
        }
      }
      state.lastEditAt = Date.now();
    } finally {
      state.flushing = false;
    }
  };

  const upsertPart = (id: string, kind: SectionPart['kind'], text: string) => {
    if (state.sealed) return;
    const existing = state.parts.get(id);
    if (existing) {
      if (existing.text === text) return; // no-op edit
      existing.text = text;
      existing.kind = kind;
    } else {
      state.parts.set(id, {
        id,
        kind,
        text,
        order: state.partOrder++,
      });
    }
    scheduleFlush();
  };

  return {
    applyTextPart(partId, text) {
      upsertPart(partId, 'text', text);
    },
    applyReasoningPart(partId, text) {
      upsertPart(partId, 'reasoning', text);
    },
    appendToolLine(line) {
      if (state.sealed) return;
      state.toolLog.push(line);
      scheduleFlush();
    },
    async finalize(footer) {
      if (state.sealed) return;
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (footer) {
        // Render the footer as the final block so it shows at the bottom of
        // the last message — useful for usage stats, "see desktop chat for
        // full transcript", etc.
        state.toolLog.push(footer);
      }
      state.sealed = true;
      await flush(true);
    },
    async abort(reason) {
      if (state.sealed) return;
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      state.toolLog.push(`⚠️ aborted: ${reason}`);
      state.sealed = true;
      await flush(true);
    },
  };
}
