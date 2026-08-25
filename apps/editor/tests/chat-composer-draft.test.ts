import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { setClientWorkspace } from '../src/api/client';
import { restoreComposerDraftAfterSendFailure } from '../src/components/chat/ChatComposer';
import {
  applySseEvent,
  useChatStore,
  type ChatFinishedTurn,
  type ChatYamlSessionResult,
} from '../src/store/chat-store';
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

function readyEventStreamResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
          ),
        );
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for chat composer fixture state.');
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

function finishedTurn(id = 'finished-barrier'): ChatFinishedTurn {
  return {
    id,
    sessionId: 'existing',
    endedAt: 1_000,
    hidden: false,
    termination: 'completed',
    yamlSnapshotBeforeSend: {
      workDir: 'C:/repo',
      activePath: 'C:/repo/.tagma/pipeline/pipeline.yaml',
      localEditRevision: 7,
      yamlEditLockId: 'yaml-lock-stage-1',
      staging: {
        id: 'stage-1',
        agentTagmaDir: 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma',
        activeRelativePath: 'pipeline/pipeline.yaml',
        activeStagedPath:
          'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/pipeline/pipeline.yaml',
        entries: [],
      },
    },
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
      sessionStates: {},
      model: null,
      agent: null,
      pendingUserText: null,
      yamlSnapshotBeforeSend: null,
      sendError: null,
      completionWarning: null,
      lastFinishedTurn: null,
      finishedTurnQueue: [],
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
      if (new URL(url, 'http://local.test').pathname === '/event') {
        return Promise.resolve(readyEventStreamResponse());
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
    await waitFor(() => promptRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('keeps every finished turn as a start-fresh queue barrier until it is acknowledged', async () => {
    const promptRequests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (new URL(url, 'http://local.test').pathname === '/event') {
        return Promise.resolve(readyEventStreamResponse());
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

    const turn = finishedTurn();
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    await useChatStore.getState().send('Wait until reconciliation finishes.');

    expect(useChatStore.getState().queuedMessages).toHaveLength(1);
    expect(useChatStore.getState().queuedDispatchMode).toBe('start-fresh');
    expect(useChatStore.getState().dispatchQueuedMessagesIfReady()).toBe(false);
    expect(promptRequests).toEqual([]);

    useChatStore.getState().acknowledgeFinishedTurn(turn.id);
    expect(useChatStore.getState().dispatchQueuedMessagesIfReady()).toBe(true);
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().pendingUserText).toBe('Wait until reconciliation finishes.');
    await waitFor(() => promptRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('does not let another sessions failed result queue the visible sessions prompt', async () => {
    const promptRequests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (new URL(url, 'http://local.test').pathname === '/event') {
        return Promise.resolve(readyEventStreamResponse());
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

    const otherTurn = {
      ...finishedTurn('other-failed'),
      sessionId: 'other-session',
      reconcileFailure: {
        message: 'Preserved other result.',
        attempt: 1,
        failedAt: 1,
      },
    };
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      model: { providerID: 'p', modelID: 'm' },
      agent: 'tagma-router',
      finishedTurnQueue: [otherTurn],
      lastFinishedTurn: otherTurn,
    } as Partial<ChatState>);

    await useChatStore.getState().send('Continue this independent session.');

    expect(useChatStore.getState().queuedMessages).toEqual([]);
    expect(useChatStore.getState().sending).toBe(true);
    await waitFor(() => promptRequests.length === 1);
  });

  test('marks and retries reconciliation without changing the finished turn or stage identity', () => {
    const turn = finishedTurn('finished-retry');
    const snapshot = turn.yamlSnapshotBeforeSend;
    useChatStore.setState({
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(turn.id, 'The first finalize request failed.');

    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    expect(failed).not.toBe(turn);
    expect(failed).toMatchObject({
      id: turn.id,
      sessionId: turn.sessionId,
      endedAt: turn.endedAt,
      reconcileFailure: {
        message: 'The first finalize request failed.',
        attempt: 1,
      },
    });
    expect(failed.reconcileFailure!.failedAt).toBeGreaterThan(0);
    expect(failed.yamlSnapshotBeforeSend).toBe(snapshot);
    expect(useChatStore.getState().lastFinishedTurn).toBe(failed);

    useChatStore.getState().retryFinishedTurnReconciliation(turn.id);

    const retried = useChatStore.getState().finishedTurnQueue[0]!;
    expect(retried).not.toBe(failed);
    expect(retried.id).toBe(turn.id);
    expect(retried.sessionId).toBe(turn.sessionId);
    expect(retried.endedAt).toBe(turn.endedAt);
    expect(retried.yamlSnapshotBeforeSend).toBe(snapshot);
    expect(retried.reconcileFailure).toBeUndefined();
    expect(useChatStore.getState().lastFinishedTurn).toBe(retried);

    useChatStore.getState().markFinishedTurnReconciliationFailed(turn.id, 'The retry failed.');
    expect(useChatStore.getState().finishedTurnQueue[0]!.reconcileFailure).toMatchObject({
      message: 'The retry failed.',
      attempt: 2,
    });
  });

  test('reclassifies missing route provenance as independent recovery instead of futile Retry', () => {
    const turn = finishedTurn('route-unresolved');
    useChatStore.setState({
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(
        turn.id,
        'The Host could not authenticate the legacy route evidence.',
        'route-unresolved',
      );
    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    expect(failed.reconcileFailure).toMatchObject({
      kind: 'route-unresolved',
      retryable: false,
      attempt: 1,
    });

    useChatStore.getState().retryFinishedTurnReconciliation(turn.id);
    expect(useChatStore.getState().finishedTurnQueue[0]).toBe(failed);

    useChatStore.getState().recoverFinishedTurnAsIndependent(turn.id);
    const recovered = useChatStore.getState().finishedTurnQueue[0]!;
    expect(recovered.reconcileFailure).toBeUndefined();
    expect(recovered.independentRecoveryRequestId).toBe('recovery_route-unresolved');
    expect(recovered.yamlSnapshotBeforeSend).not.toBe(turn.yamlSnapshotBeforeSend);
    expect(recovered.yamlSnapshotBeforeSend?.staging).toBe(turn.yamlSnapshotBeforeSend?.staging);
    expect(recovered.yamlSnapshotBeforeSend?.independentRecoveryRequestId).toBe(
      'recovery_route-unresolved',
    );
  });

  test('abandons only a failed reconciliation and preserves queued prompts as start-fresh', () => {
    const failedHead = finishedTurn('failed-head');
    const healthyTail = finishedTurn('healthy-tail');
    useChatStore.setState({
      finishedTurnQueue: [failedHead, healthyTail],
      lastFinishedTurn: healthyTail,
      queuedMessages: [{ id: 'queued-1', text: 'Continue after cleanup.', createdAt: 1 }],
      queuedDispatchMode: 'reuse-logical-turn',
    } as Partial<ChatState>);

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(failedHead.id)).toBeNull();
    expect(useChatStore.getState().finishedTurnQueue).toEqual([failedHead, healthyTail]);

    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(failedHead.id, 'Finalize cannot continue.');
    const failed = useChatStore.getState().finishedTurnQueue[0]!;

    const abandoned = useChatStore.getState().abandonFinishedTurnReconciliation(failedHead.id);

    expect(abandoned).toBe(failed);
    expect(abandoned?.yamlSnapshotBeforeSend).toBe(failedHead.yamlSnapshotBeforeSend);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([healthyTail]);
    expect(useChatStore.getState().queuedMessages).toEqual([
      { id: 'queued-1', text: 'Continue after cleanup.', createdAt: 1 },
    ]);
    expect(useChatStore.getState().queuedDispatchMode).toBe('start-fresh');
    expect(useChatStore.getState().lastFinishedTurn).toBe(healthyTail);
  });

  test('does not abandon a different failed turn when the requested id is absent', () => {
    const turn = finishedTurn('failed-present');
    useChatStore.setState({
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);
    useChatStore.getState().markFinishedTurnReconciliationFailed(turn.id, 'Keep this failure.');
    const failed = useChatStore.getState().finishedTurnQueue[0]!;

    expect(useChatStore.getState().abandonFinishedTurnReconciliation('failed-missing')).toBeNull();
    expect(useChatStore.getState().finishedTurnQueue).toEqual([failed]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(failed);
  });

  test('does not rewrite an idle queue mode when abandoning without queued prompts', () => {
    const turn = finishedTurn('failed-without-prompts');
    useChatStore.setState({
      finishedTurnQueue: [turn],
      queuedMessages: [],
      queuedDispatchMode: null,
    } as Partial<ChatState>);
    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(turn.id, 'Abandon with no follow-up.');

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(turn.id)?.id).toBe(turn.id);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(useChatStore.getState().queuedMessages).toEqual([]);
    expect(useChatStore.getState().queuedDispatchMode).toBeNull();
  });

  test('restores a claimed failed head with the exact snapshot and attempt count', () => {
    const claimedHead = finishedTurn('claimed-failed-head');
    const tail = finishedTurn('queued-tail');
    useChatStore.setState({
      finishedTurnQueue: [claimedHead, tail],
      lastFinishedTurn: claimedHead,
      queuedMessages: [{ id: 'queued-restore', text: 'Resume later.', createdAt: 2 }],
      queuedDispatchMode: 'reuse-logical-turn',
    } as Partial<ChatState>);
    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(claimedHead.id, 'Original merge failure.');
    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    const originalSnapshot = failed.yamlSnapshotBeforeSend;
    const originalAttempt = failed.reconcileFailure!.attempt;
    const originalFailedAt = failed.reconcileFailure!.failedAt;
    expect(useChatStore.getState().abandonFinishedTurnReconciliation(failed.id)).toBe(failed);

    useChatStore.setState({ queuedDispatchMode: 'reuse-logical-turn' } as Partial<ChatState>);
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(
          failed,
          'The stage may already have been finalized; retry the merge check.',
        ),
    ).toBe(true);

    const restored = useChatStore.getState().finishedTurnQueue[0]!;
    expect(useChatStore.getState().finishedTurnQueue.map((turn) => turn.id)).toEqual([
      failed.id,
      tail.id,
    ]);
    expect(restored).not.toBe(failed);
    expect(restored.yamlSnapshotBeforeSend).toBe(originalSnapshot);
    expect(restored.reconcileFailure).toMatchObject({
      message: 'The stage may already have been finalized; retry the merge check.',
      attempt: originalAttempt,
    });
    expect(restored.reconcileFailure!.failedAt).toBeGreaterThanOrEqual(originalFailedAt);
    expect(useChatStore.getState().lastFinishedTurn).toBe(restored);
    expect(useChatStore.getState().queuedDispatchMode).toBe('start-fresh');

    useChatStore.getState().retryFinishedTurnReconciliation(restored.id);
    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(restored.id, 'A later merge retry failed.');
    expect(useChatStore.getState().finishedTurnQueue[0]!.reconcileFailure?.attempt).toBe(
      originalAttempt + 1,
    );
  });

  test('refuses to restore a healthy or duplicate abandoned turn', () => {
    const healthy = finishedTurn('healthy-restore');
    useChatStore.setState({
      finishedTurnQueue: [healthy],
      lastFinishedTurn: healthy,
    } as Partial<ChatState>);

    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(healthy, 'Must stay healthy.'),
    ).toBe(false);

    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(healthy.id, 'Existing queue failure.');
    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(failed, 'Must not replace duplicate.'),
    ).toBe(false);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([failed]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(failed);
  });

  test('session deletion releases only the exact lease captured by that session runtime', async () => {
    const releases: Array<{ id: string; workspace: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/workspace/yaml-edit-lock' && init?.method === 'DELETE') {
        releases.push({
          id: (JSON.parse(String(init.body)) as { id: string }).id,
          workspace: new Headers(init.headers).get('X-Tagma-Workspace'),
        });
        return jsonResponse({ ok: true, released: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    setClientWorkspace('C:/different-visible-workspace');
    const turn = finishedTurn('deleted-session-turn');
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: 'existing' } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );
    await Promise.resolve();

    expect(releases).toEqual([
      {
        id: 'yaml-lock-stage-1',
        workspace: 'C:/repo',
      },
    ]);
  });

  test('session deletion leaves a queued finished turn lease to its lifecycle owner', async () => {
    const releases: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/workspace/yaml-edit-lock' && init?.method === 'DELETE') {
        releases.push((JSON.parse(String(init.body)) as { id: string }).id);
        return jsonResponse({ ok: true, released: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    setClientWorkspace('C:/different-visible-workspace');
    const turn = finishedTurn('queued-deleted-session-turn');
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Named chat' }] as never,
      yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: 'existing' } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );
    await Promise.resolve();

    expect(releases).toEqual([]);
  });

  test('queues behind an external YAML lock and dispatches after the lock clears', async () => {
    const promptRequests: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (new URL(url, 'http://local.test').pathname === '/event') {
        return Promise.resolve(readyEventStreamResponse());
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
    await waitFor(() => promptRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
