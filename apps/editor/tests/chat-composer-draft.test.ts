import { afterEach, describe, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import { restoreComposerDraftAfterSendFailure } from '../src/components/chat/ChatComposer';
import { useChatStore } from '../src/store/chat-store';

type ChatState = ReturnType<typeof useChatStore.getState>;

describe('chat composer draft', () => {
  afterEach(() => {
    useChatStore.setState({
      composerDraft: '',
      pendingChatOpenRequest: false,
      composerAttachments: [],
      queuedMessages: [],
      sending: false,
    } as Partial<ChatState>);
    setClientWorkspace(null);
  });

  test('stores unsent text outside the mounted ChatPanel component', () => {
    useChatStore.getState().setComposerDraft('half-written prompt');

    expect(useChatStore.getState().composerDraft).toBe('half-written prompt');
  });

  test('prefills an empty composer and requests that chat opens', () => {
    useChatStore.getState().prefillComposerForError('diagnose this error');

    expect(useChatStore.getState().composerDraft).toBe('diagnose this error');
    expect(useChatStore.getState().pendingChatOpenRequest).toBe(true);
  });

  test('appends an error prompt without replacing an existing draft', () => {
    useChatStore.getState().setComposerDraft('keep this draft');

    useChatStore.getState().prefillComposerForError('diagnose this error');

    expect(useChatStore.getState().composerDraft).toBe(
      'keep this draft\n\n---\n\ndiagnose this error',
    );
    expect(useChatStore.getState().pendingChatOpenRequest).toBe(true);
  });

  test('acknowledges a chat open request without clearing the composer', () => {
    useChatStore.getState().prefillComposerForError('diagnose this error');

    useChatStore.getState().acknowledgeChatOpenRequest();

    expect(useChatStore.getState().composerDraft).toBe('diagnose this error');
    expect(useChatStore.getState().pendingChatOpenRequest).toBe(false);
  });

  test('restores failed send text only in the submit workspace and an empty draft', () => {
    setClientWorkspace('C:/repo-a');
    restoreComposerDraftAfterSendFailure('C:/repo-a', 'retry this');
    expect(useChatStore.getState().composerDraft).toBe('retry this');

    useChatStore.getState().setComposerDraft('');
    setClientWorkspace('C:/repo-b');
    restoreComposerDraftAfterSendFailure('C:/repo-a', 'do not leak');
    expect(useChatStore.getState().composerDraft).toBe('');

    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setComposerDraft('fresh input');
    restoreComposerDraftAfterSendFailure('C:/repo-a', 'old retry');
    expect(useChatStore.getState().composerDraft).toBe('fresh input');
  });
});

describe('composer error-context attachments', () => {
  afterEach(() => {
    useChatStore.setState({
      composerDraft: '',
      pendingChatOpenRequest: false,
      composerAttachments: [],
      queuedMessages: [],
      sending: false,
    } as Partial<ChatState>);
    setClientWorkspace(null);
  });

  test('attaches the context as a removable chip and requests that chat opens', () => {
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'boom' });

    const atts = useChatStore.getState().composerAttachments;
    expect(atts).toHaveLength(1);
    expect(atts[0].label).toBe('Run failed');
    expect(atts[0].content).toBe('boom');
    expect(typeof atts[0].id).toBe('string');
    expect(atts[0].id.length).toBeGreaterThan(0);
    expect(useChatStore.getState().pendingChatOpenRequest).toBe(true);
  });

  test('seeds the editable default instruction only when the composer is empty', () => {
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'boom' });

    expect(useChatStore.getState().composerDraft).toBe('Fix this bug.');
  });

  test('never overwrites in-progress user text', () => {
    useChatStore.getState().setComposerDraft('my own words');

    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'boom' });

    expect(useChatStore.getState().composerDraft).toBe('my own words');
    expect(useChatStore.getState().composerAttachments).toHaveLength(1);
  });

  test('stacks multiple attachments with distinct ids', () => {
    useChatStore.getState().attachErrorContext({ label: 'Task A failed', content: 'a' });
    useChatStore.getState().attachErrorContext({ label: 'Task B failed', content: 'b' });

    const atts = useChatStore.getState().composerAttachments;
    expect(atts.map((a) => a.label)).toEqual(['Task A failed', 'Task B failed']);
    expect(atts[0].id).not.toBe(atts[1].id);
  });

  test('removes a single attachment by id, leaving the rest', () => {
    useChatStore.getState().attachErrorContext({ label: 'Task A failed', content: 'a' });
    useChatStore.getState().attachErrorContext({ label: 'Task B failed', content: 'b' });
    const [first] = useChatStore.getState().composerAttachments;

    useChatStore.getState().removeComposerAttachment(first.id);

    const atts = useChatStore.getState().composerAttachments;
    expect(atts).toHaveLength(1);
    expect(atts[0].label).toBe('Task B failed');
  });

  test('a queued send carries the rendered context and clears the chips', async () => {
    useChatStore.setState({ sending: true } as Partial<ChatState>);
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'stderr tail' });

    await useChatStore.getState().send('Fix this bug.');

    const queued = useChatStore.getState().queuedMessages;
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe('Fix this bug.');
    expect(queued[0].context).toBe(
      '<ask-ai-context>\n<attachment>\nstderr tail\n</attachment>\n</ask-ai-context>\n\n',
    );
    expect(useChatStore.getState().composerAttachments).toHaveLength(0);
  });
});
