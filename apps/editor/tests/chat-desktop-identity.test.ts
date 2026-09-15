import { afterEach, expect, test } from 'bun:test';
import {
  getChatConversationKey,
  readChatConversationKey,
} from '../src/utils/chat-conversation-key';
import { getDesktopChatIdentityBridge, type DesktopChatIdentityBridge } from '../src/desktop';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});
function install(bridge: DesktopChatIdentityBridge | undefined) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { chatIdentity: bridge } },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw new Error('The recreated renderer has no old page storage');
    },
  });
}

test('the renderer uses the persisted desktop credential before returning from first creation and after page recreation', () => {
  let durable: string | null = null;
  const bridge: DesktopChatIdentityBridge = {
    protocolVersion: 1,
    rendererId: () => 'renderer',
    selectedConversation: () => 'conversation',
    selectConversation: () => true,
    conversationKey: (_workspace, _renderer, _conversation, create) => {
      if (create) durable ??= '7'.repeat(64);
      return durable;
    },
  };
  install(bridge);
  expect(readChatConversationKey('/workspace', 'renderer', 'conversation')).toBeNull();
  const key = getChatConversationKey('/workspace', 'renderer', 'conversation');
  expect<string | null>(durable).toBe(key);
  install({ ...bridge });
  expect(readChatConversationKey('/workspace', 'renderer', 'conversation')).toBe(key);
  expect(getChatConversationKey('/workspace', 'renderer', 'conversation')).toBe(key);
});

test('desktop persistence failure and protocol skew never fall back to a new page credential', () => {
  const bridge: DesktopChatIdentityBridge = {
    protocolVersion: 1,
    rendererId: () => 'renderer',
    selectedConversation: () => null,
    selectConversation: () => true,
    conversationKey: () => {
      throw new Error('Durable write failed');
    },
  };
  install(bridge);
  expect(() => getChatConversationKey('/workspace', 'renderer', 'conversation')).toThrow(
    'Durable write failed',
  );
  install({ ...bridge, protocolVersion: 2 } as unknown as DesktopChatIdentityBridge);
  expect(() => readChatConversationKey('/workspace', 'renderer', 'conversation')).toThrow(
    'incompatible',
  );
});

test('an older shipped preload keeps the existing page identity contract', () => {
  const values = new Map<string, string>();
  install(undefined);
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  });
  expect(getDesktopChatIdentityBridge()).toBeNull();
  const key = getChatConversationKey('/old-workspace', 'old-renderer', 'old-conversation');
  expect(readChatConversationKey('/old-workspace', 'old-renderer', 'old-conversation')).toBe(key);
  expect(readChatConversationKey('/old-workspace', 'old-renderer', 'missing')).toBeNull();
});
