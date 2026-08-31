import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OpenCodeInvocationController,
  sha256CanonicalOpenCodeRequest,
  type OpenCodeInvocationNativeClient,
} from '../server/chat-operations/opencode-invocation.js';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { ChatOperationV2Store } from '../server/chat-operations/store.js';
import type { ChatOperationV2State } from '../server/chat-operations/types.js';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity.js';

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];
const TEST_CONTROL_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

function state(): ChatOperationV2State {
  return {
    protocol: 'v2',
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: 3,
    clarificationRounds: 0,
    clarificationMaxRounds: 3,
  };
}

function openStore(now = () => 1_777_777_777_100): {
  store: ChatOperationV2Store;
  workspaceScopeId: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-op-v2-invocation-'));
  roots.push(root);
  const store = new ChatOperationV2Store({
    databasePath: join(root, 'server-control', 'chat-operation-v2.sqlite'),
    keyId: `sha256:${'c'.repeat(64)}`,
    now,
  });
  stores.push(store);
  const workspaceScope = store.ensureWorkspaceScope(
    createTrustedWorkspaceScopeRecord(
      {
        workspaceScopeId: 'scope-1',
        workspacePath: '/workspaces/one',
        createdAt: 1_777_777_777_000,
        controlGeneration: 1,
      },
      TEST_CONTROL_KEY,
      { platform: 'linux', realpathNative: (value) => value },
    ),
  );
  const operationCreatedAt = 1_777_777_777_001;
  store.createOperation({
    operationId: 'operation-1',
    clientRequestId: 'client-request-operation-1',
    workspaceScopeId: workspaceScope.workspaceScopeId,
    generation: 1,
    state: state(),
    admission: sealChatOperationV2Admission({
      schemaVersion: 1,
      request: {
        schemaVersion: 1,
        text: 'Invocation fixture request.',
        attachments: [],
      },
      provider: 'fixture-provider',
      model: 'fixture-model',
      variant: null,
      agentPolicyHash: 'a'.repeat(64),
      settingsHash: 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      featureHash: 'd'.repeat(64),
      rendererInstanceId: 'renderer-fixture',
      conversationId: 'conversation-fixture',
      inventoryRevision: 1,
      inventoryDigest: 'e'.repeat(64),
      readSnapshotHash: null,
      purpose: 'classifier',
      admittedAt: operationCreatedAt,
    }),
    createdAt: operationCreatedAt,
    event: { eventId: 'operation-1-created', type: 'operation_created' },
  });
  return { store, workspaceScopeId: workspaceScope.workspaceScopeId };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may deliberately close a store before reopening it.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ChatTurn Operation V2 OpenCode invocation outbox', () => {
  test('durably prepares the Host ids and request digest before native create and prompt', async () => {
    const { store, workspaceScopeId } = openStore();
    const requestBytes = Buffer.from(
      '{"delivery":"queue","prompt":{"text":"hello"},"resume":true}',
      'utf8',
    );
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    const calls: string[] = [];
    const assertPrepared = () => {
      const outbox = store.getInvocationOutbox('invocation-1');
      expect(outbox).toMatchObject({
        workspaceScopeId,
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        sessionId: 'session-1',
        inputId: 'input-1',
        requestDigest,
        status: 'prepared',
      });
    };
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        assertPrepared();
        return { records: [], hasMore: false };
      },
      async createSession(input) {
        calls.push('create');
        assertPrepared();
        expect(input).toEqual({ sessionId: 'session-1' });
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt(input) {
        calls.push('prompt');
        assertPrepared();
        expect(input).toEqual({
          sessionId: 'session-1',
          inputId: 'input-1',
          canonicalRequestBytes: requestBytes,
        });
        return {
          kind: 'admitted',
          admission: {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest,
            aggregateSeq: 7,
          },
        };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      now: () => 1_777_777_777_100,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-1',
      purpose: 'authoring',
      sessionId: 'session-1',
      inputId: 'input-1',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history', 'create', 'prompt']);
    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-1',
      sessionId: 'session-1',
      inputId: 'input-1',
      admittedAggregateSeq: 7,
      recoveredFromHistory: false,
    });
    expect(store.getInvocationOutbox('invocation-1')).toMatchObject({
      status: 'admitted',
      admittedAggregateSeq: 7,
      failureCode: null,
    });
  });

  test('distinguishes a preflight history failure before any native submission attempt', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"preflight history"}}', 'utf8');
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        throw new Error('private preflight history failure');
      },
      async createSession() {
        calls.push('create');
        throw new Error('create must not run');
      },
      async prompt() {
        calls.push('prompt');
        throw new Error('prompt must not run');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-preflight-history',
      purpose: 'trial_plan',
      sessionId: 'session-preflight-history',
      inputId: 'input-preflight-history',
      submissionMode: 'recover',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history']);
    expect(outcome).toEqual({
      kind: 'submitted_unknown',
      invocationId: 'invocation-preflight-history',
      sessionId: 'session-preflight-history',
      inputId: 'input-preflight-history',
      reasonCode: 'admission_preflight_history_request_failed',
    });
    expect(JSON.stringify(outcome)).not.toContain('private preflight');
  });

  test('distinguishes a session-create transport failure whose history remains missing', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"create transport"}}', 'utf8');
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        return { records: [], hasMore: false };
      },
      async createSession() {
        calls.push('create');
        throw new Error('private create transport failure');
      },
      async prompt() {
        calls.push('prompt');
        throw new Error('prompt must not run');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-create-transport',
      purpose: 'repair',
      sessionId: 'session-create-transport',
      inputId: 'input-create-transport',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history', 'create', 'history']);
    expect(outcome).toEqual({
      kind: 'submitted_unknown',
      invocationId: 'invocation-create-transport',
      sessionId: 'session-create-transport',
      inputId: 'input-create-transport',
      reasonCode: 'session_create_transport_history_missing',
    });
  });

  test('a fresh invocation continues after a preflight history outage without blind recovery semantics', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"fresh preflight"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        throw new Error('transient history outage before fresh submission');
      },
      async createSession(input) {
        calls.push('create');
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt(input) {
        calls.push('prompt');
        return {
          kind: 'admitted',
          admission: {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest,
            aggregateSeq: 27,
          },
        };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-fresh-preflight',
      purpose: 'trial_plan',
      sessionId: 'session-fresh-preflight',
      inputId: 'input-fresh-preflight',
      submissionMode: 'fresh',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history', 'create', 'prompt']);
    expect(outcome).toMatchObject({
      kind: 'admitted',
      invocationId: 'invocation-fresh-preflight',
      admittedAggregateSeq: 27,
    });
  });

  test('recovers a committed prompt whose response was lost from finite durable history', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"response loss"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    const calls: string[] = [];
    let admissionVisible = false;
    const client: OpenCodeInvocationNativeClient = {
      async listHistory(input) {
        calls.push(`history:${input.sessionId}:${input.after}`);
        if (!admissionVisible) return { records: [], hasMore: false };
        expect(store.getInvocationOutbox('invocation-loss')).toMatchObject({
          status: 'submitted_unknown',
        });
        return {
          records: [
            {
              eventId: 'evt-loss',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-loss',
              inputId: 'input-loss',
              requestDigest,
              aggregateSeq: 19,
            },
          ],
          hasMore: false,
        };
      },
      async createSession(input) {
        calls.push(`create:${input.sessionId}`);
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        calls.push('prompt');
        admissionVisible = true;
        throw new Error('simulated committed response loss containing private prompt bytes');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-loss',
      purpose: 'authoring',
      sessionId: 'session-loss',
      inputId: 'input-loss',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual([
      'history:session-loss:0',
      'create:session-loss',
      'prompt',
      'history:session-loss:0',
    ]);
    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-loss',
      sessionId: 'session-loss',
      inputId: 'input-loss',
      admittedAggregateSeq: 19,
      recoveredFromHistory: true,
    });
    expect(store.getInvocationOutbox('invocation-loss')).toMatchObject({
      status: 'admitted',
      admittedAggregateSeq: 19,
      failureCode: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('private prompt');
  });

  test('accepts a native 409 only when exact durable history proves the same admission', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"duplicate"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    let admissionVisible = false;
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        return {
          records: admissionVisible
            ? [
                {
                  eventId: 'evt-duplicate',
                  type: 'session.next.prompt.admitted',
                  sessionId: 'session-duplicate',
                  inputId: 'input-duplicate',
                  requestDigest,
                  aggregateSeq: 23,
                },
              ]
            : [],
          hasMore: false,
        };
      },
      async createSession(input) {
        calls.push('create');
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        calls.push('prompt:409');
        admissionVisible = true;
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-duplicate',
      purpose: 'authoring',
      sessionId: 'session-duplicate',
      inputId: 'input-duplicate',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history', 'create', 'prompt:409', 'history']);
    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-duplicate',
      sessionId: 'session-duplicate',
      inputId: 'input-duplicate',
      admittedAggregateSeq: 23,
      recoveredFromHistory: true,
    });
    expect(store.getInvocationOutbox('invocation-duplicate')).toMatchObject({
      status: 'admitted',
      admittedAggregateSeq: 23,
    });
  });

  test('fails terminally when durable history owns the Host input id with different bytes', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"expected"}}', 'utf8');
    let admissionVisible = false;
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        return {
          records: admissionVisible
            ? [
                {
                  eventId: 'evt-conflict',
                  type: 'session.next.prompt.admitted',
                  sessionId: 'session-conflict',
                  inputId: 'input-conflict',
                  requestDigest: sha256CanonicalOpenCodeRequest(
                    Buffer.from('{"prompt":{"text":"different"}}', 'utf8'),
                  ),
                  aggregateSeq: 29,
                },
              ]
            : [],
          hasMore: false,
        };
      },
      async createSession(input) {
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        admissionVisible = true;
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      now: () => 1_777_777_777_100,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-conflict',
      purpose: 'authoring',
      sessionId: 'session-conflict',
      inputId: 'input-conflict',
      canonicalRequestBytes: requestBytes,
    });

    expect(outcome).toEqual({
      kind: 'conflict',
      invocationId: 'invocation-conflict',
      code: 'admission_evidence_conflict',
    });
    expect(store.getInvocationOutbox('invocation-conflict')).toMatchObject({
      status: 'failed_terminal',
      admittedAggregateSeq: null,
      settledAt: 1_777_777_777_100,
      failureCode: 'admission_evidence_conflict',
    });
  });

  test('keeps missing response evidence unknown without changing ids or blindly prompting again', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"still unknown"}}', 'utf8');
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory(input) {
        calls.push(`history:${input.sessionId}`);
        return { records: [], hasMore: false };
      },
      async createSession(input) {
        calls.push(`create:${input.sessionId}`);
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt(input) {
        calls.push(`prompt:${input.sessionId}:${input.inputId}`);
        throw new Error('transport failed with a sensitive provider response');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-unknown',
      purpose: 'authoring',
      sessionId: 'session-unknown',
      inputId: 'input-unknown',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual([
      'history:session-unknown',
      'create:session-unknown',
      'prompt:session-unknown:input-unknown',
      'history:session-unknown',
    ]);
    expect(outcome).toEqual({
      kind: 'submitted_unknown',
      invocationId: 'invocation-unknown',
      sessionId: 'session-unknown',
      inputId: 'input-unknown',
      reasonCode: 'admission_prompt_transport_history_missing',
    });
    expect(store.getInvocationOutbox('invocation-unknown')).toMatchObject({
      status: 'submitted_unknown',
      sessionId: 'session-unknown',
      inputId: 'input-unknown',
      admittedAggregateSeq: null,
      settledAt: null,
      failureCode: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('sensitive');
  });

  test('reconciles delayed durable admission evidence before declaring a prompt response unknown', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"delayed admission"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    let historyCalls = 0;
    let promptAttempted = false;
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        historyCalls += 1;
        calls.push(`history:${historyCalls}`);
        if (!promptAttempted || historyCalls < 3) return { records: [], hasMore: false };
        return {
          records: [
            {
              eventId: 'evt-delayed-admission',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-delayed-admission',
              inputId: 'input-delayed-admission',
              requestDigest,
              aggregateSeq: 31,
            },
          ],
          hasMore: false,
        };
      },
      async createSession(input) {
        calls.push('create');
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        calls.push('prompt');
        promptAttempted = true;
        throw new Error('response lost while admission becomes durable');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 3,
      historyReconcileDelayMs: 0,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-delayed-admission',
      purpose: 'trial_plan',
      sessionId: 'session-delayed-admission',
      inputId: 'input-delayed-admission',
      submissionMode: 'fresh',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history:1', 'create', 'prompt', 'history:2', 'history:3']);
    expect(outcome).toMatchObject({
      kind: 'admitted',
      invocationId: 'invocation-delayed-admission',
      admittedAggregateSeq: 31,
      recoveredFromHistory: true,
    });
  });

  test('distinguishes a prompt conflict whose reconciliation history request fails', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"conflict history"}}', 'utf8');
    let historyCalls = 0;
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        historyCalls += 1;
        calls.push(`history:${historyCalls}`);
        if (historyCalls === 1) return { records: [], hasMore: false };
        throw new Error('private conflict reconciliation failure');
      },
      async createSession(input) {
        calls.push('create');
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        calls.push('prompt:conflict');
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-conflict-history',
      purpose: 'trial_plan',
      sessionId: 'session-conflict-history',
      inputId: 'input-conflict-history',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history:1', 'create', 'prompt:conflict', 'history:2']);
    expect(outcome).toEqual({
      kind: 'submitted_unknown',
      invocationId: 'invocation-conflict-history',
      sessionId: 'session-conflict-history',
      inputId: 'input-conflict-history',
      reasonCode: 'admission_prompt_conflict_history_request_failed',
    });
  });

  test('distinguishes restart reconciliation when submitted history is still missing', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"restart unknown"}}', 'utf8');
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-reconcile-missing',
      purpose: 'trial_plan',
      sessionId: 'session-reconcile-missing',
      inputId: 'input-reconcile-missing',
      requestDigest: sha256CanonicalOpenCodeRequest(requestBytes),
    });
    store.updateInvocationOutbox({
      invocationId: 'invocation-reconcile-missing',
      expectedStatus: 'prepared',
      status: 'submitted_unknown',
    });
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        return { records: [], hasMore: false };
      },
      async createSession() {
        calls.push('create');
        throw new Error('create must not run');
      },
      async prompt() {
        calls.push('prompt');
        throw new Error('prompt must not run');
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-reconcile-missing',
      purpose: 'trial_plan',
      sessionId: 'session-reconcile-missing',
      inputId: 'input-reconcile-missing',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history']);
    expect(outcome).toEqual({
      kind: 'submitted_unknown',
      invocationId: 'invocation-reconcile-missing',
      sessionId: 'session-reconcile-missing',
      inputId: 'input-reconcile-missing',
      reasonCode: 'admission_reconcile_history_missing',
    });
  });

  test('restart reconciliation queries prepared history before resubmitting the same Host ids', async () => {
    const { store, workspaceScopeId } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"restart prepared"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-restart',
      purpose: 'authoring',
      sessionId: 'session-restart',
      inputId: 'input-restart',
      requestDigest,
    });
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory(input) {
        calls.push(`history:${input.sessionId}:${input.after}`);
        return { records: [], hasMore: false };
      },
      async createSession(input) {
        calls.push(`create:${input.sessionId}`);
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt(input) {
        calls.push(`prompt:${input.sessionId}:${input.inputId}`);
        expect(input.canonicalRequestBytes).toEqual(requestBytes);
        return {
          kind: 'admitted',
          admission: {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest,
            aggregateSeq: 31,
          },
        };
      },
    };
    const controller = new OpenCodeInvocationController({ store, client });

    const outcomes = await controller.reconcileUnresolved({
      workspaceScopeId,
      requests: [
        {
          invocationId: 'invocation-restart',
          canonicalRequestBytes: requestBytes,
        },
      ],
    });

    expect(calls).toEqual([
      'history:session-restart:0',
      'create:session-restart',
      'prompt:session-restart:input-restart',
    ]);
    expect(outcomes).toEqual([
      {
        kind: 'admitted',
        invocationId: 'invocation-restart',
        sessionId: 'session-restart',
        inputId: 'input-restart',
        admittedAggregateSeq: 31,
        recoveredFromHistory: false,
      },
    ]);
    expect(store.listInvocationOutbox(workspaceScopeId)).toHaveLength(1);
  });

  test('scans unresolved records in durable order and never resubmits submitted-unknown rows', async () => {
    const { store, workspaceScopeId } = openStore();
    const requestA = Buffer.from('{"prompt":{"text":"a"}}', 'utf8');
    const requestB = Buffer.from('{"prompt":{"text":"b"}}', 'utf8');
    const requestZ = Buffer.from('{"prompt":{"text":"z"}}', 'utf8');
    const digestA = sha256CanonicalOpenCodeRequest(requestA);
    const digestB = sha256CanonicalOpenCodeRequest(requestB);
    const digestZ = sha256CanonicalOpenCodeRequest(requestZ);
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-z',
      purpose: 'authoring',
      sessionId: 'session-z',
      inputId: 'input-z',
      requestDigest: digestZ,
      preparedAt: 1_777_777_777_030,
    });
    store.updateInvocationOutbox({
      invocationId: 'invocation-z',
      expectedStatus: 'prepared',
      status: 'submitted_unknown',
    });
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-b',
      purpose: 'authoring',
      sessionId: 'session-b',
      inputId: 'input-b',
      requestDigest: digestB,
      preparedAt: 1_777_777_777_020,
    });
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-a',
      purpose: 'authoring',
      sessionId: 'session-a',
      inputId: 'input-a',
      requestDigest: digestA,
      preparedAt: 1_777_777_777_020,
    });
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory(input) {
        calls.push(`history:${input.sessionId}`);
        if (input.sessionId !== 'session-b') return { records: [], hasMore: false };
        return {
          records: [
            {
              eventId: 'evt-b',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-b',
              inputId: 'input-b',
              requestDigest: digestB,
              aggregateSeq: 42,
            },
          ],
          hasMore: false,
        };
      },
      async createSession(input) {
        calls.push(`create:${input.sessionId}`);
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt(input) {
        calls.push(`prompt:${input.sessionId}:${input.inputId}`);
        return {
          kind: 'admitted',
          admission: {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest: digestA,
            aggregateSeq: 41,
          },
        };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcomes = await controller.reconcileUnresolved({
      workspaceScopeId,
      requests: [
        { invocationId: 'invocation-z', canonicalRequestBytes: requestZ },
        { invocationId: 'invocation-b', canonicalRequestBytes: requestB },
        { invocationId: 'invocation-a', canonicalRequestBytes: requestA },
      ],
    });

    expect(calls).toEqual([
      'history:session-a',
      'create:session-a',
      'prompt:session-a:input-a',
      'history:session-b',
      'history:session-z',
    ]);
    expect(outcomes.map((outcome) => outcome.invocationId)).toEqual([
      'invocation-a',
      'invocation-b',
      'invocation-z',
    ]);
    expect(outcomes).toEqual([
      {
        kind: 'admitted',
        invocationId: 'invocation-a',
        sessionId: 'session-a',
        inputId: 'input-a',
        admittedAggregateSeq: 41,
        recoveredFromHistory: false,
      },
      {
        kind: 'admitted',
        invocationId: 'invocation-b',
        sessionId: 'session-b',
        inputId: 'input-b',
        admittedAggregateSeq: 42,
        recoveredFromHistory: true,
      },
      {
        kind: 'submitted_unknown',
        invocationId: 'invocation-z',
        sessionId: 'session-z',
        inputId: 'input-z',
        reasonCode: 'admission_reconcile_history_missing',
      },
    ]);
  });

  test('rejects same Host ids with different canonical request bytes before any native call', async () => {
    const { store } = openStore();
    const preparedBytes = Buffer.from('{"prompt":{"text":"prepared"}}', 'utf8');
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-digest-conflict',
      purpose: 'authoring',
      sessionId: 'session-digest-conflict',
      inputId: 'input-digest-conflict',
      requestDigest: sha256CanonicalOpenCodeRequest(preparedBytes),
    });
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        return { records: [], hasMore: false };
      },
      async createSession() {
        calls.push('create');
        return { kind: 'created', sessionId: 'session-digest-conflict' };
      },
      async prompt() {
        calls.push('prompt');
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      now: () => 1_777_777_777_100,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-digest-conflict',
      purpose: 'authoring',
      sessionId: 'session-digest-conflict',
      inputId: 'input-digest-conflict',
      canonicalRequestBytes: Buffer.from('{"prompt":{"text":"different"}}', 'utf8'),
    });

    expect(calls).toEqual([]);
    expect(outcome).toEqual({
      kind: 'conflict',
      invocationId: 'invocation-digest-conflict',
      code: 'request_digest_conflict',
    });
    expect(store.getInvocationOutbox('invocation-digest-conflict')).toMatchObject({
      status: 'failed_terminal',
      failureCode: 'request_digest_conflict',
      settledAt: 1_777_777_777_100,
    });
  });

  test('keeps a same-id different-bytes conflict terminal even when prior admission seq remains', async () => {
    const { store } = openStore();
    const originalBytes = Buffer.from('{"prompt":{"text":"original"}}', 'utf8');
    store.prepareInvocationOutbox({
      operationId: 'operation-1',
      invocationId: 'invocation-admitted-conflict',
      purpose: 'authoring',
      sessionId: 'session-admitted-conflict',
      inputId: 'input-admitted-conflict',
      requestDigest: sha256CanonicalOpenCodeRequest(originalBytes),
    });
    store.updateInvocationOutbox({
      invocationId: 'invocation-admitted-conflict',
      expectedStatus: 'prepared',
      status: 'admitted',
      admittedAggregateSeq: 43,
    });
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        calls.push('history');
        return { records: [], hasMore: false };
      },
      async createSession() {
        calls.push('create');
        return { kind: 'conflict' };
      },
      async prompt() {
        calls.push('prompt');
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      now: () => 1_777_777_777_100,
    });

    const conflict = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-admitted-conflict',
      purpose: 'authoring',
      sessionId: 'session-admitted-conflict',
      inputId: 'input-admitted-conflict',
      canonicalRequestBytes: Buffer.from('{"prompt":{"text":"different"}}', 'utf8'),
    });
    const observedAgain = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-admitted-conflict',
      purpose: 'authoring',
      sessionId: 'session-admitted-conflict',
      inputId: 'input-admitted-conflict',
      canonicalRequestBytes: originalBytes,
    });

    expect(calls).toEqual([]);
    expect(conflict).toEqual({
      kind: 'conflict',
      invocationId: 'invocation-admitted-conflict',
      code: 'request_digest_conflict',
    });
    expect(observedAgain).toEqual({
      kind: 'conflict',
      invocationId: 'invocation-admitted-conflict',
      code: 'request_digest_conflict',
    });
    expect(store.getInvocationOutbox('invocation-admitted-conflict')).toMatchObject({
      status: 'failed_terminal',
      admittedAggregateSeq: 43,
      failureCode: 'request_digest_conflict',
    });
  });

  test('uses the exclusive aggregate cursor until finite history finds the admission', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"second page"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    const calls: string[] = [];
    const client: OpenCodeInvocationNativeClient = {
      async listHistory(input) {
        calls.push(`history:${input.after}`);
        if (input.after === 0) {
          return {
            records: [
              {
                eventId: 'evt-context',
                type: 'session.next.context.updated',
                sessionId: 'session-paged',
                inputId: 'other-input',
                requestDigest: sha256CanonicalOpenCodeRequest(Buffer.from('other', 'utf8')),
                aggregateSeq: 5,
              },
            ],
            hasMore: true,
          };
        }
        expect(input.after).toBe(5);
        return {
          records: [
            {
              eventId: 'evt-paged-admission',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-paged',
              inputId: 'input-paged',
              requestDigest,
              aggregateSeq: 9,
            },
          ],
          hasMore: false,
        };
      },
      async createSession() {
        calls.push('unexpected-create');
        throw new Error('history admission must prevent a duplicate create');
      },
      async prompt() {
        calls.push('unexpected-prompt');
        throw new Error('history admission must prevent a duplicate prompt');
      },
    };
    const controller = new OpenCodeInvocationController({ store, client });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-paged',
      purpose: 'authoring',
      sessionId: 'session-paged',
      inputId: 'input-paged',
      canonicalRequestBytes: requestBytes,
    });

    expect(calls).toEqual(['history:0', 'history:5']);
    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-paged',
      sessionId: 'session-paged',
      inputId: 'input-paged',
      admittedAggregateSeq: 9,
      recoveredFromHistory: true,
    });
  });

  test('converges a prepared-to-unknown CAS race onto the exact history admission', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"cas race"}}', 'utf8');
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    let raced = false;
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        if (!raced) {
          raced = true;
          expect(
            store.updateInvocationOutbox({
              invocationId: 'invocation-cas',
              expectedStatus: 'prepared',
              status: 'submitted_unknown',
            }).applied,
          ).toBe(true);
        }
        return {
          records: [
            {
              eventId: 'evt-cas',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-cas',
              inputId: 'input-cas',
              requestDigest,
              aggregateSeq: 47,
            },
          ],
          hasMore: false,
        };
      },
      async createSession() {
        throw new Error('exact history must avoid native resubmission');
      },
      async prompt() {
        throw new Error('exact history must avoid native resubmission');
      },
    };
    const controller = new OpenCodeInvocationController({ store, client });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-cas',
      purpose: 'authoring',
      sessionId: 'session-cas',
      inputId: 'input-cas',
      canonicalRequestBytes: requestBytes,
    });

    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-cas',
      sessionId: 'session-cas',
      inputId: 'input-cas',
      admittedAggregateSeq: 47,
      recoveredFromHistory: true,
    });
    expect(store.getInvocationOutbox('invocation-cas')).toMatchObject({
      status: 'admitted',
      admittedAggregateSeq: 47,
    });
  });

  test('returns a concurrent admission that wins the submitted-unknown CAS', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"unknown cas"}}', 'utf8');
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        expect(
          store.updateInvocationOutbox({
            invocationId: 'invocation-unknown-cas',
            expectedStatus: 'prepared',
            status: 'admitted',
            admittedAggregateSeq: 53,
          }).applied,
        ).toBe(true);
        throw new Error('history transport lost after the concurrent reconciler admitted');
      },
      async createSession() {
        throw new Error('an admitted durable row must prevent create');
      },
      async prompt() {
        throw new Error('an admitted durable row must prevent prompt');
      },
    };
    const controller = new OpenCodeInvocationController({ store, client });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-unknown-cas',
      purpose: 'authoring',
      sessionId: 'session-unknown-cas',
      inputId: 'input-unknown-cas',
      canonicalRequestBytes: requestBytes,
    });

    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-unknown-cas',
      sessionId: 'session-unknown-cas',
      inputId: 'input-unknown-cas',
      admittedAggregateSeq: 53,
      recoveredFromHistory: true,
    });
  });

  test('returns a concurrent admission that wins the terminal-conflict CAS', async () => {
    const { store } = openStore();
    const requestBytes = Buffer.from('{"prompt":{"text":"conflict cas"}}', 'utf8');
    let historyCalls = 0;
    const client: OpenCodeInvocationNativeClient = {
      async listHistory() {
        historyCalls += 1;
        return { records: [], hasMore: false };
      },
      async createSession(input) {
        return { kind: 'created', sessionId: input.sessionId };
      },
      async prompt() {
        expect(
          store.updateInvocationOutbox({
            invocationId: 'invocation-conflict-cas',
            expectedStatus: 'prepared',
            status: 'admitted',
            admittedAggregateSeq: 59,
          }).applied,
        ).toBe(true);
        return { kind: 'conflict' };
      },
    };
    const controller = new OpenCodeInvocationController({
      store,
      client,
      historyReconcileAttempts: 1,
    });

    const outcome = await controller.invoke({
      operationId: 'operation-1',
      invocationId: 'invocation-conflict-cas',
      purpose: 'authoring',
      sessionId: 'session-conflict-cas',
      inputId: 'input-conflict-cas',
      canonicalRequestBytes: requestBytes,
    });

    expect(historyCalls).toBe(2);
    expect(outcome).toEqual({
      kind: 'admitted',
      invocationId: 'invocation-conflict-cas',
      sessionId: 'session-conflict-cas',
      inputId: 'input-conflict-cas',
      admittedAggregateSeq: 59,
      recoveredFromHistory: true,
    });
  });
});
