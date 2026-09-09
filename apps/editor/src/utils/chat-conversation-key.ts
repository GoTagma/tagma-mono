const headlessKeys = new Map<string, string>();

/** Kept outside transcript/state projections; persisted before the first network request. */
export function getChatConversationKey(
  workspaceKey: string,
  rendererInstanceId: string,
  conversationId: string,
): string {
  const storageKey = `tagma.chat.conversation-key.v1:${JSON.stringify([workspaceKey, rendererInstanceId, conversationId])}`;
  const storage = globalThis.sessionStorage;
  if (typeof window !== 'undefined' && !storage)
    throw new Error('Chat cannot persist its conversation identity in this page.');
  const existing = storage ? storage.getItem(storageKey) : headlessKeys.get(storageKey);
  if (existing !== undefined && existing !== null) {
    if (!/^[0-9a-f]{64}$/.test(existing))
      throw new Error('Chat conversation identity is invalid. Start a new conversation.');
    return existing;
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (storage) {
    storage.setItem(storageKey, key);
    if (storage.getItem(storageKey) !== key)
      throw new Error('Chat could not preserve its conversation identity.');
  } else {
    headlessKeys.set(storageKey, key);
  }
  return key;
}
