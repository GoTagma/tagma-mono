import { createOpencodeClient as createLegacyOpencodeClient } from '@opencode-ai/sdk/client';
import { createOpencodeClient as createV2OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { readOpencodeContextWindowPluginReady } from '../server/opencode-context-window-plugin';
import {
  ensureOpencode,
  getOpencodeRuntimeDiagnostics,
  restartOpencode,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';
import {
  TAGMA_MANAGED_OPENCODE_TOOL_IDS,
  TAGMA_MANAGED_OPENCODE_TOOLS,
} from '../server/opencode-managed-tools';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { seedOpencodeArtifacts } from '../server/opencode-seed';

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
function restoreEnv(previous: Map<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type SdkResponse<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

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

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

function expectNonEmptyIds(label: string, ids: Iterable<string>): string[] {
  const values = sortedIds(ids);
  expect(values.length, `${label} should not be empty`).toBeGreaterThan(0);
  expect(
    values.every((value) => value.length > 0),
    `${label} should contain only non-empty strings`,
  ).toBe(true);
  return values;
}

type ProviderCatalog = {
  all: Array<{
    id: string;
    models: Record<string, { id: string }>;
  }>;
};

function providerCatalogIds(catalog: ProviderCatalog): {
  providers: string[];
  models: string[];
} {
  return {
    providers: expectNonEmptyIds(
      'provider ids',
      catalog.all.map((provider) => provider.id),
    ),
    models: expectNonEmptyIds(
      'model ids',
      catalog.all.flatMap((provider) =>
        Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
      ),
    ),
  };
}

function canonicalFilesystemPath(path: string): string {
  return realpathSync.native(resolve(path));
}

function normalizedFilesystemPath(path: string): string {
  const normalized = canonicalFilesystemPath(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function expectFilesystemPath(actual: string, expected: string): void {
  expect(normalizedFilesystemPath(actual)).toBe(normalizedFilesystemPath(expected));
}

test('native filesystem path comparison resolves directory aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-native-path-alias-'));
  const target = join(root, 'target');
  const alias = join(root, 'alias');
  try {
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expectFilesystemPath(alias, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('pinned OpenCode CLI serves both SDK clients from a fresh isolated native profile', async () => {
    const electronPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', '..', 'electron', 'package.json'), 'utf8'),
    ) as {
      tagma?: {
        bundledOpencodeVersion?: unknown;
        bundledOpencodeDbSchemaVersion?: unknown;
      };
    };
    const expectedVersion = electronPackage.tagma?.bundledOpencodeVersion;
    if (typeof expectedVersion !== 'string' || !expectedVersion) {
      throw new Error('Electron package is missing tagma.bundledOpencodeVersion');
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

    const root = mkdtempSync(join(tmpdir(), 'tagma native opencode 中文-'));
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
      const version = readFileSync(join(bundledDir, 'version.txt'), 'utf8').trim();
      expect(version).toBe(expectedVersion);
      const binaryVersion = Bun.spawnSync([executable, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(binaryVersion.exitCode).toBe(0);
      expect(new TextDecoder().decode(binaryVersion.stdout).trim()).toBe(expectedVersion);

      const tagmaCwdPath = join(root, 'workspace with spaces 中文', '.tagma');
      mkdirSync(tagmaCwdPath, { recursive: true });
      const tagmaCwd = canonicalFilesystemPath(tagmaCwdPath);
      expect(seedOpencodeArtifacts(tagmaCwd)).toBe(true);

      const runtime = resolveOpencodeRuntimePaths(tagmaCwd);
      for (const { filename } of TAGMA_MANAGED_OPENCODE_TOOLS) {
        expect(existsSync(join(runtime.managedToolsDir, filename))).toBe(true);
        expect(existsSync(join(tagmaCwd, '.opencode', 'tools', filename))).toBe(false);
      }

      const handle = await ensureOpencode(tagmaCwd);
      expect(handle.cwd).toBe(tagmaCwd);
      expect(readOpencodeContextWindowPluginReady(tagmaCwd)).toEqual({
        ready: true,
        schema: 1,
      });
      const pluginPackagePath = join(
        runtime.configDir,
        'node_modules',
        '@opencode-ai',
        'plugin',
        'package.json',
      );
      expect(existsSync(pluginPackagePath)).toBe(true);
      const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8')) as {
        version?: unknown;
      };
      expect(pluginPackage.version).toBe(expectedVersion);
      expect(
        getOpencodeRuntimeDiagnostics().some(
          (entry) => entry.cwd === tagmaCwd && entry.status === 'running',
        ),
      ).toBe(true);

      const clientConfig = {
        baseUrl: handle.baseUrl,
        directory: tagmaCwd,
        headers: { Authorization: handle.auth.authorization },
        fetch: createStreamingLoopbackFetch(handle.baseUrl),
        throwOnError: true,
      } as const;
      let legacyClient = createLegacyOpencodeClient(clientConfig);
      let v2Client = createV2OpencodeClient(clientConfig);

      const legacyAgents = await readSdkData(legacyClient.app.agents(), 'legacy app.agents');
      const compatibilityAgents = await readSdkData(
        v2Client.app.agents(),
        'v2 compatibility app.agents',
      );
      const legacyAgentIds = expectNonEmptyIds(
        'legacy agent ids',
        legacyAgents.map((agent) => agent.name),
      );
      expectNonEmptyIds(
        'v2 compatibility agent ids',
        compatibilityAgents.map((agent) => agent.name),
      );
      expect(sortedIds(compatibilityAgents.map((agent) => agent.name))).toEqual(legacyAgentIds);

      const legacyProviderCatalog = await readSdkData(
        legacyClient.provider.list(),
        'legacy provider.list',
      );
      const compatibilityProviderCatalog = await readSdkData(
        v2Client.provider.list(),
        'v2 compatibility provider.list',
      );
      const legacyCatalogIds = providerCatalogIds(legacyProviderCatalog);
      expect(providerCatalogIds(compatibilityProviderCatalog)).toEqual(legacyCatalogIds);

      const nativeV2Agents = await readSdkData(v2Client.v2.agent.list(), 'v2 agent.list');
      const nativeV2Providers = await readSdkData(v2Client.v2.provider.list(), 'v2 provider.list');
      const nativeV2Models = await readSdkData(v2Client.v2.model.list(), 'v2 model.list');
      expectFilesystemPath(nativeV2Agents.location.directory, tagmaCwd);
      expectFilesystemPath(nativeV2Providers.location.directory, tagmaCwd);
      expectFilesystemPath(nativeV2Models.location.directory, tagmaCwd);
      // The native durable-v2 projection is independent from the compatibility
      // catalog Tagma uses today. A fresh compatibility profile can legitimately
      // expose no native-v2 agents, so validate its wire shape without treating
      // this endpoint as a replacement for `app.agents()`.
      expect(Array.isArray(nativeV2Agents.data)).toBe(true);
      expect(nativeV2Agents.data.every((agent) => agent.id.length > 0)).toBe(true);
      const nativeV2ProviderIds = expectNonEmptyIds(
        'native v2 provider ids',
        nativeV2Providers.data.map((provider) => provider.id),
      );
      const nativeV2ModelIds = expectNonEmptyIds(
        'native v2 model ids',
        nativeV2Models.data.map((model) => `${model.providerID}/${model.id}`),
      );
      expect(
        nativeV2Models.data.every((model) => nativeV2ProviderIds.includes(model.providerID)),
      ).toBe(true);
      expect(nativeV2ModelIds.some((id) => legacyCatalogIds.models.includes(id))).toBe(true);

      // ChatTurn Operation V2 depends on these durable-input semantics. Keep
      // the probe provider-free (`resume: false`) so the release contract can
      // run without credentials or a network model invocation.
      const conformanceSuffix = randomUUID().replace(/-/g, '');
      const nativeSessionId = `ses_tagma_${conformanceSuffix}`;
      const nativeInputId = `msg_tagma_${conformanceSuffix}`;
      const nativePrompt = { text: 'Tagma durable input conformance probe' };
      const nativeCreated = (
        await readSdkData(
          v2Client.v2.session.create({
            id: nativeSessionId,
            location: { directory: tagmaCwd },
          }),
          'v2 native session.create with Host id',
        )
      ).data;
      expect(nativeCreated.id).toBe(nativeSessionId);
      expectFilesystemPath(nativeCreated.location.directory, tagmaCwd);
      const duplicateNativeCreated = (
        await readSdkData(
          v2Client.v2.session.create({
            id: nativeSessionId,
            location: { directory: tagmaCwd },
          }),
          'v2 native duplicate session.create',
        )
      ).data;
      expect(duplicateNativeCreated.id).toBe(nativeSessionId);
      expect(duplicateNativeCreated.time.created).toBe(nativeCreated.time.created);

      const admitted = (
        await readSdkData(
          v2Client.v2.session.prompt({
            sessionID: nativeSessionId,
            id: nativeInputId,
            prompt: nativePrompt,
            delivery: 'queue',
            resume: false,
          }),
          'v2 native session.prompt admission',
        )
      ).data;
      expect(admitted).toMatchObject({
        id: nativeInputId,
        sessionID: nativeSessionId,
        prompt: nativePrompt,
        delivery: 'queue',
      });
      expect(admitted.admittedSeq).toBeGreaterThan(0);

      const historyAfterAdmission = await readSdkData(
        v2Client.v2.session.history({ sessionID: nativeSessionId, after: 0, limit: 100 }),
        'v2 native session.history after admission',
      );
      const admittedEvents = historyAfterAdmission.data.filter(
        (event) =>
          event.type === 'session.next.prompt.admitted' && event.data.messageID === nativeInputId,
      );
      expect(admittedEvents).toHaveLength(1);
      expect(admittedEvents[0]?.durable?.seq).toBe(admitted.admittedSeq);

      const noThrowV2Client = createV2OpencodeClient({ ...clientConfig, throwOnError: false });
      const duplicateAdmission = await noThrowV2Client.v2.session.prompt({
        sessionID: nativeSessionId,
        id: nativeInputId,
        prompt: nativePrompt,
        delivery: 'queue',
        resume: false,
      });
      expect(duplicateAdmission.response.status).toBe(200);
      expect(duplicateAdmission.error).toBeUndefined();
      expect(duplicateAdmission.data?.data).toEqual(admitted);

      const conflictingAdmission = await noThrowV2Client.v2.session.prompt({
        sessionID: nativeSessionId,
        id: nativeInputId,
        prompt: { text: `${nativePrompt.text} with conflicting bytes` },
        delivery: 'queue',
        resume: false,
      });
      expect(conflictingAdmission.response.status).toBe(409);
      expect(conflictingAdmission.error).toMatchObject({ _tag: 'ConflictError' });

      // The production classifier needs the compatibility prompt surface for
      // tool disabling + JSON Schema, while recovery needs native durable
      // history. Prove both surfaces share one Host-created identity.
      const richSessionId = `ses_tagma_rich_${conformanceSuffix}`;
      const richInputId = `msg_tagma_rich_${conformanceSuffix}`;
      const richRequest = {
        system: 'Classify without tools and return the supplied schema.',
        user: 'Classify this request as discussion.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', const: 'discussion' } },
        },
      } as const;
      const richRequestDigest = createHash('sha256')
        .update(JSON.stringify(richRequest))
        .digest('hex');
      const richPromptText = [
        `<tagma-native-request digest="${richRequestDigest}">`,
        richRequest.user,
        '</tagma-native-request>',
      ].join('\n');
      await readSdkData(
        v2Client.v2.session.create({
          id: richSessionId,
          location: { directory: tagmaCwd },
        }),
        'v2 native rich session.create with Host id',
      );
      const richCompatibilityRequest = {
        sessionID: richSessionId,
        messageID: richInputId,
        noReply: true,
        agent: 'tagma-pipeline-intent-classifier',
        tools: { '*': false },
        format: { type: 'json_schema' as const, schema: richRequest.schema },
        system: richRequest.system,
        parts: [{ type: 'text' as const, text: richPromptText }],
      };
      const richCompatibilityResponse = await readSdkData(
        v2Client.session.prompt(richCompatibilityRequest),
        'v2 compatibility rich prompt with Host ids',
      );
      expect(richCompatibilityResponse.info.id).toBe(richInputId);
      const richHistory = await readSdkData(
        v2Client.v2.session.history({ sessionID: richSessionId, after: 0, limit: 100 }),
        'v2 native history after compatibility rich prompt',
      );
      const richAdmissionEvents = richHistory.data.filter(
        (event) =>
          event.type === 'session.next.prompt.admitted' && event.data.messageID === richInputId,
      );
      const richPromptedEvents = richHistory.data.filter(
        (event) => event.type === 'session.next.prompted' && event.data.messageID === richInputId,
      );
      expect(richAdmissionEvents).toHaveLength(0);
      expect(richPromptedEvents).toHaveLength(0);
      const nativeRichMessage = await noThrowV2Client.v2.session.message({
        sessionID: richSessionId,
        messageID: richInputId,
      });
      const compatibilityRichMessage = await noThrowV2Client.session.message({
        sessionID: richSessionId,
        messageID: richInputId,
      });
      let compatibilityMessagesDecodeError: unknown = null;
      try {
        await readSdkData(
          v2Client.session.messages({ sessionID: richSessionId, limit: 100 }),
          'v2 compatibility messages after rich prompt',
        );
      } catch (error) {
        compatibilityMessagesDecodeError = error;
      }
      expect(nativeRichMessage.response.status).toBe(404);
      expect(compatibilityRichMessage.response.status).toBe(400);
      expect(compatibilityMessagesDecodeError).toBeInstanceOf(Error);
      const rawRichMessagesUrl = new URL(`/session/${richSessionId}/message`, handle.baseUrl);
      rawRichMessagesUrl.searchParams.set('directory', tagmaCwd);
      rawRichMessagesUrl.searchParams.set('limit', '100');
      const rawRichMessagesResponse = await createStreamingLoopbackFetch(handle.baseUrl)(
        rawRichMessagesUrl,
        { headers: { Authorization: handle.auth.authorization } },
      );
      expect(rawRichMessagesResponse.status).toBe(400);
      const duplicateRichPrompt = await noThrowV2Client.session.prompt(richCompatibilityRequest);
      expect(duplicateRichPrompt.response.status).toBe(200);
      expect(duplicateRichPrompt.data).toMatchObject({ info: { id: richInputId } });
      const conflictingRichPrompt = await noThrowV2Client.session.prompt({
        ...richCompatibilityRequest,
        parts: [{ type: 'text', text: `${richPromptText}\nconflicting bytes` }],
      });
      expect(conflictingRichPrompt.response.status).toBe(200);
      expect(conflictingRichPrompt.data).toMatchObject({ info: { id: richInputId } });
      expect(
        (
          await readSdkData(
            v2Client.v2.session.history({ sessionID: richSessionId, after: 0, limit: 100 }),
            'v2 native history after compatibility duplicate prompt',
          )
        ).data.filter(
          (event) => event.type === 'session.next.prompted' && event.data.messageID === richInputId,
        ),
      ).toHaveLength(0);

      const lostResponseInputId = `msg_tagma_lost_${conformanceSuffix}`;
      const loopbackFetch = createStreamingLoopbackFetch(handle.baseUrl);
      let responseDropped = false;
      const responseDroppingFetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await loopbackFetch(input, init);
        const request = new Request(input, init);
        if (
          !responseDropped &&
          request.method === 'POST' &&
          new URL(request.url).pathname === `/api/session/${nativeSessionId}/prompt`
        ) {
          responseDropped = true;
          await response.arrayBuffer();
          throw new Error('simulated committed response loss');
        }
        return response;
      }) as typeof fetch;
      responseDroppingFetch.preconnect = fetch.preconnect.bind(fetch);
      const responseDroppingClient = createV2OpencodeClient({
        ...clientConfig,
        fetch: responseDroppingFetch,
      });
      let lostResponseError: unknown = null;
      try {
        await responseDroppingClient.v2.session.prompt({
          sessionID: nativeSessionId,
          id: lostResponseInputId,
          prompt: { text: 'Tagma response-loss conformance probe' },
          delivery: 'queue',
          resume: false,
        });
      } catch (error) {
        lostResponseError = error;
      }
      expect(responseDropped).toBe(true);
      expect(lostResponseError).toBeInstanceOf(Error);

      const historyAfterLostResponse = await readSdkData(
        v2Client.v2.session.history({
          sessionID: nativeSessionId,
          after: admitted.admittedSeq,
          limit: 100,
        }),
        'v2 native session.history after response loss',
      );
      const lostResponseEvents = historyAfterLostResponse.data.filter(
        (event) =>
          event.type === 'session.next.prompt.admitted' &&
          event.data.messageID === lostResponseInputId,
      );
      expect(lostResponseEvents).toHaveLength(1);
      const lostResponseEvent = lostResponseEvents[0];
      const lostResponseSeq = lostResponseEvent?.durable?.seq;
      expect(lostResponseSeq).toBeGreaterThan(admitted.admittedSeq);

      const eventAbort = new AbortController();
      const eventStream = await v2Client.v2.session.events(
        {
          sessionID: nativeSessionId,
          after: String(admitted.admittedSeq),
        },
        { signal: eventAbort.signal },
      );
      const replayedEvent = await Promise.race([
        eventStream.stream.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('native v2 event replay timed out')), 10_000),
        ),
      ]);
      eventAbort.abort();
      expect(replayedEvent.done).toBe(false);
      const replayedValue = replayedEvent.value;
      if (!replayedValue) throw new Error('native v2 event replay returned no event');
      expect(replayedValue.id).toMatch(/^evt_[A-Za-z0-9]+$/);
      expect(replayedValue.id).toBe(lostResponseEvent?.id);
      // The pinned SDK currently omits the SSE `event` field at runtime even
      // though its generated declaration includes it. Consumers must join the
      // source event id back to history for the durable type and aggregate seq.
      expect(replayedValue.event).toBeUndefined();
      expect(lostResponseEvent?.type).toBe('session.next.prompt.admitted');
      const replayedPayload =
        typeof replayedValue.data === 'string'
          ? JSON.parse(replayedValue.data)
          : replayedValue.data;
      expect(replayedPayload).toMatchObject({
        sessionID: nativeSessionId,
        messageID: lostResponseInputId,
      });

      const permissionRequestId = `per_tagma_${conformanceSuffix}`;
      const createdPermission = (
        await readSdkData(
          v2Client.v2.session.permission.create({
            sessionID: nativeSessionId,
            id: permissionRequestId,
            action: 'external_directory',
            resources: ['file:///tagma-conformance-outside-workspace'],
            metadata: { purpose: 'chat-operation-v2-conformance' },
          }),
          'v2 native permission.create',
        )
      ).data;
      expect(createdPermission).toEqual({ id: permissionRequestId, effect: 'ask' });
      expect(
        (
          await readSdkData(
            v2Client.v2.session.permission.list({ sessionID: nativeSessionId }),
            'v2 native permission.list before restart',
          )
        ).data,
      ).toEqual([
        {
          id: permissionRequestId,
          sessionID: nativeSessionId,
          action: 'external_directory',
          resources: ['file:///tagma-conformance-outside-workspace'],
          metadata: { purpose: 'chat-operation-v2-conformance' },
        },
      ]);
      const permissionRaceRequestId = `per_tagma_race_${conformanceSuffix}`;
      expect(
        (
          await readSdkData(
            v2Client.v2.session.permission.create({
              sessionID: nativeSessionId,
              id: permissionRaceRequestId,
              action: 'external_directory',
              resources: ['file:///tagma-conformance-race'],
            }),
            'v2 native permission.create first-wins probe',
          )
        ).data,
      ).toEqual({ id: permissionRaceRequestId, effect: 'ask' });
      const firstPermissionReply = await noThrowV2Client.v2.session.permission.reply({
        sessionID: nativeSessionId,
        requestID: permissionRaceRequestId,
        reply: 'reject',
        message: 'Tagma native first reply',
      });
      expect(firstPermissionReply.response.status).toBe(204);
      expect(firstPermissionReply.error).toBeUndefined();
      const secondPermissionReply = await noThrowV2Client.v2.session.permission.reply({
        sessionID: nativeSessionId,
        requestID: permissionRaceRequestId,
        reply: 'reject',
        message: 'Tagma native duplicate reply',
      });
      expect(secondPermissionReply.response.status).toBe(404);
      expect(secondPermissionReply.error).toMatchObject({ _tag: 'PermissionNotFoundError' });

      const restartedHandle = await restartOpencode(tagmaCwd);
      const restartedClientConfig = {
        baseUrl: restartedHandle.baseUrl,
        directory: tagmaCwd,
        headers: { Authorization: restartedHandle.auth.authorization },
        fetch: createStreamingLoopbackFetch(restartedHandle.baseUrl),
      } as const;
      const restartedV2Client = createV2OpencodeClient({
        ...restartedClientConfig,
        throwOnError: true,
      });
      const recoveredHistory = await readSdkData(
        restartedV2Client.v2.session.history({ sessionID: nativeSessionId, after: 0, limit: 100 }),
        'v2 native session.history after restart',
      );
      expect(
        recoveredHistory.data.filter(
          (event) =>
            event.type === 'session.next.prompt.admitted' &&
            (event.data.messageID === nativeInputId ||
              event.data.messageID === lostResponseInputId),
        ),
      ).toHaveLength(2);
      const restartedNoThrowV2Client = createV2OpencodeClient({
        ...restartedClientConfig,
        throwOnError: false,
      });
      const missingPermissionAfterRestart =
        await restartedNoThrowV2Client.v2.session.permission.get({
          sessionID: nativeSessionId,
          requestID: permissionRequestId,
        });
      expect(missingPermissionAfterRestart.response.status).toBe(404);
      expect(missingPermissionAfterRestart.error).toMatchObject({
        _tag: 'PermissionNotFoundError',
      });
      expect(
        (
          await readSdkData(
            restartedV2Client.v2.session.permission.list({ sessionID: nativeSessionId }),
            'v2 native permission.list after restart',
          )
        ).data,
      ).toEqual([]);
      // A create call would be a new permission evaluation, not a rehydration
      // attempt: request IDs do not participate in PermissionV2 policy. Its
      // cold AgentV2 registry can also briefly fail closed before normal policy
      // loads, so asserting that a recreated request is denied is racy across
      // platforms. The durable boundary is that the old request cannot be
      // replied to after restart.
      const stalePermissionReply = await restartedNoThrowV2Client.v2.session.permission.reply({
        sessionID: nativeSessionId,
        requestID: permissionRequestId,
        reply: 'reject',
        message: 'Tagma stale permission reply after restart',
      });
      expect(stalePermissionReply.response.status).toBe(404);
      expect(stalePermissionReply.error).toMatchObject({ _tag: 'PermissionNotFoundError' });
      expect(
        (
          await readSdkData(
            restartedV2Client.v2.session.permission.list({ sessionID: nativeSessionId }),
            'v2 native permission.list after stale reply',
          )
        ).data,
      ).toEqual([]);
      const retryAfterRestart = await restartedNoThrowV2Client.v2.session.prompt({
        sessionID: nativeSessionId,
        id: lostResponseInputId,
        prompt: { text: 'Tagma response-loss conformance probe' },
        delivery: 'queue',
        resume: false,
      });
      expect(retryAfterRestart.response.status).toBe(200);
      expect(retryAfterRestart.error).toBeUndefined();
      expect(retryAfterRestart.data?.data).toMatchObject({
        id: lostResponseInputId,
        sessionID: nativeSessionId,
        admittedSeq: lostResponseSeq,
      });
      const recoveredHistoryAfterRetry = await readSdkData(
        restartedV2Client.v2.session.history({ sessionID: nativeSessionId, after: 0, limit: 100 }),
        'v2 native session.history after restart retry',
      );
      expect(
        recoveredHistoryAfterRetry.data.filter(
          (event) =>
            event.type === 'session.next.prompt.admitted' &&
            event.data.messageID === lostResponseInputId,
        ),
      ).toHaveLength(1);
      legacyClient = createLegacyOpencodeClient({
        ...restartedClientConfig,
        throwOnError: true,
      });
      v2Client = restartedV2Client;

      const legacyToolIds = expectNonEmptyIds(
        'legacy tool ids',
        await readSdkData(legacyClient.tool.ids(), 'legacy tool.ids'),
      );
      const compatibilityToolIds = expectNonEmptyIds(
        'v2 compatibility tool ids',
        await readSdkData(v2Client.tool.ids(), 'v2 compatibility tool.ids'),
      );
      expect(compatibilityToolIds).toEqual(legacyToolIds);
      for (const id of TAGMA_MANAGED_OPENCODE_TOOL_IDS) {
        expect(compatibilityToolIds).toContain(id);
      }

      const legacyCreated = await readSdkData(
        legacyClient.session.create({ body: { title: 'Tagma native smoke legacy' } }),
        'legacy session.create',
      );
      expectFilesystemPath(legacyCreated.directory, tagmaCwd);
      expect(legacyCreated.version).toBe(expectedVersion);
      expect(
        (await readSdkData(legacyClient.session.list(), 'legacy session.list')).some(
          (session) => session.id === legacyCreated.id,
        ),
      ).toBe(true);
      const legacyUpdated = await readSdkData(
        legacyClient.session.update({
          path: { id: legacyCreated.id },
          body: { title: 'Tagma native smoke legacy updated' },
        }),
        'legacy session.update',
      );
      expect(legacyUpdated.title).toBe('Tagma native smoke legacy updated');
      expect(
        await readSdkData(
          legacyClient.session.delete({ path: { id: legacyCreated.id } }),
          'legacy session.delete',
        ),
      ).toBe(true);
      expect(
        (await readSdkData(legacyClient.session.list(), 'legacy session.list after delete')).some(
          (session) => session.id === legacyCreated.id,
        ),
      ).toBe(false);

      const compatibilityCreated = await readSdkData(
        v2Client.session.create({ title: 'Tagma native smoke v2 compatibility' }),
        'v2 compatibility session.create',
      );
      expectFilesystemPath(compatibilityCreated.directory, tagmaCwd);
      expect(compatibilityCreated.version).toBe(expectedVersion);
      expect(
        (await readSdkData(v2Client.session.list(), 'v2 compatibility session.list')).some(
          (session) => session.id === compatibilityCreated.id,
        ),
      ).toBe(true);
      const compatibilityUpdated = await readSdkData(
        v2Client.session.update({
          sessionID: compatibilityCreated.id,
          title: 'Tagma native smoke v2 compatibility updated',
        }),
        'v2 compatibility session.update',
      );
      expect(compatibilityUpdated.title).toBe('Tagma native smoke v2 compatibility updated');
      expect(
        await readSdkData(
          v2Client.session.delete({ sessionID: compatibilityCreated.id }),
          'v2 compatibility session.delete',
        ),
      ).toBe(true);
      expect(
        (
          await readSdkData(v2Client.session.list(), 'v2 compatibility session.list after delete')
        ).some((session) => session.id === compatibilityCreated.id),
      ).toBe(false);
    } finally {
      try {
        await stopOpencodeProcesses(10_000);
      } finally {
        restoreEnv(previous);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 360_000);
}
