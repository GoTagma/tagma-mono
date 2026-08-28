import { afterEach, describe, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import {
  getChatComposerAvailability,
  restoreComposerDraftAfterSendFailure,
} from '../src/components/chat/ChatComposer';
import { useChatStore } from '../src/store/chat-store';

type ChatState = ReturnType<typeof useChatStore.getState>;

afterEach(() => {
  useChatStore.setState({
    composerDraft: '',
    pendingChatOpenRequest: false,
    composerAttachments: [],
  } as Partial<ChatState>);
  setClientWorkspace(null);
});

describe('chat composer draft', () => {
  test('blocks a new turn while another operation is actively running', () => {
    expect(
      getChatComposerAvailability({
        hasContent: true,
        hasModel: true,
        ready: true,
        sending: false,
        operationActive: true,
      }),
    ).toEqual({ blockedByAnotherChatUpdate: true, canSend: false });
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
  test('attaches context as a removable chip and requests Chat', () => {
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'boom' });

    const [attachment] = useChatStore.getState().composerAttachments;
    expect(attachment.label).toBe('Run failed');
    expect(attachment.content).toBe('boom');
    expect(attachment.id.length).toBeGreaterThan(0);
    expect(useChatStore.getState().composerDraft).toBe('Fix this bug.');
    expect(useChatStore.getState().pendingChatOpenRequest).toBe(true);
  });

  test('never overwrites in-progress user text', () => {
    useChatStore.getState().setComposerDraft('my own words');
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'boom' });
    expect(useChatStore.getState().composerDraft).toBe('my own words');
  });

  test('stacks attachments and removes only the selected attachment', () => {
    useChatStore.getState().attachErrorContext({ label: 'Task A failed', content: 'a' });
    useChatStore.getState().attachErrorContext({ label: 'Task B failed', content: 'b' });
    const [first, second] = useChatStore.getState().composerAttachments;
    expect(first.id).not.toBe(second.id);

    useChatStore.getState().removeComposerAttachment(first.id);
    expect(useChatStore.getState().composerAttachments.map(({ label }) => label)).toEqual([
      'Task B failed',
    ]);
  });
});
