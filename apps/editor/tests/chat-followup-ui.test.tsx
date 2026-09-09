import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionForm, buildQuestionAnswers } from '../src/components/chat/QuestionPanel';
import { MessageBubble } from '../src/components/chat/MessageBubble';
import { CompletionWarningBannerView } from '../src/components/chat/ChatComposer';
import { ClarificationOptions } from '../src/components/chat/ClarificationPanel';
import { buildConversationExport } from '../src/utils/chat-export';
import type { OpencodeThreadEntry } from '../src/api/opencode-chat';

const content = {
  header: 'Environments',
  question: 'Where should this run?',
  multiple: true,
  options: [
    { label: 'Development', description: 'Use the test environment' },
    { label: 'Production', description: 'Use the live environment' },
  ],
};

describe('structured Chat questions', () => {
  test('distinguishes same-name candidates with relative paths and explicit selection buttons', () => {
    const candidates = [
      {
        candidateId: 'pipeline-opaque-a',
        name: 'QA 问候',
        relativeCoordinate: 'original/hello.yaml',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
      {
        candidateId: 'pipeline-opaque-b',
        name: 'QA 问候',
        relativeCoordinate: 'edited/hello.yaml',
        currentCanvas: false,
        sessionOwned: true,
        manualNewDraft: false,
      },
    ];
    const html = renderToStaticMarkup(
      <ClarificationOptions
        question="Which pipeline?"
        candidates={candidates}
        pending={false}
        onChoose={() => {}}
      />,
    );
    expect(html).toContain('QA 问候');
    expect(html).toContain('original/hello.yaml');
    expect(html).toContain('edited/hello.yaml');
    expect(html).toContain('Current canvas');
    expect(html).toContain('This conversation');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('pipeline-opaque-');
    const sending = renderToStaticMarkup(
      <ClarificationOptions
        question="Which pipeline?"
        candidates={candidates}
        pending={true}
        onChoose={() => {}}
      />,
    );
    expect(sending.match(/disabled=""/g)).toHaveLength(2);
  });
  test('preserves multiple selected answers and an optional custom answer', () => {
    expect(buildQuestionAnswers(content, [0, 1], ' Staging ')).toEqual([
      'Development',
      'Production',
      'Staging',
    ]);
    expect(buildQuestionAnswers({ ...content, multiple: false }, [0], '')).toEqual(['Development']);
    expect(() => buildQuestionAnswers({ ...content, multiple: false }, [0, 1], '')).toThrow();
    expect(() => buildQuestionAnswers(content, [], '')).toThrow();
    expect(() => buildQuestionAnswers(content, [], '长'.repeat(100))).toThrow();
  });
  test('renders option descriptions, native checkboxes, and a custom reply', () => {
    const html = renderToStaticMarkup(
      <QuestionForm content={content} onReply={async () => true} />,
    );
    expect(html).toContain('Use the test environment');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('Send answer');
    expect(html).toContain('Skip question');
  });
  test('keeps pending clarification visible without a dismiss action', () => {
    const html = renderToStaticMarkup(<CompletionWarningBannerView warning="Which pipeline?" />);
    expect(html).toContain('Which pipeline?');
    expect(html).not.toContain('<button');
  });
});

test('attachment-only user messages retain readable references in Chat and export', () => {
  const entry: OpencodeThreadEntry = {
    info: {
      id: 'user-1',
      role: 'user',
      sessionID: 'operation-1',
      time: { created: 1 },
      agent: 'tagma-router',
      model: { providerID: 'test', modelID: 'test' },
    },
    parts: [
      { id: 'part-1', sessionID: 'operation-1', messageID: 'user-1', type: 'text', text: '' },
    ],
    contextReferences: [{ label: 'Failed task log' }, { label: 'Selected task' }],
  };
  const html = renderToStaticMarkup(<MessageBubble entry={entry} />);
  expect(html).toContain('Failed task log');
  expect(html).toContain('Selected task');
  for (const format of ['md', 'txt'] as const) {
    const exported = buildConversationExport({ format, messages: [entry] });
    expect(exported.content).toContain('Failed task log');
    expect(exported.content).toContain('Selected task');
  }
  entry.contextReferences = [{ label: '![task](https://example.test/image)' }];
  expect(buildConversationExport({ format: 'md', messages: [entry] }).content).not.toContain(
    '![task](',
  );
  expect(buildConversationExport({ format: 'txt', messages: [entry] }).content).toContain(
    '![task](https://example.test/image)',
  );
});
