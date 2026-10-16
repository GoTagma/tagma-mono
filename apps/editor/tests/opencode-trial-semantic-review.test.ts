import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenCodeTrialSemanticReviewRuntime } from '../server/opencode-trial-semantic-review';
import type { OpenCodeAdapterSdkClient } from '../server/chat-operations/opencode-adapter';
import {
  buildTagmaTrialContentReviewerAgent,
  TAGMA_TRIAL_CONTENT_REVIEWER_AGENT,
} from '../server/opencode-seed';

type Prompt = Parameters<OpenCodeAdapterSdkClient['session']['prompt']>[0];
type Result = Awaited<ReturnType<OpenCodeAdapterSdkClient['session']['prompt']>>;

function fixture() {
  const created: string[] = [];
  const prompts: Prompt[] = [];
  const titled: string[] = [];
  const compatAborts: string[] = [];
  const nativeInterrupts: string[] = [];
  let prompt: (input: Prompt, signal?: AbortSignal) => Promise<Result> = async (input) => ({
    response: { status: 200 },
    data: {
      info: { parentID: input.messageID, finish: 'stop' },
      parts: [{ type: 'text', text: '{"version":1,"reviews":[]}' }],
    },
  });
  const sdk: OpenCodeAdapterSdkClient = {
    v2: {
      session: {
        create: async (input) => {
          created.push(input.id);
          return { response: { status: 200 }, data: { data: { id: input.id } } };
        },
        prompt: async () => {
          throw new Error('Review must not enqueue an authoring invocation.');
        },
        history: async () => ({ response: { status: 200 }, data: { data: [], hasMore: false } }),
        interrupt: async (input) => {
          nativeInterrupts.push(input.sessionID);
          return { response: { status: 200 }, data: {} };
        },
      },
    },
    session: {
      update: async (input) => {
        titled.push(input.sessionID);
        return { response: { status: 200 }, data: { id: input.sessionID, title: input.title } };
      },
      prompt: async (input, options) => {
        expect(titled).toContain(input.sessionID);
        prompts.push(input);
        return prompt(input, options?.signal);
      },
      abort: async (input) => {
        compatAborts.push(input.sessionID);
        return { response: { status: 200 }, data: {} };
      },
    },
  };
  const model = { providerID: 'synthetic', modelID: 'content-review', variant: 'off' };
  const runtime = createOpenCodeTrialSemanticReviewRuntime({
    sourceDirectory: join(tmpdir(), 'tagma-semantic-transport', '.tagma'),
    model,
    resolveClient: async () => sdk,
  });
  const invoke = (signal = new AbortController().signal) =>
    runtime.invoke({ system: 'Frozen Host instructions', user: 'Snapshot evidence', signal });
  return {
    runtime,
    model,
    sdk,
    created,
    prompts,
    compatAborts,
    nativeInterrupts,
    invoke,
    setPrompt: (next: typeof prompt) => {
      prompt = next;
    },
  };
}

test('semantic transport uses distinct fresh tool-free sessions and the exact frozen model variant', async () => {
  const f = fixture();
  f.model.modelID = 'caller-mutated-model';
  const first = await f.invoke();
  const second = await f.invoke();
  expect(first.failureCode).toBeNull();
  expect(second.failureCode).toBeNull();
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(f.created).toEqual([first.sessionId, second.sessionId]);
  expect(f.prompts).toHaveLength(2);
  expect(f.prompts[0]).toMatchObject({
    sessionID: first.sessionId,
    agent: TAGMA_TRIAL_CONTENT_REVIEWER_AGENT,
    tools: { '*': false },
    model: { providerID: 'synthetic', modelID: 'content-review' },
    variant: 'off',
    system: 'Frozen Host instructions',
    format: { type: 'text' },
    parts: [{ type: 'text', text: 'Snapshot evidence' }],
  });
  expect(f.prompts[0]!.messageID).not.toBe(f.prompts[1]!.messageID);
  expect(Object.isFrozen(f.runtime)).toBe(true);
  expect(Object.isFrozen(f.runtime.model)).toBe(true);
  const profile = buildTagmaTrialContentReviewerAgent();
  expect(profile).toContain('"*": false');
  expect(profile).toContain('"*": deny');
});

test('semantic transport preserves definitive billing rejection without a second model call', async () => {
  const f = fixture();
  f.setPrompt(async () => ({
    response: { status: 429 },
    error: {
      name: 'APIError',
      data: {
        statusCode: 429,
        isRetryable: false,
        responseBody: JSON.stringify({ error: { code: 'insufficient_quota' } }),
      },
    },
  }));
  const result = await f.invoke();
  expect(result.failureCode).toBe('provider_billing_required');
  expect(result.text).toBe('');
  expect(f.prompts).toHaveLength(1);
});

test('semantic transport cancels only its reviewer session through both native drains', async () => {
  const f = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setPrompt(
    async (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('cancelled fixture')), {
          once: true,
        });
        started();
      }),
  );
  const pending = f.invoke(controller.signal);
  await invoked;
  controller.abort();
  const result = await pending;
  expect(result.failureCode).toBe('provider_invocation_aborted');
  expect(f.compatAborts).toEqual([result.sessionId]);
  expect(f.nativeInterrupts).toEqual([result.sessionId]);
  expect(f.prompts).toHaveLength(1);
});

test('semantic transport rejects session conflicts and mismatched response identities', async () => {
  const f = fixture();
  f.sdk.v2.session.create = async () => ({ response: { status: 409 } });
  expect((await f.invoke()).failureCode).toBe('reviewer_session_conflict');
  expect(f.prompts).toHaveLength(0);
  const other = fixture();
  other.setPrompt(async () => ({
    response: { status: 200 },
    data: {
      info: { parentID: 'msg_unrelated', finish: 'stop' },
      parts: [{ type: 'text', text: '{}' }],
    },
  }));
  expect((await other.invoke()).failureCode).toBe('reviewer_response_identity_mismatch');
});

test('semantic transport does not create an aborted session or expose raw transport errors', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect((await f.invoke(controller.signal)).failureCode).toBe('provider_invocation_aborted');
  expect(f.created).toHaveLength(0);
  expect(f.prompts).toHaveLength(0);
  f.setPrompt(async () => {
    throw new Error('fixture-private-token-must-not-be-returned');
  });
  const result = await f.invoke();
  expect(result.failureCode).toBe('reviewer_transport_unavailable');
  expect(JSON.stringify(result)).not.toContain('fixture-private-token');
});

test('semantic transport fails closed before a model call when fixed session metadata cannot be established', async () => {
  const f = fixture();
  f.sdk.session.update = undefined;
  expect((await f.invoke()).failureCode).toBe('reviewer_transport_unavailable');
  expect(f.prompts).toHaveLength(0);
  const wrong = fixture();
  wrong.sdk.session.update = async () => ({
    response: { status: 200 },
    data: { id: 'other-session', title: 'wrong' },
  });
  expect((await wrong.invoke()).failureCode).toBe('reviewer_transport_unavailable');
  expect(wrong.prompts).toHaveLength(0);
});
