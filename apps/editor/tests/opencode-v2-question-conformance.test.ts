import { createOpencodeClient as createV2OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { ModelV2Info, ProviderV2Info, QuestionV2Request } from '@opencode-ai/sdk/v2/types';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  NO_AUTH_REQUIRED_SENTINEL,
  upsertCustomProvider,
  validateCustomProvider,
} from '../server/opencode-config';
import {
  ensureOpencode,
  restartOpencode,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import {
  OPENCODE_CLASSIFIER_CONFORMANCE_MARKER,
  OPENCODE_CLASSIFIER_CONFORMANCE_RESULT,
  OPENCODE_CLASSIFIER_CONFORMANCE_SYSTEM,
  OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
  OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
  OPENCODE_QUESTION_CONFORMANCE_QUESTIONS,
  OPENCODE_STRUCTURED_OUTPUT_TOOL_ID,
  startOpencodeV2FakeProvider,
  type OpencodeV2FakeProvider,
} from './helpers/opencode-v2-fake-provider';

const ENV_KEYS = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

const CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: { kind: { type: 'string', const: 'discussion' } },
} as const;
function classifierRequest(
  sessionID: string,
  messageID: string,
  text: string,
  allowStructuredOutput = false,
) {
  const tools: Record<string, boolean> = { '*': false };
  if (allowStructuredOutput) tools[OPENCODE_STRUCTURED_OUTPUT_TOOL_ID] = true;
  return {
    sessionID,
    messageID,
    model: {
      providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
      modelID: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
    },
    agent: 'build',
    noReply: false,
    tools,
    format: { type: 'json_schema' as const, schema: CLASSIFIER_SCHEMA },
    system: OPENCODE_CLASSIFIER_CONFORMANCE_SYSTEM,
    parts: [{ type: 'text' as const, text }],
  };
}

type SdkResponse<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

type V2Client = ReturnType<typeof createV2OpencodeClient>;

