export interface ChatQueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  /**
   * Rendered `<ask-ai-context>` block captured at enqueue time, if the user
   * had context attachments on the composer when this message was queued.
   * Travels with the message so the context isn't lost while the prompt waits
   * behind an in-flight turn. Absent/empty when there were no attachments.
   */
  context?: string;
}

export function shouldQueueOutgoingMessage({
  sending,
  queuedCount,
}: {
  sending: boolean;
  queuedCount: number;
}): boolean {
  return sending || queuedCount > 0;
}

export function appendQueuedMessage(
  queue: readonly ChatQueuedMessage[],
  item: ChatQueuedMessage,
): ChatQueuedMessage[] {
  return [...queue, item];
}

export function removeQueuedMessage(
  queue: readonly ChatQueuedMessage[],
  id: string,
): ChatQueuedMessage[] {
  return queue.filter((item) => item.id !== id);
}

export function drainQueuedMessages(queue: readonly ChatQueuedMessage[]): {
  combined: string | null;
  combinedContext: string;
} {
  if (queue.length === 0) return { combined: null, combinedContext: '' };
  return {
    combined: queue.map((item) => item.text).join('\n\n'),
    // Each `context` is a self-contained rendered `<ask-ai-context>` block
    // (ends with its own blank line); concatenating preserves queue order and
    // stripAskAiContext removes all of them from the history bubble.
    combinedContext: queue.map((item) => item.context ?? '').join(''),
  };
}

export function shouldShowForcePush({
  sending,
  queuedCount,
}: {
  sending: boolean;
  queuedCount: number;
}): boolean {
  return sending && queuedCount > 0;
}
