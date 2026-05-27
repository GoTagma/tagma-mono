import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { resetOpencodeClient } from '../src/api/opencode-chat';

// These tests drive the immediate-send path far enough to observe how context
// chips behave while a turn is in flight. `globalThis.fetch` is shared across
// the bun test process, so we save/restore it around this file's run (same
// contract as chat-store-sse.test.ts).
const originalFetch = globalThis.fetch;

beforeAll(() => {
  // No workspace → promptOpencode skips the YAML-edit-lock / save branch and
  // goes straight to getOpencodeClient(), where our fetch stub takes over.
  usePipelineStore.setState({ workDir: null, yamlPath: null } as never);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOpencodeClient();
  useChatStore.setState({
    composerDraft: '',
    composerAttachments: [],
    queuedMessages: [],
    sending: false,
    sendError: null,
    pendingUserText: null,
    model: null,
    agent: null,
  } as never);
});

function armSend() {
  resetOpencodeClient();
  useChatStore.setState({
    sending: false,
    model: { providerID: 'p', modelID: 'm' },
    agent: 'tagma-router',
  } as never);
  useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'stderr tail' });
}

describe('immediate send with context attachments', () => {
  test('clears the chips as soon as the send starts, before the turn resolves', () => {
    // fetch never resolves → the turn stays in flight after the chips would
    // have been consumed. If the chips lingered here, a follow-up message
    // fired while this turn is in flight would re-attach the same context.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    armSend();

    const inFlight = useChatStore.getState().send('Fix this bug.');

    expect(useChatStore.getState().composerAttachments).toHaveLength(0);
    expect(useChatStore.getState().queuedMessages).toHaveLength(0);
    inFlight.catch(() => {
      /* never settles; handler avoids an unhandled-rejection warning */
    });
  });

  test('restores the chips when the send fails so the context is not lost', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('stubbed network failure'))) as unknown as typeof fetch;
    armSend();

    await useChatStore
      .getState()
      .send('Fix this bug.')
      .catch(() => {
        /* surfaced via sendError */
      });

    const atts = useChatStore.getState().composerAttachments;
    expect(atts).toHaveLength(1);
    expect(atts[0].label).toBe('Run failed');
    expect(atts[0].content).toBe('stderr tail');
    expect(useChatStore.getState().sending).toBe(false);
  });
});
