import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExternalAgentControlView } from '../src/components/settings/ExternalAgentControlSection';
import { useAgentChatControlStore } from '../src/agent-chat-control/session';
import { useChatStore } from '../src/store/chat-store';
const initial = useChatStore.getState();
function render() {
  const chat = useChatStore.getState();
  return renderToStaticMarkup(
    createElement(ExternalAgentControlView, {
      workspace: 'D:/isolated',
      ...useAgentChatControlStore.getState(),
      rendererId: chat.chatOperationV2RendererInstanceId,
      currentConversation: chat.chatOperationV2ConversationId,
      operations: chat.chatOperationV2Operations,
    }),
  );
}
afterEach(() => {
  useChatStore.setState(initial);
  useAgentChatControlStore.setState({ status: null, busy: false, error: null });
});

test('Settings names the independent feature and renders it disabled by default', () => {
  useAgentChatControlStore.setState({ status: { enabled: false } });
  const html = render();
  expect(html).toContain('External Agent Control');
  expect(html).toContain('Chat Control API');
  expect(html).toContain('Enable control');
  expect(html).toContain('Disabled');
});
test('enabled Settings provides Copy instructions, explicit grants and take-back control', () => {
  useChatStore.setState({
    chatOperationV2RendererInstanceId: 'renderer',
    chatOperationV2ConversationId: 'conversation',
    bootstrapStatus: 'ready',
  });
  useAgentChatControlStore.setState({
    status: {
      enabled: true,
      workspace: 'D:/isolated',
      controllerId: 'controller',
      controllerVersion: 1,
      expiresAt: 1000,
      connected: true,
      grants: [
        {
          grantId: 'grant',
          conversationId: 'conversation',
          version: 1,
          status: 'active',
          permissionChoices: ['reject'],
          reauthenticated: true,
        },
      ],
    },
  });
  const html = render();
  for (const label of [
    'Copy agent instructions',
    'Authorize conversation',
    'Take back control',
    'Revoke',
    'Editor connected',
  ])
    expect(html).toContain(label);
  expect(html).not.toContain('Bearer');
});
