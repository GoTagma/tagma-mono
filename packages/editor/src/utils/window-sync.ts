/**
 * Cross-window event bus for the editor renderer, backed by BroadcastChannel
 * so every open Tagma window on the same origin receives notifications when
 * shared settings (theme, language, …) change in a peer window.
 *
 * BroadcastChannel only delivers messages to *other* same-origin contexts,
 * never the sender. That matches the intent here: the originating window
 * has already applied the change locally before calling broadcast(), and we
 * just want peers to catch up.
 *
 * Consumers should layer their own typed wrappers on top (e.g. use-theme
 * broadcasts 'theme' with a Theme payload) so this module stays agnostic.
 */

const CHANNEL_NAME = 'tagma.sync';

type Message = { event: string; payload?: unknown };
type Handler = (payload: unknown) => void;

function createChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

const channel = createChannel();
const handlers = new Map<string, Set<Handler>>();

channel?.addEventListener('message', (e: MessageEvent<Message>) => {
  const data = e.data;
  if (!data || typeof data.event !== 'string') return;
  const bucket = handlers.get(data.event);
  if (!bucket) return;
  for (const fn of bucket) fn(data.payload);
});

export function broadcast<T = unknown>(event: string, payload?: T): void {
  channel?.postMessage({ event, payload });
}

export function subscribe<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  let bucket = handlers.get(event);
  if (!bucket) {
    bucket = new Set();
    handlers.set(event, bucket);
  }
  const h = handler as Handler;
  bucket.add(h);
  return () => {
    bucket!.delete(h);
    if (bucket!.size === 0) handlers.delete(event);
  };
}
