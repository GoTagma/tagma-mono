import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatCodeBlock, highlightChatCode } from '../src/components/chat/ChatCodeBlock';
import { groupChatHistory, filterChatHistory } from '../src/components/chat/HistoryDrawer';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';

test('code blocks highlight YAML while preserving code text and escaping markup', () => {
  const code = 'tasks:\n  - id: example\n    command: "<script>alert(1)</script>"\n';
  const html = renderToStaticMarkup(<ChatCodeBlock code={code} language="yaml" />);
  expect(html).toContain('hljs-attr');
  expect(html).toContain('Copy code');
  expect(html).toContain('Wrap lines');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  const text = (nodes: ReturnType<typeof highlightChatCode>): string =>
    nodes
      .map((node) =>
        node.type === 'text' ? node.value : node.type === 'element' ? text(node.children) : '',
      )
      .join('');
  expect(text(highlightChatCode(code, 'yaml'))).toBe(code);
  expect(text(highlightChatCode(code, 'unknown-language'))).toBe(code);
});

test('history search uses stable first-turn topics and retains entries whose topic is still unavailable', () => {
  const op = (id: string, conversationId: string, createdAt: number) =>
    ({
      operationId: id,
      conversationId,
      rendererInstanceId: 'renderer',
      createdAt,
      updatedAt: createdAt,
      phase: 'terminal',
      executionState: 'terminal',
    }) as ChatOperationV2Projection;
  const groups = groupChatHistory([op('a2', 'a', 20), op('a1', 'a', 10), op('b1', 'b', 30)]);
  expect(groups.find((group) => group.operation.conversationId === 'a')?.topicOperationId).toBe(
    'a1',
  );
  const topics = { a1: { status: 'ready' as const, text: 'Build the release pipeline' } };
  expect(
    filterChatHistory(groups, topics, 'RELEASE').map((group) => group.operation.conversationId),
  ).toEqual(['b', 'a']);
  expect(
    filterChatHistory(
      groups,
      { ...topics, b1: { status: 'ready', text: 'Explain an error' } },
      'release',
    ),
  ).toHaveLength(1);
  expect(
    filterChatHistory(groups, { ...topics, b1: { status: 'unavailable' } }, 'not found'),
  ).toHaveLength(1);
});
