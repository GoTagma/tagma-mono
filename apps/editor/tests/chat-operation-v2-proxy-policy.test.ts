import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  CHAT_OPERATION_V2_INTERNAL_MUTATIONS_ENV,
  CHAT_OPERATION_V2_PRODUCTION_CUTOVER_ENV,
  CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH,
  chatOperationV2ProxyHandshake,
  evaluateChatOperationV2RendererProxyPolicy,
  isChatOperationV2ProductionCutover,
  isChatOperationV2MutationSurfaceEnabled,
  sanitizeChatOperationV2RendererProxyRequestUrl,
} from '../server/chat-operations/proxy-policy.js';
import { registerOpencodeRoutes } from '../server/routes/opencode.js';
import { WorkspaceState } from '../server/workspace-state.js';

const productionEnv = {
  TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
  TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '2',
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ChatTurn Operation V2 raw OpenCode proxy policy', () => {
  test('requires the exact trusted dual production-cutover handshake', () => {
    const cases: Array<[Readonly<Record<string, string | undefined>>, boolean]> = [
      [{}, false],
      [{ TAGMA_CHAT_OPERATION_V2_SHADOW: '1' }, false],
      [{ TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '2' }, false],
      [productionEnv, true],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_SHADOW: 'true' }, false],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_SHADOW: '01' }, false],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_SHADOW: '1 ' }, false],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '1' }, false],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '02' }, false],
      [{ ...productionEnv, TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: 'production' }, false],
    ];
    for (const [env, expected] of cases) {
      expect(isChatOperationV2ProductionCutover(env)).toBe(expected);
    }
    expect(CHAT_OPERATION_V2_PRODUCTION_CUTOVER_ENV).toBe(
      'TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER',
    );
  });

  test('publishes only the exact V2 production renderer bootstrap handshake', () => {
    expect(chatOperationV2ProxyHandshake(productionEnv)).toEqual({
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'production',
    });
    expect(() => chatOperationV2ProxyHandshake({ TAGMA_CHAT_OPERATION_V2_SHADOW: '1' })).toThrow(
      /V2 production mode is not enabled/i,
    );
    expect(() => chatOperationV2ProxyHandshake({})).toThrow(/V2 production mode is not enabled/i);
    expect(Object.isFrozen(chatOperationV2ProxyHandshake(productionEnv))).toBe(true);
  });

  test('keeps shadow read-only unless an exact internal or production mutation gate is active', () => {
    expect(isChatOperationV2MutationSurfaceEnabled({ TAGMA_CHAT_OPERATION_V2_SHADOW: '1' })).toBe(
      false,
    );
    expect(
      isChatOperationV2MutationSurfaceEnabled({
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_OPERATION_V2_INTERNAL_MUTATIONS: '2',
      }),
    ).toBe(true);
    expect(
      isChatOperationV2MutationSurfaceEnabled({
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_OPERATION_V2_INTERNAL_MUTATIONS: '02',
      }),
    ).toBe(false);
    expect(isChatOperationV2MutationSurfaceEnabled(productionEnv)).toBe(true);
    expect(CHAT_OPERATION_V2_INTERNAL_MUTATIONS_ENV).toBe(
      'TAGMA_CHAT_OPERATION_V2_INTERNAL_MUTATIONS',
    );
  });

  test('fails raw proxy traffic closed when the V2 production gate is absent', () => {
    for (const [method, requestUrl] of [
      ['GET', '/session'],
      ['POST', '/session'],
      ['POST', '/session/ses_1/message'],
    ] as const) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: { TAGMA_CHAT_OPERATION_V2_SHADOW: '1' },
          method,
          requestUrl,
        }),
      ).toEqual({
        kind: 'reject_protocol_mismatch',
        status: 426,
        body: CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH,
      });
    }
  });

  test('allows only table-driven read methods on canonical pinned OpenCode paths', () => {
    const allowed = [
      ['GET', '/global/health'],
      ['GET', '/global/event'],
      ['GET', '/event?directory=C%3A%5Crepo%5C.tagma'],
      ['HEAD', '/config/providers'],
      ['GET', '/provider'],
      ['GET', '/provider/auth'],
      ['GET', '/api/provider/openai'],
      ['GET', '/api/model'],
      ['GET', '/project/current'],
      ['GET', '/path'],
      ['GET', '/vcs/status'],
      ['GET', '/command'],
      ['GET', '/agent'],
      ['GET', '/skill'],
      ['GET', '/mcp'],
      ['GET', '/lsp'],
      ['GET', '/formatter'],
      ['GET', '/session?roots=true&limit=50'],
      ['GET', '/session/status'],
      ['GET', '/session/ses_123'],
      ['GET', '/session/ses_123/children'],
      ['GET', '/session/ses_123/todo'],
      ['GET', '/session/ses_123/diff'],
      ['GET', '/session/ses_123/message'],
      ['GET', '/session/ses_123/message/msg_456'],
      ['GET', '/api/session'],
      ['GET', '/api/session/active'],
      ['GET', '/api/session/ses_123'],
      ['GET', '/api/session/ses_123/context'],
      ['GET', '/api/session/ses_123/history'],
      ['GET', '/api/session/ses_123/event'],
      ['GET', '/api/session/ses_123/message'],
      ['GET', '/api/session/ses_123/message/msg_456'],
    ] as const;
    for (const [method, requestUrl] of allowed) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: productionEnv,
          method,
          requestUrl,
        }),
      ).toEqual({ kind: 'allow_read' });
    }
  });

  test('sanitizes the sole directory query and fails every other path-like query closed', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-proxy-query-'));
    tempRoots.push(workspaceRoot);
    const tagmaRoot = join(workspaceRoot, '.tagma');
    const stagedRoot = join(tagmaRoot, '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
    const outside = join(workspaceRoot, 'outside');
    const nested = join(tagmaRoot, 'pipeline');
    mkdirSync(stagedRoot, { recursive: true });
    mkdirSync(outside);
    mkdirSync(nested);

    for (const directory of [tagmaRoot, stagedRoot]) {
      const result = sanitizeChatOperationV2RendererProxyRequestUrl({
        env: productionEnv,
        requestUrl: `/session?roots=true&directory=${encodeURIComponent(directory)}&limit=50`,
        tagmaRoot,
      });
      expect(result.kind).toBe('allow_request_url');
      if (result.kind !== 'allow_request_url') continue;
      const parsed = new URL(result.requestUrl, 'http://opencode.invalid');
      expect(parsed.pathname).toBe('/session');
      expect(parsed.searchParams.get('directory')).toBe(realpathSync.native(directory));
      expect(result.canonicalDirectory).toBe(realpathSync.native(directory));
      expect(parsed.searchParams.get('roots')).toBe('true');
      expect(parsed.searchParams.get('limit')).toBe('50');
    }

    const denied = [
      `/session?directory=${encodeURIComponent(outside)}`,
      `/session?directory=${encodeURIComponent(nested)}`,
      `/session?directory=${encodeURIComponent(tagmaRoot)}&directory=${encodeURIComponent(stagedRoot)}`,
      `/session?Directory=${encodeURIComponent(tagmaRoot)}`,
      `/session?%64irectory=${encodeURIComponent(tagmaRoot)}`,
      '/session?r%6fots=true',
      '/session?directory=',
      '/session?directory=%',
      '/session?directory=%2',
      '/session?directory=%ZZ',
      `/session?directory=${encodeURIComponent(encodeURIComponent(tagmaRoot))}`,
      `/session?path=${encodeURIComponent(tagmaRoot)}`,
      `/session?cwd=${encodeURIComponent(tagmaRoot)}`,
      `/session?root=${encodeURIComponent(tagmaRoot)}`,
      `/session?workspace=${encodeURIComponent(tagmaRoot)}`,
      `/session?workspace_root=${encodeURIComponent(tagmaRoot)}`,
      `/session?working-directory=${encodeURIComponent(tagmaRoot)}`,
      `/session?file=${encodeURIComponent(join(tagmaRoot, 'pipeline.yaml'))}`,
      '/session?roots=true&roots=false',
      '/session?filter[path]=pipeline.yaml',
      '/session?',
    ];
    for (const requestUrl of denied) {
      expect(
        sanitizeChatOperationV2RendererProxyRequestUrl({
          env: productionEnv,
          requestUrl,
          tagmaRoot,
        }).kind,
      ).toBe('reject_protocol_mismatch');
    }

    const ungatedOutside = `/session?directory=${encodeURIComponent(outside)}&path=unsafe`;
    expect(
      sanitizeChatOperationV2RendererProxyRequestUrl({
        env: { TAGMA_CHAT_OPERATION_V2_SHADOW: '1' },
        requestUrl: ungatedOutside,
        tagmaRoot,
      }).kind,
    ).toBe('reject_protocol_mismatch');
  });

  test('keeps provider auth as the sole explicit non-operation raw mutation exception', () => {
    const allowed = [
      ['PUT', '/auth/openai'],
      ['DELETE', '/auth/openai-compatible'],
      ['POST', '/provider/anthropic/oauth/authorize'],
      ['POST', '/provider/google/oauth/callback?directory=D%3A%5Crepo%5C.tagma'],
    ] as const;
    for (const [method, requestUrl] of allowed) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: productionEnv,
          method,
          requestUrl,
        }),
      ).toEqual({ kind: 'allow_provider_auth' });
    }

    const deniedNearMisses = [
      ['POST', '/auth/openai'],
      ['PUT', '/auth/openai/extra'],
      ['PUT', '/auth/%6fpenai'],
      ['DELETE', '/auth/openai%2Fsession'],
      ['GET', '/provider/openai/oauth/authorize'],
      ['POST', '/provider/openai/oauth/authorize/extra'],
      ['POST', '/mcp/github/auth/authenticate'],
    ] as const;
    for (const [method, requestUrl] of deniedNearMisses) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: productionEnv,
          method,
          requestUrl,
        }).kind,
      ).toBe('reject_protocol_mismatch');
    }

    const chatStorePath = fileURLToPath(new URL('../src/store/chat-store.ts', import.meta.url));
    const chatStoreSource = readFileSync(chatStorePath, 'utf8');
    for (const activeRendererCall of [
      'client.auth.set(',
      'client.auth.remove(',
      'client.provider.oauth.authorize(',
      'client.provider.oauth.callback(',
    ]) {
      expect(chatStoreSource).toContain(activeRendererCall);
    }
  });

  test('rejects every raw operation mutation with the exact HTTP 426 wire body', () => {
    const operationMutations = [
      ['POST', '/session'],
      ['PATCH', '/session/ses_1'],
      ['PUT', '/session/ses_1'],
      ['DELETE', '/session/ses_1'],
      ['POST', '/experimental/control-plane/move-session'],
      ['POST', '/session/ses_1/message'],
      ['POST', '/session/ses_1/prompt_async'],
      ['POST', '/session/ses_1/abort'],
      ['POST', '/session/ses_1/init'],
      ['POST', '/session/ses_1/fork'],
      ['POST', '/session/ses_1/share'],
      ['DELETE', '/session/ses_1/share'],
      ['POST', '/session/ses_1/summarize'],
      ['POST', '/session/ses_1/command'],
      ['POST', '/session/ses_1/shell'],
      ['DELETE', '/session/ses_1/message/msg_1'],
      ['PATCH', '/session/ses_1/message/msg_1/part/part_1'],
      ['POST', '/api/session'],
      ['POST', '/api/session/ses_1/agent'],
      ['POST', '/api/session/ses_1/model'],
      ['POST', '/api/session/ses_1/prompt'],
      ['POST', '/api/session/ses_1/compact'],
      ['POST', '/api/session/ses_1/wait'],
      ['POST', '/api/session/ses_1/interrupt'],
      ['POST', '/permission/req_1/reply'],
      ['POST', '/question/req_1/reply'],
      ['POST', '/question/req_1/reject'],
      ['POST', '/session/ses_1/permissions/per_1'],
      ['POST', '/api/session/ses_1/permission/req_1/reply'],
      ['POST', '/api/session/ses_1/question/req_1/reply'],
      ['POST', '/api/session/ses_1/question/req_1/reject'],
    ] as const;
    for (const [method, requestUrl] of operationMutations) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: productionEnv,
          method,
          requestUrl,
        }),
      ).toEqual({
        kind: 'reject_protocol_mismatch',
        status: 426,
        body: CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH,
      });
    }
    expect(CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH).toEqual({
      protocolVersion: 2,
      code: 'chat_operation_protocol_mismatch',
      kind: 'chat_operation_protocol_mismatch',
      problem: 'unsupported_protocol_version',
      error: 'Raw OpenCode mutations are unavailable in Chat Operation V2 production mode.',
    });
    expect(Object.isFrozen(CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH)).toBe(true);
  });

  test('enforces the 426 fence at the renderer proxy before workspace or OpenCode startup', async () => {
    const previousShadow = process.env.TAGMA_CHAT_OPERATION_V2_SHADOW;
    const previousCutover = process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER;
    process.env.TAGMA_CHAT_OPERATION_V2_SHADOW = '1';
    process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER = '2';

    const app = express();
    app.use(express.json());
    registerOpencodeRoutes(app);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP port.');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const rejected = await fetch(`${baseUrl}/api/opencode/chat/proxy/session`, {
        method: 'POST',
      });
      expect(rejected.status).toBe(426);
      expect(await rejected.json()).toEqual(CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH);

      delete process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER;
      const ungated = await fetch(`${baseUrl}/api/opencode/chat/proxy/session`, {
        method: 'POST',
      });
      expect(ungated.status).toBe(426);
      expect(await ungated.json()).toEqual(CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (previousShadow === undefined) delete process.env.TAGMA_CHAT_OPERATION_V2_SHADOW;
      else process.env.TAGMA_CHAT_OPERATION_V2_SHADOW = previousShadow;
      if (previousCutover === undefined) {
        delete process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER;
      } else {
        process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER = previousCutover;
      }
    }
  });

  test('rejects conflicting authenticated header and query directories before runtime startup', async () => {
    const previousShadow = process.env.TAGMA_CHAT_OPERATION_V2_SHADOW;
    const previousCutover = process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER;
    process.env.TAGMA_CHAT_OPERATION_V2_SHADOW = '1';
    process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER = '2';
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-proxy-route-query-'));
    tempRoots.push(workspaceRoot);
    const tagmaRoot = join(workspaceRoot, '.tagma');
    const stagedRoot = join(tagmaRoot, '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
    mkdirSync(stagedRoot, { recursive: true });
    const workspace = new WorkspaceState(workspaceRoot);
    workspace.workDir = workspaceRoot;
    const app = express();
    app.use((req, _res, next) => {
      req.workspace = workspace;
      next();
    });
    registerOpencodeRoutes(app);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP port.');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/opencode/chat/proxy/session?directory=${encodeURIComponent(tagmaRoot)}`,
        {
          headers: { 'x-opencode-directory': encodeURIComponent(stagedRoot) },
        },
      );
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual(CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (previousShadow === undefined) delete process.env.TAGMA_CHAT_OPERATION_V2_SHADOW;
      else process.env.TAGMA_CHAT_OPERATION_V2_SHADOW = previousShadow;
      if (previousCutover === undefined) {
        delete process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER;
      } else {
        process.env.TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER = previousCutover;
      }
    }
  });

  test('fails non-canonical, encoded, traversal, and method-confusion targets closed', () => {
    const denied = [
      ['GET', '/unknown'],
      ['GET', '/permission'],
      ['GET', '/question'],
      ['GET', '/api/permission/request'],
      ['GET', '/api/permission/saved'],
      ['GET', '/api/question/request'],
      ['GET', '/api/session/ses_1/permission'],
      ['GET', '/api/session/ses_1/permission/req_1'],
      ['GET', '/api/session/ses_1/question'],
      ['POST', '/provider'],
      ['OPTIONS', '/session'],
      ['TRACE', '/session'],
      ['GET ', '/session'],
      ['GET', 'session'],
      ['GET', '//session'],
      ['GET', 'https://127.0.0.1/session'],
      ['GET', '/session/'],
      ['GET', '/session//ses_1'],
      ['GET', '/session\\ses_1'],
      ['GET', '/session/%73es_1'],
      ['GET', '/session%2Fses_1'],
      ['GET', '/session%2fses_1'],
      ['GET', '/session%5Cses_1'],
      ['GET', '/session%252Fses_1'],
      ['GET', '/session/%2e%2e/auth/openai'],
      ['GET', '/session/%2E%2E/auth/openai'],
      ['GET', '/session/%252e%252e/auth/openai'],
      ['GET', '/session/../auth/openai'],
      ['GET', '/session/./ses_1'],
      ['GET', '/SESSION/ses_1'],
      ['GET', '/session/ses_1%00'],
      ['GET', '/session/ses_1;prompt_async'],
      ['GET', '/session/ses_1#fragment'],
      ['GET', '/session/会话'],
      ['GET\r\nPOST', '/session'],
    ] as const;
    for (const [method, requestUrl] of denied) {
      expect(
        evaluateChatOperationV2RendererProxyPolicy({
          env: productionEnv,
          method,
          requestUrl,
        }).kind,
      ).toBe('reject_protocol_mismatch');
    }
  });

  test('wires the policy before OpenCode startup and publishes both ensure/restart handshakes', () => {
    const routePath = fileURLToPath(new URL('../server/routes/opencode.ts', import.meta.url));
    const source = readFileSync(routePath, 'utf8');
    const proxyRoute = source.indexOf('app.use(OPENCODE_PROXY_BASE_PATH');
    const policyCall = source.indexOf('evaluateChatOperationV2RendererProxyPolicy', proxyRoute);
    const tagmaResolution = source.indexOf('const tagmaCwd = ensureRealTagmaDirectory', proxyRoute);
    const requestUrlSanitizer = source.indexOf(
      'sanitizeChatOperationV2RendererProxyRequestUrl',
      tagmaResolution,
    );
    const ensureCall = source.indexOf('await ensureOpencode(tagmaCwd)', proxyRoute);
    const proxyFetch = source.indexOf('fetchOpencodeProxy({', ensureCall);

    expect(proxyRoute).toBeGreaterThan(0);
    expect(policyCall).toBeGreaterThan(proxyRoute);
    expect(tagmaResolution).toBeGreaterThan(policyCall);
    expect(requestUrlSanitizer).toBeGreaterThan(tagmaResolution);
    expect(ensureCall).toBeGreaterThan(requestUrlSanitizer);
    expect(proxyFetch).toBeGreaterThan(ensureCall);
    expect(source.match(/chatOperationV2ProxyHandshake\(\)/g)).toHaveLength(2);
    expect(source).toContain('res.status(policy.status).json(policy.body)');
    expect(source).toContain('requestUrl.canonicalDirectory');
    expect(source).toContain('CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH');

    const adapterPath = fileURLToPath(
      new URL('../server/chat-operations/opencode-adapter.ts', import.meta.url),
    );
    const adapterSource = readFileSync(adapterPath, 'utf8');
    expect(adapterSource).toContain('createOpencodeV2Client({');
    expect(adapterSource).toContain('createStreamingLoopbackFetch(handle.baseUrl)');
    expect(adapterSource).not.toContain('evaluateChatOperationV2RendererProxyPolicy');
  });
});
