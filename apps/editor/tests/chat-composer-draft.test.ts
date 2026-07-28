import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { setClientWorkspace } from '../src/api/client';
import { restoreComposerDraftAfterSendFailure } from '../src/components/chat/ChatComposer';
import { useChatStore, type ChatYamlSessionResult } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { useYamlEditLockStore } from '../src/store/yaml-edit-lock-store';

type ChatState = ReturnType<typeof useChatStore.getState>;
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function previousResult(): ChatYamlSessionResult {
  return {
    sessionId: 'existing',
    workspaceKey: 'C:/repo',
    kind: 'refresh-current',
    path: 'C:/repo/.tagma/pipeline.yaml',
    name: 'pipeline.yaml',
    pipelineName: 'Pipeline',
    status: 'ready',
    compile: {
      success: true,
      summary: 'Compile passed.',
      validation: { errors: [], warnings: [] },
    } as never,
    reconcile: {
      outcome: 'adopted',
      conflicts: [],
      localBranchPersisted: false,
      resultPath: 'C:/repo/.tagma/pipeline.yaml',
      compileSuccess: true,
    },
    completedAt: 1_000,
  };
}

beforeEach(() => {
  usePipelineStore.setState({ workDir: null, yamlPath: null } as never);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('chat composer draft', () => {
  afterEach(() => {
    useChatStore.setState({
      composerDraft: '',
      pendingChatOpenRequest: false,
      composerAttachments: [],
      queuedMessages: [],
      queuedDispatchMode: null,
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
    globalThis.fetch = originalFetch;
    resetOpencodeClient();
    useChatStore.setState({
      composerDraft: '',
      pendingChatOpenRequest: false,
      composerAttachments: [],
      queuedMessages: [],
      queuedDispatchMode: null,
      sending: false,
      reconciling: false,
      flushing: false,
      activeChatYamlLifecycle: null,
      postChatYamlAction: null,
      sessionYamlResults: {},
      currentSessionId: null,
      sessions: [],
      model: null,
      agent: null,
      pendingUserText: null,
      sendError: null,
      completionWarning: null,
    } as Partial<ChatState>);
    useYamlEditLockStore.setState({
      active: false,
      workspaceActive: false,
      owner: null,
      reason: null,
      expiresAt: null,
      local: false,
      lockWorkspaceKey: null,
      yamlPath: null,
    });
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
    expect(useChatStore.getState().queuedDispatchMode).toBe('reuse-logical-turn');
    expect(queued[0].context).toBe(
      '<ask-ai-context>\n' +
        '<attachment label="Run failed">\n' +
        'stderr tail\n' +
        '</attachment>\n' +
        '</ask-ai-context>\n\n',
    );
    expect(useChatStore.getState().composerAttachments).toHaveLength(0);
  });

  test('queues during reconcile without clearing the active YAML progress state', async () => {
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
      reconciling: true,
      postChatYamlAction: {
        kind: 'refresh-current',
        path: 'C:/repo/.tagma/pipeline.yaml',
        name: 'pipeline.yaml',
        pipelineName: 'Pipeline',
        status: 'repairing',
        compile: {
          success: false,
          summary: 'Compile failed.',
          validation: { errors: [], warnings: [] },
        } as never,
      },
      sessionYamlResults: { existing: previousResult() },
    } as Partial<ChatState>);
    useChatStore.getState().attachErrorContext({ label: 'Run failed', content: 'stderr tail' });

    await useChatStore.getState().send('Follow up after reconcile.');

    const state = useChatStore.getState();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedDispatchMode).toBe('start-fresh');
    expect(state.queuedMessages[0].text).toBe('Follow up after reconcile.');
    expect(state.postChatYamlAction).toMatchObject({ status: 'repairing', name: 'pipeline.yaml' });
    expect(state.composerAttachments).toHaveLength(0);
  });

  test('queues during flush without clearing the active YAML progress state', async () => {
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
      flushing: true,
      postChatYamlAction: {
        kind: 'refresh-current',
        path: 'C:/repo/.tagma/pipeline.yaml',
        name: 'pipeline.yaml',
        pipelineName: 'Pipeline',
        status: 'repairing',
        compile: {
          success: false,
          summary: 'Compile failed.',
          validation: { errors: [], warnings: [] },
        } as never,
      },
    } as Partial<ChatState>);

    await useChatStore.getState().send('Follow up after flush.');

    const state = useChatStore.getState();
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedDispatchMode).toBe('start-fresh');
    expect(state.queuedMessages[0].text).toBe('Follow up after flush.');
    expect(state.postChatYamlAction).toMatchObject({ status: 'repairing', name: 'pipeline.yaml' });
    expect(state.sending).toBe(false);
  });

  test('starts a fresh prompt after reconcile releases the barrier', async () => {
    const promptRequests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (url === 'http://opencode.test/session/existing') {
        return Promise.resolve(jsonResponse({ id: 'existing' }));
      }
      if (url === 'http://opencode.test/session/existing/prompt_async') {
        promptRequests.push(url);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }) as typeof fetch;

    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
      reconciling: true,
      sessionYamlResults: { existing: previousResult() },
    } as Partial<ChatState>);

    await useChatStore.getState().send('Start fresh after reconcile.');
    expect(useChatStore.getState().queuedDispatchMode).toBe('start-fresh');
    useChatStore.setState({ reconciling: false } as Partial<ChatState>);

    expect(useChatStore.getState().dispatchQueuedMessagesIfReady()).toBe(true);

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('Start fresh after reconcile.');
    expect(state.queuedMessages).toEqual([]);
    expect(state.queuedDispatchMode).toBeNull();
  });

  test('queues behind an external YAML lock and dispatches after the lock clears', async () => {
    const promptRequests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (url === 'http://opencode.test/session/existing') {
        return Promise.resolve(jsonResponse({ id: 'existing' }));
      }
      if (url === 'http://opencode.test/session/existing/prompt_async') {
        promptRequests.push(url);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }) as typeof fetch;

    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
    } as Partial<ChatState>);
    useYamlEditLockStore.setState({
      active: true,
      workspaceActive: true,
      owner: 'chat',
      reason: 'other window',
      expiresAt: Date.now() + 60_000,
      local: false,
      lockWorkspaceKey: 'C:/repo',
      yamlPath: null,
    });

    await useChatStore.getState().send('Wait for the lock release.');

    expect(useChatStore.getState().queuedMessages).toHaveLength(1);
    expect(useChatStore.getState().queuedDispatchMode).toBe('start-fresh');
    expect(useChatStore.getState().dispatchQueuedMessagesIfReady()).toBe(false);
    expect(promptRequests).toEqual([]);

    useYamlEditLockStore.setState({
      active: false,
      workspaceActive: false,
      owner: null,
      reason: null,
      expiresAt: null,
      local: false,
      lockWorkspaceKey: null,
      yamlPath: null,
    });

    expect(useChatStore.getState().dispatchQueuedMessagesIfReady()).toBe(true);
    expect(useChatStore.getState().queuedMessages).toEqual([]);
    expect(useChatStore.getState().queuedDispatchMode).toBeNull();
    expect(useChatStore.getState().sending).toBe(true);
  });
});
