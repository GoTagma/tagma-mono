import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatPanel } from '../src/components/chat/ChatPanel';
import { useChatStore } from '../src/store/chat-store';
import type { OpencodeThreadEntry } from '../src/api/opencode-chat';

const visibleThread: OpencodeThreadEntry = {
  info: { id: 'm1', sessionID: 's1', role: 'assistant' },
  parts: [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Hello' }],
} as OpencodeThreadEntry;

afterEach(() => {
  useChatStore.setState({
    bootstrapStatus: 'idle',
    currentSessionId: null,
    sessionStates: {},
    completedUnreadSessionIds: [],
    messages: [],
    sessions: [],
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    reconciling: false,
    historyOpen: false,
  } as never);
});

describe('ChatPanel export affordance', () => {
  test('renders the export control directly after the history control', () => {
    useChatStore.setState({
      bootstrapStatus: 'ready',
      currentSessionId: 's1',
      messages: [visibleThread],
      sessions: [{ id: 's1', title: 'Current chat' }] as never,
      sending: false,
      reconciling: false,
      historyOpen: false,
    } as never);

    const html = renderToStaticMarkup(<ChatPanel />);
    const historyIndex = html.indexOf('title="History"');
    const exportIndex = html.indexOf('title="Export conversation"');

    expect(historyIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeGreaterThan(historyIndex);
  });
});
