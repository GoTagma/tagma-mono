import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as operationApi from '../src/api/chat-operations';
import { setClientWorkspace } from '../src/api/client';
import { useChatStore } from '../src/store/chat-store';
import { resetWorkspaceStores } from '../src/store/workspace-store-reset';
import { useChatDraftStore } from '../src/chat-actions/draft';
import {
  chatDraftNavEntries,
  getChatDraftActionAvailability,
  isChatDraftDirty,
} from '../src/chat-actions/draft';
import { submitThroughControlHttp } from './fixtures/agent-chat-control-http';
import type { AgentChatCommandParameters } from '../shared/agent-chat-control';

async function draftAction<K extends 'draft.open' | 'draft.edit' | 'draft.save' | 'draft.close'>(
  entry: 'ui' | 'http',
  type: K,
  parameters: AgentChatCommandParameters[K],
): Promise<boolean> {
  if (entry === 'http') {
    const { result } = await submitThroughControlHttp(workspace, { type, parameters });
    return (result as { executed: boolean }).executed;
  }
  const actions = useChatDraftStore.getState();
  if (type === 'draft.open') return actions.open();
  if (type === 'draft.save') return actions.save();
  if (type === 'draft.edit') return actions.edit((parameters as { text: string }).text);
  return actions.close((parameters as { discardChanges: boolean }).discardChanges);
}

const workspace = join(tmpdir(), 'draft-actions-isolated');
const initial = useChatStore.getState();
const operation: operationApi.ChatOperationV2Projection = {
  operationId: 'draft-operation',
  rendererInstanceId: 'renderer',
  conversationId: 'conversation',
  generation: 1,
  version: 4,
  phase: 'trial-running',
  waitReason: 'user_retry',
  executionState: 'retryable_failure',
  terminalOutcome: null,
  hasResult: false,
  pendingInputKind: null,
  createdAt: 100,
  updatedAt: 104,
};
const fileId = 'a'.repeat(64);
const fileHash = 'b'.repeat(64);
const draft = {
  files: [{ id: fileId, name: 'pipeline.yaml', bytes: 8, editable: true }],
  totalFileCount: 1,
  omittedFileCount: 0,
  selected: { id: fileId, hash: fileHash, text: 'original' },
};
function result(version = 4, text = 'original') {
  return {
    draft: { ...draft, selected: { ...draft.selected, text } },
    detail: { operation: { ...operation, version } } as operationApi.ChatOperationV2OperationDetail,
  };
}
let access: ReturnType<typeof spyOn<typeof operationApi, 'accessChatOperationDraft'>>;
beforeEach(() => {
  setClientWorkspace(workspace);
  useChatStore.setState({
    ...initial,
    chatExecutionMode: 'operation-v2',
    chatOperationV2ConversationId: operation.conversationId,
    chatOperationV2RendererInstanceId: operation.rendererInstanceId,
    activeChatOperationV2: operation,
  });
  access = spyOn(operationApi, 'accessChatOperationDraft').mockResolvedValue(result());
});
afterEach(() => {
  resetWorkspaceStores();
  access.mockRestore();
  useChatStore.setState(initial);
  setClientWorkspace(null);
});