function restoreEnv(previous: Map<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readSdkData<T>(request: Promise<SdkResponse<T>>, operation: string): Promise<T> {
  const result = await request;
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`);
  }
  if (!result.response.ok) {
    throw new Error(`${operation} returned HTTP ${result.response.status}`);
  }
  if (result.data === undefined) {
    throw new Error(`${operation} returned no data`);
  }
  return result.data;
}

function createClient(
  baseUrl: string,
  directory: string,
  authorization: string,
  throwOnError: boolean,
  requestFetch: typeof fetch = createStreamingLoopbackFetch(baseUrl),
): V2Client {
  return createV2OpencodeClient({
    baseUrl,
    directory,
    headers: { Authorization: authorization },
    fetch: requestFetch,
    throwOnError,
  });
}

type ObservedSdkResponse<T> =
  { kind: 'response'; result: SdkResponse<T> } | { kind: 'throw'; errorName: string };

async function observeSdkResponse<T>(
  request: () => Promise<SdkResponse<T>>,
): Promise<ObservedSdkResponse<T>> {
  try {
    return { kind: 'response', result: await request() };
  } catch (error) {
    return { kind: 'throw', errorName: error instanceof Error ? error.name : typeof error };
  }
}

function sdkErrorTag(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return null;
  return (
    (error as { _tag?: unknown; name?: unknown })._tag ?? (error as { name?: unknown }).name ?? null
  );
}

function expectObservedResponse<T>(
  observed: ObservedSdkResponse<T>,
  status: number,
  operation: string,
): SdkResponse<T> {
  if (observed.kind === 'throw') {
    throw new Error(`${operation} threw ${observed.errorName}`);
  }
  expect(observed.result.response.status).toBe(status);
  return observed.result;
}

function assertExactPendingQuestion(request: QuestionV2Request, sessionID: string): void {
  expect(request).toEqual({
    id: expect.stringMatching(/^que_[A-Za-z0-9]+$/),
    sessionID,
    questions: OPENCODE_QUESTION_CONFORMANCE_QUESTIONS,
    tool: {
      messageID: expect.stringMatching(/^msg_[A-Za-z0-9]+$/),
      callID: expect.stringMatching(/^call_tagma_question_[0-9]+$/),
    },
  });
}

async function waitForPendingQuestion(
  client: V2Client,
  sessionID: string,
  provider: OpencodeV2FakeProvider,
): Promise<QuestionV2Request> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await readSdkData(
      client.v2.session.question.list({ sessionID }),
      'native question.list while waiting',
    );
    if (result.data.length === 1) return result.data[0]!;
    if (result.data.length > 1) {
      throw new Error(
        `native question.list returned ${result.data.length} requests; provider diagnostics=${JSON.stringify(provider.diagnostics())}`,
      );
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `native question request was not created; provider diagnostics=${JSON.stringify(provider.diagnostics())}`,
  );
}

function providerTurnDiagnostics(provider: OpencodeV2FakeProvider) {
  return provider
    .diagnostics()
    .filter((entry) => entry.transport === 'chat-completions' || entry.transport === 'responses');
}

function classifierProviderTurns(provider: OpencodeV2FakeProvider) {
  return providerTurnDiagnostics(provider).filter((entry) => entry.turnShape === 'classifier');
}

async function waitForExpectedAnswer(provider: OpencodeV2FakeProvider): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      providerTurnDiagnostics(provider).some(
        (entry) => entry.turnShape === 'tool-result' && entry.expectedAnswerObserved === true,
      )
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `native question answer did not reach the provider; provider diagnostics=${JSON.stringify(provider.diagnostics())}`,
  );
}

async function expectNoPendingQuestions(
  client: V2Client,
  sessionID: string,
  directory: string,
): Promise<void> {
  expect(
    (
      await readSdkData(
        client.v2.session.question.list({ sessionID }),
        'native session question list after first response',
      )
    ).data,
  ).toEqual([]);
  expect(
    (
      await readSdkData(
        client.v2.question.request.list({ location: { directory } }),
        'native global question list after first response',
      )
    ).data,
  ).toEqual([]);
}

async function createPendingQuestion(
  client: V2Client,
  directory: string,
  suffix: string,
  provider: OpencodeV2FakeProvider,
): Promise<{ sessionID: string; admittedSeq: number; request: QuestionV2Request }> {
  const sessionID = `ses_tagma_question_${suffix}`;
  const created = (
    await readSdkData(
      client.v2.session.create({
        id: sessionID,
        agent: 'build',
        model: {
          providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
          id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
        },
        location: { directory },
      }),
      'native session.create for question conformance',
    )
  ).data;
  expect(created.id).toBe(sessionID);
  expect(created.agent).toBe('build');

  const admitted = (
    await readSdkData(
      client.v2.session.prompt({
        sessionID,
        id: `msg_tagma_question_${suffix}`,
        prompt: {
          text: 'Invoke the built-in question tool exactly once and wait for the selected option.',
        },
        delivery: 'queue',
        resume: true,
      }),
      'native session.prompt for question conformance',
    )
  ).data;
  expect(admitted.sessionID).toBe(sessionID);
  expect(admitted.admittedSeq).toBeGreaterThan(0);

  const request = await waitForPendingQuestion(client, sessionID, provider);
  assertExactPendingQuestion(request, sessionID);
  return { sessionID, admittedSeq: admitted.admittedSeq, request };
}

async function waitForNativeQuestionModel(
  client: V2Client,
  directory: string,
): Promise<{ provider: ProviderV2Info; model: ModelV2Info }> {
  const deadline = Date.now() + 30_000;
  let providerCount = 0;
  let modelCount = 0;
  while (Date.now() < deadline) {
    const nativeProviders = await readSdkData(
      client.v2.provider.list({ location: { directory } }),
      'native provider.list for question conformance',
    );
    const nativeModels = await readSdkData(
      client.v2.model.list({ location: { directory } }),
      'native model.list for question conformance',
    );
    providerCount = nativeProviders.data.length;
    modelCount = nativeModels.data.length;
    const provider = nativeProviders.data.find(
      (entry) => entry.id === OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
    );
    const model = nativeModels.data.find(
      (entry) =>
        entry.providerID === OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID &&
        entry.id === OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
    );
    if (provider && model) return { provider, model };
    await Bun.sleep(100);
  }
  throw new Error(
    `native question model was not configured; providerCount=${providerCount} modelCount=${modelCount}`,
  );
}

function expectQuestionNotFound(result: SdkResponse<unknown>): void {
  expect(result.response.status).toBe(404);
  expect(result.error).toMatchObject({ _tag: 'QuestionNotFoundError' });
}

if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('pinned OpenCode preserves question, text, and legacy schema conformance boundaries', async () => {
    const electronPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', '..', 'electron', 'package.json'), 'utf8'),
    ) as {
      tagma?: {
        bundledOpencodeVersion?: unknown;
        bundledOpencodeDbSchemaVersion?: unknown;
      };
    };
    const expectedVersion = electronPackage.tagma?.bundledOpencodeVersion;
    if (expectedVersion !== '1.18.18') {
      throw new Error('Electron package must pin bundled OpenCode 1.18.18');
    }
    const expectedDbSchemaVersion = electronPackage.tagma?.bundledOpencodeDbSchemaVersion;
    if (
      typeof expectedDbSchemaVersion !== 'number' ||
      !Number.isSafeInteger(expectedDbSchemaVersion) ||
      expectedDbSchemaVersion < 1
    ) {
      throw new Error(
        'Electron package must define tagma.bundledOpencodeDbSchemaVersion as a positive integer',
      );
    }

    const root = mkdtempSync(join(tmpdir(), 'tagma-opencode-v2-question-'));
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const stagedRuntimeDir = resolve(
      import.meta.dirname,
      '..',
      '..',
      'electron',
      'build',
      'opencode',
      `${process.platform}-${process.arch}`,
    );
    const bundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR ?? stagedRuntimeDir;
    const executable = join(
      bundledDir,
      'bin',
      process.platform === 'win32' ? 'opencode.exe' : 'opencode',
    );
    const provider = startOpencodeV2FakeProvider();

    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'database-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = String(expectedDbSchemaVersion);
    process.env.XDG_CACHE_HOME = join(root, 'xdg-cache');
    process.env.XDG_CONFIG_HOME = join(root, 'xdg-config');
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    process.env.XDG_STATE_HOME = join(root, 'xdg-state');

    try {
      expect(existsSync(executable)).toBe(true);
      expect(readFileSync(join(bundledDir, 'version.txt'), 'utf8').trim()).toBe(expectedVersion);

      const workspaceRoot = join(root, 'workspace');
      const tagmaCwdPath = join(workspaceRoot, '.tagma');
      mkdirSync(tagmaCwdPath, { recursive: true });
      const tagmaCwd = realpathSync.native(tagmaCwdPath);
      expect(seedOpencodeArtifacts(tagmaCwd)).toBe(true);

      const handle = await ensureOpencode(tagmaCwd);
      let client = createClient(handle.baseUrl, tagmaCwd, handle.auth.authorization, true);
      let noThrowClient = createClient(handle.baseUrl, tagmaCwd, handle.auth.authorization, false);
      const providerDef = validateCustomProvider(
        OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
        {
          name: 'Tagma question conformance',
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: provider.baseUrl,
            apiKey: NO_AUTH_REQUIRED_SENTINEL,
            chunkTimeout: 30_000,
          },
          models: {
            [OPENCODE_QUESTION_CONFORMANCE_MODEL_ID]: {
              name: 'Question conformance model',
              limit: { context: 8_192, output: 512 },
              tool_call: true,
              modalities: { input: ['text'], output: ['text'] },
            },
          },
        },
        { scope: 'workspace' },
      );
      upsertCustomProvider(
        'workspace',
        workspaceRoot,
        OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
        providerDef,
      );
      // Rebuild the Location after readiness so 1.18.18's native catalog
      // consumes the isolated provider config through its config bridge.
      expect(
        await readSdkData(
          client.instance.dispose({ directory: tagmaCwd }),
          'dispose native instance after installing v2 question config',
        ),
      ).toBe(true);
      const { provider: configuredProvider, model: configuredModel } =
        await waitForNativeQuestionModel(client, tagmaCwd);
      expect(configuredProvider).toMatchObject({
        id: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
        api: { type: 'aisdk', package: '@ai-sdk/openai-compatible', url: provider.baseUrl },
      });
      expect(configuredModel).toMatchObject({
        id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
        providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
        enabled: true,
        capabilities: { tools: true },
      });
      const suffix = randomUUID().replace(/-/g, '');

      const classifierSessionID = `ses_tagma_classifier_${suffix}`;
      const classifierMessageID = `msg_tagma_classifier_${suffix}`;
      await readSdkData(
        client.v2.session.create({
          id: classifierSessionID,
          agent: 'build',
          model: {
            providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
            id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          },
          location: { directory: tagmaCwd },
        }),
        'native classifier session.create with Host id',
      );
      await readSdkData(
        client.session.update({
          sessionID: classifierSessionID,
          title: 'Tagma classifier conformance',
        }),
        'compatibility classifier session title update',
      );
      const directClassifierTurnsBefore = classifierProviderTurns(provider);
      const directClassifierRequest = classifierRequest(
        classifierSessionID,
        classifierMessageID,
        `${OPENCODE_CLASSIFIER_CONFORMANCE_MARKER}: classify as discussion.`,
      );
      expect(directClassifierRequest.format).not.toHaveProperty('retryCount');
      const classifierResponse = await readSdkData(
        client.session.prompt(directClassifierRequest),
        'compatibility structured classifier prompt',
      );
      expect(classifierResponse.info).toMatchObject({
        role: 'assistant',
        parentID: classifierMessageID,
        error: {
          name: 'StructuredOutputError',
          data: { retries: 0 },
        },
      });
      expect(classifierResponse.info.structured).toBeUndefined();
      const directClassifierTurnsAfter = classifierProviderTurns(provider);
      expect(directClassifierTurnsAfter).toHaveLength(directClassifierTurnsBefore.length + 1);
      expect(directClassifierTurnsAfter.at(-1)).toMatchObject({
        transport: 'chat-completions',
        stream: true,
        toolCount: 0,
        inputShape: 'messages',
        structuredFormat: false,
        formatShape: 'none',
        classifierMarkerObserved: true,
        structuredOutputToolOffered: false,
        classifierResultKind: OPENCODE_CLASSIFIER_CONFORMANCE_RESULT.kind,
        status: 200,
      });

      const enabledClassifierSessionID = `ses_tagma_classifier_enabled_${suffix}`;
      const enabledClassifierMessageID = `msg_tagma_classifier_enabled_${suffix}`;
      await readSdkData(
        client.v2.session.create({
          id: enabledClassifierSessionID,
          agent: 'build',
          model: {
            providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
            id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          },
          location: { directory: tagmaCwd },
        }),
        'native enabled classifier session.create with Host id',
      );
      await readSdkData(
        client.session.update({
          sessionID: enabledClassifierSessionID,
          title: 'Tagma enabled classifier conformance',
        }),
        'compatibility enabled classifier session title update',
      );
      const enabledClassifierRequest = classifierRequest(
        enabledClassifierSessionID,
        enabledClassifierMessageID,
        `${OPENCODE_CLASSIFIER_CONFORMANCE_MARKER}: classify the enabled request as discussion.`,
        true,
      );
      expect(enabledClassifierRequest.tools).toEqual({
        '*': false,
        [OPENCODE_STRUCTURED_OUTPUT_TOOL_ID]: true,
      });
      expect(enabledClassifierRequest.format).not.toHaveProperty('retryCount');
      const enabledClassifierTurnsBefore = classifierProviderTurns(provider);
      const enabledClassifierResponse = await readSdkData(
        client.session.prompt(enabledClassifierRequest),
        'compatibility enabled structured classifier prompt',
      );
      expect(enabledClassifierResponse.info.error).toBeUndefined();
      expect(enabledClassifierResponse.info).toMatchObject({
        role: 'assistant',
        parentID: enabledClassifierMessageID,
        structured: OPENCODE_CLASSIFIER_CONFORMANCE_RESULT,
      });
      const enabledClassifierTurnsAfter = classifierProviderTurns(provider);
      expect(enabledClassifierTurnsAfter).toHaveLength(enabledClassifierTurnsBefore.length + 1);
      expect(enabledClassifierTurnsAfter.at(-1)).toMatchObject({
        transport: 'chat-completions',
        stream: true,
        toolCount: 1,
        inputShape: 'messages',
        classifierMarkerObserved: true,
        structuredOutputToolOffered: true,
        classifierResultKind: OPENCODE_CLASSIFIER_CONFORMANCE_RESULT.kind,
        status: 200,
      });

      const lostClassifierSessionID = `ses_tagma_classifier_lost_${suffix}`;
      const lostClassifierMessageID = `msg_tagma_classifier_lost_${suffix}`;
      const lostClassifierText = `${OPENCODE_CLASSIFIER_CONFORMANCE_MARKER}: classify the response-loss request as discussion.`;
      await readSdkData(
        client.v2.session.create({
          id: lostClassifierSessionID,
          agent: 'build',
          model: {
            providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
            id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          },
          location: { directory: tagmaCwd },
        }),
        'native response-loss classifier session.create with Host id',
      );
      await readSdkData(
        client.session.update({
          sessionID: lostClassifierSessionID,
          title: 'Tagma response-loss classifier conformance',
        }),
        'compatibility response-loss classifier session title update',
      );
      const lostClassifierRequest = classifierRequest(
        lostClassifierSessionID,
        lostClassifierMessageID,
        lostClassifierText,
        true,
      );
      const classifierTurnsBeforeLoss = classifierProviderTurns(provider);
      const loopbackFetch = createStreamingLoopbackFetch(handle.baseUrl);
      let responseDropped = false;
      let droppedProjection:
        { parentID: unknown; structured: unknown; errorName: unknown } | undefined;
      const responseDroppingFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await loopbackFetch(input, init);
        const request = new Request(input, init);
        if (
          !responseDropped &&
          request.method === 'POST' &&
          new URL(request.url).pathname === `/session/${lostClassifierSessionID}/message`
        ) {
          responseDropped = true;
          const payload = (await response.clone().json()) as {
            info?: { parentID?: unknown; structured?: unknown; error?: { name?: unknown } };
          };
          droppedProjection = {
            parentID: payload.info?.parentID,
            structured: payload.info?.structured,
            errorName: payload.info?.error?.name,
          };
          await response.arrayBuffer();
          throw new Error('simulated committed classifier response loss');
        }
        return response;
      }) as typeof fetch;
      responseDroppingFetch.preconnect = fetch.preconnect.bind(fetch);
      const responseDroppingClient = createClient(
        handle.baseUrl,
        tagmaCwd,
        handle.auth.authorization,
        true,
        responseDroppingFetch,
      );
      let lostResponseError: unknown = null;
      try {
        await responseDroppingClient.session.prompt(lostClassifierRequest);
      } catch (error) {
        lostResponseError = error;
      }
      expect(responseDropped).toBe(true);
      expect(lostResponseError).toBeInstanceOf(Error);
      expect(droppedProjection).toEqual({
        parentID: lostClassifierMessageID,
        structured: OPENCODE_CLASSIFIER_CONFORMANCE_RESULT,
        errorName: undefined,
      });
      const classifierTurnsAfterLoss = classifierProviderTurns(provider);
      expect(classifierTurnsAfterLoss).toHaveLength(classifierTurnsBeforeLoss.length + 1);
      expect(classifierTurnsAfterLoss.at(-1)).toMatchObject({
        toolCount: 1,
        structuredOutputToolOffered: true,
        classifierResultKind: OPENCODE_CLASSIFIER_CONFORMANCE_RESULT.kind,
        status: 200,
      });

      const duplicateLostClassifier = await noThrowClient.session.prompt(lostClassifierRequest);
      expect(duplicateLostClassifier.response.status).toBe(200);
      expect(duplicateLostClassifier.error).toBeUndefined();
      expect(duplicateLostClassifier.data?.info).toMatchObject({
        parentID: lostClassifierMessageID,
        error: {
          name: 'StructuredOutputError',
          data: { retries: 0 },
        },
      });
      expect(duplicateLostClassifier.data?.info.structured).toBeUndefined();
      expect(classifierProviderTurns(provider)).toEqual(classifierTurnsAfterLoss);
      const conflictingLostClassifier = await noThrowClient.session.prompt({
        ...lostClassifierRequest,
        parts: [{ type: 'text', text: `${lostClassifierText}\nconflicting bytes` }],
      });
      expect(conflictingLostClassifier.response.status).toBe(200);
      expect(conflictingLostClassifier.error).toBeUndefined();
      expect(conflictingLostClassifier.data?.info).toMatchObject({
        parentID: lostClassifierMessageID,
        error: {
          name: 'StructuredOutputError',
          data: { retries: 0 },
        },
      });
      expect(conflictingLostClassifier.data?.info.structured).toBeUndefined();
      expect(classifierProviderTurns(provider)).toEqual(classifierTurnsAfterLoss);
      expect(classifierTurnsAfterLoss).toHaveLength(3);

      let lostClassifierHistory = await readSdkData(
        client.v2.session.history({
          sessionID: lostClassifierSessionID,
          after: 0,
          limit: 100,
        }),
        'native history after compatibility classifier response loss',
      );
      const historyDeadline = Date.now() + 5_000;
      while (lostClassifierHistory.data.length === 0 && Date.now() < historyDeadline) {
        await Bun.sleep(50);
        lostClassifierHistory = await readSdkData(
          client.v2.session.history({
            sessionID: lostClassifierSessionID,
            after: 0,
            limit: 100,
          }),
          'native history while awaiting compatibility classifier projection',
        );
      }
      const lostClassifierPrompted = lostClassifierHistory.data.filter(
        (event) =>
          event.type === 'session.next.prompted' &&
          event.data.messageID === lostClassifierMessageID,
      );
      const lostClassifierAdmitted = lostClassifierHistory.data.filter(
        (event) =>
          event.type === 'session.next.prompt.admitted' &&
          event.data.messageID === lostClassifierMessageID,
      );
      const nativeLostMessage = await observeSdkResponse(() =>
        noThrowClient.v2.session.message({
          sessionID: lostClassifierSessionID,
          messageID: lostClassifierMessageID,
        }),
      );
      const nativeLostMessages = await observeSdkResponse(() =>
        noThrowClient.v2.session.messages({ sessionID: lostClassifierSessionID, limit: 100 }),
      );
      const compatibilityLostMessage = await observeSdkResponse(() =>
        noThrowClient.session.message({
          sessionID: lostClassifierSessionID,
          messageID: lostClassifierMessageID,
        }),
      );
      const compatibilityLostMessages = await observeSdkResponse(() =>
        noThrowClient.session.messages({ sessionID: lostClassifierSessionID, limit: 100 }),
      );
      const compatibilitySessionList = await observeSdkResponse(() =>
        noThrowClient.session.list({ limit: 100 }),
      );
      const compatibilitySessionStatus = await observeSdkResponse(() =>
        noThrowClient.session.status(),
      );
      expect(lostClassifierPrompted).toEqual([]);
      expect(lostClassifierAdmitted).toEqual([]);
      expect(lostClassifierHistory.data).toEqual([]);

      // The one successful rich response has no public durable message
      // projection. Only the session identity remains readable; message-level
      // recovery cannot prove the rich envelope or its exactly-once result.

      const nativeLostMessageResult = expectObservedResponse(
        nativeLostMessage,
        404,
        'native classifier message read before restart',
      );
      expect(sdkErrorTag(nativeLostMessageResult.error)).toBe('MessageNotFoundError');
      const nativeLostMessagesResult = expectObservedResponse(
        nativeLostMessages,
        200,
        'native classifier messages read before restart',
      );
      expect(nativeLostMessagesResult.error).toBeUndefined();
      expect(nativeLostMessagesResult.data?.data).toEqual([]);

      const compatibilityLostMessageResult = expectObservedResponse(
        compatibilityLostMessage,
        400,
        'compatibility classifier message read before restart',
      );
      expect(sdkErrorTag(compatibilityLostMessageResult.error)).toBe('BadRequest');
      const compatibilityLostMessagesResult = expectObservedResponse(
        compatibilityLostMessages,
        400,
        'compatibility classifier messages read before restart',
      );
      expect(sdkErrorTag(compatibilityLostMessagesResult.error)).toBe('BadRequest');

      const compatibilitySessionListResult = expectObservedResponse(
        compatibilitySessionList,
        200,
        'compatibility classifier session list before restart',
      );
      expect(
        compatibilitySessionListResult.data?.some(
          (session) => session.id === lostClassifierSessionID,
        ),
      ).toBe(true);
      const compatibilitySessionStatusResult = expectObservedResponse(
        compatibilitySessionStatus,
        200,
        'compatibility classifier session status before restart',
      );
      expect(compatibilitySessionStatusResult.data?.[lostClassifierSessionID]).toBeUndefined();

      const textSessionID = `ses_tagma_text_${suffix}`;
      const textMessageID = `msg_tagma_text_${suffix}`;
      await readSdkData(
        client.v2.session.create({
          id: textSessionID,
          agent: 'build',
          model: {
            providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
            id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          },
          location: { directory: tagmaCwd },
        }),
        'native text session.create with Host id',
      );
      await readSdkData(
        client.session.update({
          sessionID: textSessionID,
          title: 'Tagma text-readonly conformance',
        }),
        'compatibility text session title update',
      );
      const textRequest = {
        ...classifierRequest(
          textSessionID,
          textMessageID,
          `${OPENCODE_CLASSIFIER_CONFORMANCE_MARKER}: return a read-only discussion response.`,
        ),
        format: { type: 'text' as const },
      };
      const textTurnsBefore = classifierProviderTurns(provider);
      const textResponse = await readSdkData(
        client.session.prompt(textRequest),
        'compatibility tool-free text prompt',
      );
      expect(textResponse.info.error).toBeUndefined();
      expect(textResponse.info.structured).toBeUndefined();
      expect(
        textResponse.parts.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes(JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT)),
        ),
      ).toBe(true);
      expect(classifierProviderTurns(provider)).toHaveLength(textTurnsBefore.length + 1);
      const textMessageBeforeRestart = await observeSdkResponse(() =>
        noThrowClient.session.message({ sessionID: textSessionID, messageID: textMessageID }),
      );
      const textMessagesBeforeRestart = await observeSdkResponse(() =>
        noThrowClient.session.messages({ sessionID: textSessionID, limit: 100 }),
      );
      expectObservedResponse(
        textMessageBeforeRestart,
        400,
        'compatibility text message before restart',
      );
      const textMessagesBeforeRestartResult = expectObservedResponse(
        textMessagesBeforeRestart,
        400,
        'compatibility text messages before restart',
      );
      expect(sdkErrorTag(textMessagesBeforeRestartResult.error)).toBe('BadRequest');

      const lostTextSessionID = `ses_tagma_text_lost_${suffix}`;
      const lostTextMessageID = `msg_tagma_text_lost_${suffix}`;
      const lostTextPrompt = `${OPENCODE_CLASSIFIER_CONFORMANCE_MARKER}: return the response-loss read-only discussion.`;
      await readSdkData(
        client.v2.session.create({
          id: lostTextSessionID,
          agent: 'build',
          model: {
            providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
            id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          },
          location: { directory: tagmaCwd },
        }),
        'native response-loss text session.create with Host id',
      );
      await readSdkData(
        client.session.update({
          sessionID: lostTextSessionID,
          title: 'Tagma response-loss text conformance',
        }),
        'compatibility response-loss text session title update',
      );
      const lostTextRequest = {
        ...classifierRequest(lostTextSessionID, lostTextMessageID, lostTextPrompt),
        format: { type: 'text' as const },
      };
      const textTurnsBeforeLoss = classifierProviderTurns(provider);
      const textLoopbackFetch = createStreamingLoopbackFetch(handle.baseUrl);
      let textResponseDropped = false;
      let droppedTextProjection: { parentID: unknown; text: string | null } | undefined;
      const textResponseDroppingFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await textLoopbackFetch(input, init);
        const request = new Request(input, init);
        if (
          !textResponseDropped &&
          request.method === 'POST' &&
          new URL(request.url).pathname === `/session/${lostTextSessionID}/message`
        ) {
          textResponseDropped = true;
          const payload = (await response.clone().json()) as {
            info?: { parentID?: unknown };
            parts?: Array<{ type?: unknown; text?: unknown }>;
          };
          droppedTextProjection = {
            parentID: payload.info?.parentID,
            text:
              (payload.parts?.find((part) => part.type === 'text' && typeof part.text === 'string')
                ?.text as string | undefined) ?? null,
          };
          await response.arrayBuffer();
          throw new Error('simulated committed text response loss');
        }
        return response;
      }) as typeof fetch;
      textResponseDroppingFetch.preconnect = fetch.preconnect.bind(fetch);
      const textResponseDroppingClient = createClient(
        handle.baseUrl,
        tagmaCwd,
        handle.auth.authorization,
        true,
        textResponseDroppingFetch,
      );
      let lostTextResponseError: unknown = null;
      try {
        await textResponseDroppingClient.session.prompt(lostTextRequest);
      } catch (error) {
        lostTextResponseError = error;
      }
      expect(textResponseDropped).toBe(true);
      expect(lostTextResponseError).toBeInstanceOf(Error);
      expect(droppedTextProjection?.parentID).toBe(lostTextMessageID);
      expect(droppedTextProjection?.text).toContain(
        JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT),
      );
      const textTurnsAfterLoss = classifierProviderTurns(provider);
      expect(textTurnsAfterLoss).toHaveLength(textTurnsBeforeLoss.length + 1);

      const duplicateLostText = await noThrowClient.session.prompt(lostTextRequest);
      expect(duplicateLostText.response.status).toBe(200);
      expect(duplicateLostText.error).toBeUndefined();
      expect(duplicateLostText.data?.info.error).toBeUndefined();
      expect(
        duplicateLostText.data?.parts.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes(JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT)),
        ),
      ).toBe(true);
      expect(classifierProviderTurns(provider)).toEqual(textTurnsAfterLoss);
      const conflictingLostText = await noThrowClient.session.prompt({
        ...lostTextRequest,
        parts: [{ type: 'text', text: `${lostTextPrompt}\nconflicting bytes` }],
      });
      expect(conflictingLostText.response.status).toBe(200);
      expect(conflictingLostText.error).toBeUndefined();
      expect(conflictingLostText.data?.info.error).toBeUndefined();
      expect(classifierProviderTurns(provider)).toEqual(textTurnsAfterLoss);
      expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.session.messages({ sessionID: lostTextSessionID, limit: 100 }),
        ),
        400,
        'compatibility response-loss text messages before restart',
      );

      const replyFirst = await createPendingQuestion(client, tagmaCwd, `reply${suffix}`, provider);
      const replied = await noThrowClient.v2.session.question.reply({
        sessionID: replyFirst.sessionID,
        requestID: replyFirst.request.id,
        questionV2Reply: { answers: [['Alpha']] },
      });
      expect(replied.response.status).toBe(204);
      expect(replied.error).toBeUndefined();
      await expectNoPendingQuestions(client, replyFirst.sessionID, tagmaCwd);
      await waitForExpectedAnswer(provider);
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reply({
          sessionID: replyFirst.sessionID,
          requestID: replyFirst.request.id,
          questionV2Reply: { answers: [['Alpha']] },
        }),
      );
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reject({
          sessionID: replyFirst.sessionID,
          requestID: replyFirst.request.id,
        }),
      );

      const rejectFirst = await createPendingQuestion(
        client,
        tagmaCwd,
        `reject${suffix}`,
        provider,
      );
      const rejected = await noThrowClient.v2.session.question.reject({
        sessionID: rejectFirst.sessionID,
        requestID: rejectFirst.request.id,
      });
      expect(rejected.response.status).toBe(204);
      expect(rejected.error).toBeUndefined();
      await expectNoPendingQuestions(client, rejectFirst.sessionID, tagmaCwd);
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reject({
          sessionID: rejectFirst.sessionID,
          requestID: rejectFirst.request.id,
        }),
      );
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reply({
          sessionID: rejectFirst.sessionID,
          requestID: rejectFirst.request.id,
          questionV2Reply: { answers: [['Beta']] },
        }),
      );

      const restartPending = await createPendingQuestion(
        client,
        tagmaCwd,
        `restart${suffix}`,
        provider,
      );
      const globalPendingBeforeRestart = await readSdkData(
        client.v2.question.request.list({ location: { directory: tagmaCwd } }),
        'native global question request list before restart',
      );
      expect(globalPendingBeforeRestart.data).toEqual([restartPending.request]);
      const historyBeforeRestart = await readSdkData(
        client.v2.session.history({ sessionID: restartPending.sessionID, after: 0, limit: 100 }),
        'native session history before question restart',
      );
      const admittedBeforeRestart = historyBeforeRestart.data.find(
        (event) =>
          event.type === 'session.next.prompt.admitted' &&
          event.durable?.seq === restartPending.admittedSeq,
      );
      expect(admittedBeforeRestart).toBeDefined();
      const toolCallBeforeRestart = historyBeforeRestart.data.find(
        (event) =>
          event.type === 'session.next.tool.called' &&
          event.data.callID === restartPending.request.tool?.callID,
      );
      expect(toolCallBeforeRestart).toBeDefined();
      const providerTurnsBeforeRestart = providerTurnDiagnostics(provider);

      const restartedHandle = await restartOpencode(tagmaCwd);
      client = createClient(
        restartedHandle.baseUrl,
        tagmaCwd,
        restartedHandle.auth.authorization,
        true,
      );
      noThrowClient = createClient(
        restartedHandle.baseUrl,
        tagmaCwd,
        restartedHandle.auth.authorization,
        false,
      );

      const restartedClassifierHistory = await readSdkData(
        client.v2.session.history({
          sessionID: lostClassifierSessionID,
          after: 0,
          limit: 100,
        }),
        'native classifier history after restart',
      );
      expect(restartedClassifierHistory.data).toEqual([]);

      const restartedNativeClassifierMessage = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.v2.session.message({
            sessionID: lostClassifierSessionID,
            messageID: lostClassifierMessageID,
          }),
        ),
        404,
        'native classifier message read after restart',
      );
      expect(sdkErrorTag(restartedNativeClassifierMessage.error)).toBe('MessageNotFoundError');
      const restartedNativeClassifierMessages = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.v2.session.messages({ sessionID: lostClassifierSessionID, limit: 100 }),
        ),
        200,
        'native classifier messages read after restart',
      );
      expect(restartedNativeClassifierMessages.data?.data).toEqual([]);

      const restartedCompatibilityClassifierMessage = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.session.message({
            sessionID: lostClassifierSessionID,
            messageID: lostClassifierMessageID,
          }),
        ),
        400,
        'compatibility classifier message read after restart',
      );
      expect(sdkErrorTag(restartedCompatibilityClassifierMessage.error)).toBe('BadRequest');
      const restartedCompatibilityClassifierMessages = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.session.messages({ sessionID: lostClassifierSessionID, limit: 100 }),
        ),
        400,
        'compatibility classifier messages read after restart',
      );
      expect(sdkErrorTag(restartedCompatibilityClassifierMessages.error)).toBe('BadRequest');
      const restartedCompatibilitySessionList = expectObservedResponse(
        await observeSdkResponse(() => noThrowClient.session.list({ limit: 100 })),
        200,
        'compatibility classifier session list after restart',
      );
      expect(
        restartedCompatibilitySessionList.data?.some(
          (session) => session.id === lostClassifierSessionID,
        ),
      ).toBe(true);
      const restartedCompatibilitySessionStatus = expectObservedResponse(
        await observeSdkResponse(() => noThrowClient.session.status()),
        200,
        'compatibility classifier session status after restart',
      );
      expect(restartedCompatibilitySessionStatus.data?.[lostClassifierSessionID]).toBeUndefined();

      const restartedTextMessage = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.session.message({ sessionID: textSessionID, messageID: textMessageID }),
        ),
        400,
        'compatibility text message after restart',
      );
      expect(sdkErrorTag(restartedTextMessage.error)).toBe('BadRequest');
      const restartedTextMessages = expectObservedResponse(
        await observeSdkResponse(() =>
          noThrowClient.session.messages({ sessionID: textSessionID, limit: 100 }),
        ),
        400,
        'compatibility text messages after restart',
      );
      expect(sdkErrorTag(restartedTextMessages.error)).toBe('BadRequest');

      const textTurnsBeforeRestartRetries = classifierProviderTurns(provider);
      const restartedDuplicateText = await noThrowClient.session.prompt(lostTextRequest);
      expect(restartedDuplicateText.response.status).toBe(200);
      expect(restartedDuplicateText.error).toBeUndefined();
      expect(restartedDuplicateText.data?.info.error).toBeUndefined();
      expect(
        restartedDuplicateText.data?.parts.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes(JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT)),
        ),
      ).toBe(true);
      const restartedConflictingText = await noThrowClient.session.prompt({
        ...lostTextRequest,
        parts: [{ type: 'text', text: `${lostTextPrompt}\npost-restart conflicting bytes` }],
      });
      expect(restartedConflictingText.response.status).toBe(200);
      expect(restartedConflictingText.error).toBeUndefined();
      expect(classifierProviderTurns(provider)).toEqual(textTurnsBeforeRestartRetries);

      const classifierTurnsBeforeRestartRetries = classifierProviderTurns(provider);
      const restartedDuplicateClassifier =
        await noThrowClient.session.prompt(lostClassifierRequest);
      expect(restartedDuplicateClassifier.response.status).toBe(200);
      expect(restartedDuplicateClassifier.data?.info).toMatchObject({
        parentID: lostClassifierMessageID,
        error: {
          name: 'StructuredOutputError',
          data: { retries: 0 },
        },
      });
      const restartedConflictingClassifier = await noThrowClient.session.prompt({
        ...lostClassifierRequest,
        parts: [{ type: 'text', text: `${lostClassifierText}\npost-restart conflicting bytes` }],
      });
      expect(restartedConflictingClassifier.response.status).toBe(200);
      expect(restartedConflictingClassifier.data?.info).toMatchObject({
        parentID: lostClassifierMessageID,
        error: {
          name: 'StructuredOutputError',
          data: { retries: 0 },
        },
      });
      expect(classifierProviderTurns(provider)).toEqual(classifierTurnsBeforeRestartRetries);

      expect(
        (
          await readSdkData(
            client.v2.session.question.list({ sessionID: restartPending.sessionID }),
            'native session question list after restart',
          )
        ).data,
      ).toEqual([]);
      expect(
        (
          await readSdkData(
            client.v2.question.request.list({ location: { directory: tagmaCwd } }),
            'native global question request list after restart',
          )
        ).data,
      ).toEqual([]);
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reply({
          sessionID: restartPending.sessionID,
          requestID: restartPending.request.id,
          questionV2Reply: { answers: [['Alpha']] },
        }),
      );
      expectQuestionNotFound(
        await noThrowClient.v2.session.question.reject({
          sessionID: restartPending.sessionID,
          requestID: restartPending.request.id,
        }),
      );

      const recoveredSession = (
        await readSdkData(
          client.v2.session.get({ sessionID: restartPending.sessionID }),
          'native session.get after question restart',
        )
      ).data;
      expect(recoveredSession).toMatchObject({
        id: restartPending.sessionID,
        model: {
          providerID: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
          id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
        },
      });
      const historyAfterRestart = await readSdkData(
        client.v2.session.history({ sessionID: restartPending.sessionID, after: 0, limit: 100 }),
        'native session history after question restart',
      );
      const admittedAfterRestart = historyAfterRestart.data.find(
        (event) =>
          event.type === 'session.next.prompt.admitted' &&
          event.durable?.seq === restartPending.admittedSeq,
      );
      expect(admittedAfterRestart).toEqual(admittedBeforeRestart);
      expect(historyAfterRestart.data.slice(0, historyBeforeRestart.data.length)).toEqual(
        historyBeforeRestart.data,
      );
      const restartTail = historyAfterRestart.data.slice(historyBeforeRestart.data.length);
      expect(
        restartTail.every(
          (event) =>
            event.type === 'session.next.tool.failed' || event.type === 'session.next.step.failed',
        ),
      ).toBe(true);
      expect(
        historyAfterRestart.data.some(
          (event) =>
            event.type === 'session.next.tool.success' &&
            event.data.callID === restartPending.request.tool?.callID,
        ),
      ).toBe(false);
      expect(providerTurnDiagnostics(provider)).toEqual(providerTurnsBeforeRestart);

      const providerTurns = providerTurnDiagnostics(provider);
      expect(providerTurns.length).toBeGreaterThanOrEqual(4);
      expect(
        providerTurns.every(
          (entry) =>
            entry.path.length <= 128 &&
            entry.transport === 'chat-completions' &&
            entry.stream === true &&
            entry.inputShape === 'messages' &&
            entry.toolCount !== null &&
            entry.status === 200,
        ),
      ).toBe(true);
      expect(
        providerTurns.some(
          (entry) => entry.turnShape === 'tool-result' && entry.expectedAnswerObserved === true,
        ),
      ).toBe(true);

      const allowedDiagnosticKeys = new Set([
        'method',
        'path',
        'transport',
        'stream',
        'toolCount',
        'inputShape',
        'turnShape',
        'status',
        'structuredFormat',
        'formatShape',
        'classifierMarkerObserved',
        'structuredOutputToolOffered',
        'classifierResultKind',
        'expectedAnswerObserved',
        'toolResultDisposition',
      ]);
      const providerDiagnostics = provider.diagnostics();
      expect(
        providerDiagnostics.every((entry) =>
          Object.keys(entry).every((key) => allowedDiagnosticKeys.has(key)),
        ),
      ).toBe(true);
      const serializedDiagnostics = JSON.stringify(providerDiagnostics);
      for (const forbidden of [
        OPENCODE_CLASSIFIER_CONFORMANCE_SYSTEM,
        OPENCODE_CLASSIFIER_CONFORMANCE_MARKER,
        'conflicting bytes',
        'post-restart conflicting bytes',
        OPENCODE_QUESTION_CONFORMANCE_QUESTIONS[0]!.question,
        'Alpha',
        'Beta',
        'Structured output captured successfully.',
      ]) {
        expect(serializedDiagnostics).not.toContain(forbidden);
      }
    } finally {
      try {
        await stopOpencodeProcesses(10_000);
      } finally {
        await provider.stop();
        restoreEnv(previous);
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: process.platform === 'win32' ? 10 : 0,
          retryDelay: 100,
        });
        expect(existsSync(root)).toBe(false);
      }
    }
  }, 360_000);
}
