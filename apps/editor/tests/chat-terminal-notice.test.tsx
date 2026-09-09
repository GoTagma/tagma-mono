import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatOperationV2TerminalNoticeView } from '../src/components/chat/TerminalNotice';

test.each(['classification', 'authoring'] as const)(
  'terminal %s failures retain the provider cause',
  (stage) => {
    const html = renderToStaticMarkup(
      <ChatOperationV2TerminalNoticeView
        terminalOutcome="discarded"
        failure={{
          stage,
          code: 'provider_unavailable',
          invocationId: 'invocation-failed',
          outboxStatus: 'failed_terminal',
          recordedAt: 120,
        }}
      />,
    );
    expect(html).toContain('Provider is temporarily unavailable');
    expect(html).toContain(
      stage === 'classification' ? 'Understanding the request' : 'Writing the pipeline draft',
    );
    expect(html).toContain('Reason: provider_unavailable');
    expect(html).not.toContain('discarded the staged draft');
    expect(html).not.toContain('verification or repair');
  },
);

test('unexplained discards stay neutral while verified automatic discard causes remain specific', () => {
  const generic = renderToStaticMarkup(
    <ChatOperationV2TerminalNoticeView terminalOutcome="discarded" />,
  );
  expect(generic).toContain('Your current pipeline was left unchanged');
  expect(generic).not.toContain('discarded the staged draft');
  const verified = renderToStaticMarkup(
    <ChatOperationV2TerminalNoticeView
      terminalOutcome="discarded"
      terminalReasonCode="repair_attempts_exhausted"
    />,
  );
  expect(verified).toContain('Repair attempts ran out');
  expect(verified).toContain('Reason: repair_attempts_exhausted');
});