test('shared draft open reads Host-issued files with the owning conversation credential', async () => {
  expect(await useChatDraftStore.getState().open()).toBe(true);
  expect(useChatDraftStore.getState()).toMatchObject({
    visible: true,
    text: 'original',
    pending: false,
    saved: false,
    error: null,
  });
  expect(access.mock.calls[0]?.[0]).toMatchObject({
    operationId: operation.operationId,
    expectedGeneration: 1,
    expectedVersion: 4,
  });
  expect(access.mock.calls[0]?.[1]).toMatchObject({
    rendererInstanceId: 'renderer',
    conversationId: 'conversation',
    conversationKey: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test('editing and saving retains invalid YAML, then uses the new operation version for later access', async () => {
  await useChatDraftStore.getState().open();
  useChatDraftStore.getState().edit('invalid: [');
  access.mockResolvedValueOnce(result(6, 'invalid: ['));
  expect(await useChatDraftStore.getState().save()).toBe(true);
  expect(access.mock.calls[1]?.[1].edit).toEqual({
    fileId,
    expectedHash: fileHash,
    text: 'invalid: [',
  });
  expect(useChatDraftStore.getState().saved).toBe(true);
  await useChatDraftStore.getState().select(fileId);
  expect(access.mock.calls[2]?.[0].expectedVersion).toBe(6);
});

test('dirty close and file selection require an explicit discard decision', async () => {
  await useChatDraftStore.getState().open();
  useChatDraftStore.getState().edit('unsaved');
  expect(useChatDraftStore.getState().close()).toBe(false);
  expect(await useChatDraftStore.getState().select(fileId)).toBe(false);
  expect(useChatDraftStore.getState().text).toBe('unsaved');
  expect(access).toHaveBeenCalledTimes(1);
  expect(useChatDraftStore.getState().close(true)).toBe(true);
  expect(useChatDraftStore.getState().visible).toBe(false);
});

test('failed save preserves the same edited bytes and exposes the real error', async () => {
  await useChatDraftStore.getState().open();
  useChatDraftStore.getState().edit('keep edited bytes');
  access.mockRejectedValueOnce(new Error('Draft changed. Reload it.'));
  expect(await useChatDraftStore.getState().save()).toBe(false);
  expect(useChatDraftStore.getState()).toMatchObject({
    text: 'keep edited bytes',
    error: 'Draft changed. Reload it.',
    saved: false,
    pending: false,
  });
});

test('late reads cannot resurrect a closed workspace; in-flight actions stay disabled', async () => {
  let finish!: (value: ReturnType<typeof result>) => void;
  access.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const opening = useChatDraftStore.getState().open();
  expect(useChatDraftStore.getState().close(true)).toBe(false);
  expect(useChatDraftStore.getState().edit('not accepted')).toBe(false);
  expect(await useChatDraftStore.getState().save()).toBe(false);
  resetWorkspaceStores();
  finish(result());
  expect(await opening).toBe(false);
  expect(useChatDraftStore.getState()).toMatchObject({
    visible: false,
    draft: null,
    text: '',
    pending: false,
  });
});

test('a historic conversation with another renderer identity cannot open a writable draft', async () => {
  useChatStore.setState({ chatOperationV2RendererInstanceId: 'other-renderer' });
  expect(await useChatDraftStore.getState().open()).toBe(false);
  expect(access).not.toHaveBeenCalled();
});

test.each(['ui', 'http'] as const)(
  '%s draft lifecycle preserves invalid bytes, authenticated file CAS and explicit close',
  async (entry) => {
    expect(await draftAction(entry, 'draft.open', {})).toBe(true);
    expect(await draftAction(entry, 'draft.edit', { text: 'invalid: [' })).toBe(true);
    expect(await draftAction(entry, 'draft.close', { discardChanges: false })).toBe(false);
    access.mockResolvedValueOnce(result(6, 'invalid: ['));
    expect(await draftAction(entry, 'draft.save', {})).toBe(true);
    expect(access.mock.calls[1]?.[0]).toMatchObject({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 4,
    });
    expect(access.mock.calls[1]?.[1]).toMatchObject({
      rendererInstanceId: 'renderer',
      conversationId: 'conversation',
      conversationKey: access.mock.calls[0]?.[1].conversationKey,
      edit: { fileId, expectedHash: fileHash, text: 'invalid: [' },
    });
    expect(useChatDraftStore.getState()).toMatchObject({ saved: true, text: 'invalid: [' });
    expect(await draftAction(entry, 'draft.close', { discardChanges: false })).toBe(true);
  },
);

test.each(['ui', 'http'] as const)(
  '%s injected draft-save conflict retains edited bytes and the same visible error',
  async (entry) => {
    await draftAction(entry, 'draft.open', {});
    await draftAction(entry, 'draft.edit', { text: 'retained bytes' });
    access.mockRejectedValueOnce(new Error('Injected Host file hash conflict'));
    expect(await draftAction(entry, 'draft.save', {})).toBe(false);
    expect(useChatDraftStore.getState()).toMatchObject({
      visible: true,
      text: 'retained bytes',
      saved: false,
      pending: false,
      error: 'Injected Host file hash conflict',
    });
  },
);

const feedback = {
  schemaVersion: 1 as const,
  stage: 'trial' as const,
  details: 'Sandbox case failed: output mismatch',
  failedTaskIds: ['build'],
  omittedFailedTaskCount: 0,
};
function seedDetail(detail: {
  verificationFeedback?: typeof feedback | null;
  draftSummary?: string | null;
}) {
  useChatStore.setState({
    chatOperationV2ThreadDetails: {
      [operation.operationId]: detail as operationApi.ChatOperationV2OperationDetail,
    },
  });
}

test('notice pseudo-files open read-only without touching the edit buffer', async () => {
  seedDetail({ verificationFeedback: feedback, draftSummary: 'generation notes' });
  expect(await useChatDraftStore.getState().open({ notice: 'verification-feedback' })).toBe(true);
  expect(useChatDraftStore.getState().notice).toBe('verification-feedback');
  const availability = getChatDraftActionAvailability(useChatDraftStore.getState());
  expect(availability.edit).toBe('no_file');
  expect(availability.save).toBe('no_file');
  expect(availability.close).toBe(null);
  expect(useChatDraftStore.getState().edit('not accepted')).toBe(false);
  expect(useChatDraftStore.getState().text).toBe('original');
  // Switching between pseudo-files never issues another Host read.
  expect(useChatDraftStore.getState().selectNotice('generation-notes')).toBe(true);
  expect(useChatDraftStore.getState().notice).toBe('generation-notes');
  expect(access).toHaveBeenCalledTimes(1);
  // Selecting a real file leaves the notice and reloads from the Host.
  expect(await useChatDraftStore.getState().select(fileId)).toBe(true);
  expect(useChatDraftStore.getState().notice).toBeNull();
  expect(access).toHaveBeenCalledTimes(2);
});

test('notice selection preserves unsaved edits and the dirty close guard', async () => {
  seedDetail({ verificationFeedback: feedback });
  await useChatDraftStore.getState().open();
  useChatDraftStore.getState().edit('unsaved');
  // Reading evidence never forces an unsaved-changes decision.
  expect(useChatDraftStore.getState().selectNotice('verification-feedback')).toBe(true);
  expect(isChatDraftDirty(useChatDraftStore.getState())).toBe(true);
  expect(useChatDraftStore.getState().text).toBe('unsaved');
  expect(useChatDraftStore.getState().close()).toBe(false);
  // The edited buffer is still there when returning to the file.
  expect(await useChatDraftStore.getState().select(fileId)).toBe(false);
  expect(useChatDraftStore.getState().text).toBe('unsaved');
});

test('notice pseudo-files require existing detail content', async () => {
  expect(await useChatDraftStore.getState().open({ notice: 'verification-feedback' })).toBe(false);
  expect(useChatDraftStore.getState().visible).toBe(false);
  seedDetail({ draftSummary: 'notes only' });
  expect(await useChatDraftStore.getState().open({ notice: 'verification-feedback' })).toBe(false);
  expect(await useChatDraftStore.getState().open({ notice: 'generation-notes' })).toBe(true);
  expect(useChatDraftStore.getState().selectNotice('verification-feedback')).toBe(false);
});

test('opening a notice while the modal is visible switches without another Host read', async () => {
  seedDetail({ verificationFeedback: feedback });
  await useChatDraftStore.getState().open();
  expect(access).toHaveBeenCalledTimes(1);
  expect(await useChatDraftStore.getState().open({ notice: 'verification-feedback' })).toBe(true);
  expect(useChatDraftStore.getState().notice).toBe('verification-feedback');
  expect(access).toHaveBeenCalledTimes(1);
  // A plain reopen stays a no-op.
  expect(await useChatDraftStore.getState().open()).toBe(false);
});

test('draft nav entries order feedback first and generation notes last', () => {
  expect(
    chatDraftNavEntries({ draft, verificationFeedback: feedback, draftSummary: 'notes' }),
  ).toEqual([
    { kind: 'notice', notice: 'verification-feedback', label: 'Verification feedback' },
    { kind: 'file', file: draft.files[0] },
    { kind: 'notice', notice: 'generation-notes', label: 'Generation notes (unverified)' },
  ]);
  expect(
    chatDraftNavEntries({ draft: { ...draft, omittedFileCount: 2, totalFileCount: 3 } }),
  ).toEqual([
    { kind: 'file', file: draft.files[0] },
    { kind: 'omitted', count: 2 },
  ]);
  expect(chatDraftNavEntries({ draft: null })).toEqual([]);
});
