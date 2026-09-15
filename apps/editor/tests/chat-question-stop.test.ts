import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionForm } from '../src/components/chat/QuestionPanel';

test('Stop stays outside the disabled question fieldset while a reply is pending', () => {
  const html = renderToStaticMarkup(
    createElement(QuestionForm, {
      content: { header: 'Question', question: 'Continue?', options: [], multiple: false },
      externalPending: true,
      onReply: async () => true,
      onStop: async () => undefined,
    }),
  );
  expect(html).toContain('fieldset disabled');
  expect(html.indexOf('Stop chat')).toBeGreaterThan(html.indexOf('</fieldset>'));
});
