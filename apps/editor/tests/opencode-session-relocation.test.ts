import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  getOpencodeCanonicalDirectory,
  moveOpencodeSessionDirectory,
  resetOpencodeClient,
} from '../src/api/opencode-chat';

const WORKSPACE = 'C:/repo';
const CANONICAL_DIRECTORY = 'C:/repo/.tagma';
const BASE_URL = 'http://opencode-relocation.test';
const originalFetch = globalThis.fetch;

interface MockSession {
  id: string;
  directory: string;
  workspaceID?: string;
}

let sessionResponses: MockSession[] = [];
let moveStatus = 204;
let requests: Array<{ method: string; url: URL; body: unknown }> = [];

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const url = new URL(rawUrl, 'http://localhost');
  let body: unknown = null;
  const rawBody =
    typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : '';
  if (rawBody) body = JSON.parse(rawBody) as unknown;
  requests.push({ method, url, body });

  if (url.pathname === '/api/opencode/chat/ensure') {
    return Response.json({ baseUrl: BASE_URL, directory: CANONICAL_DIRECTORY });
  }
  if (url.pathname === '/session/session-1' && method === 'GET') {
    const session = sessionResponses.shift();
    if (!session) return Response.json({ error: 'missing fixture' }, { status: 500 });
    return Response.json(session);
  }
  if (url.pathname === '/experimental/control-plane/move-session' && method === 'POST') {
    return new Response(null, { status: moveStatus });
  }
  return Response.json({ error: `unexpected ${method} ${url.pathname}` }, { status: 404 });
}

beforeEach(() => {
  resetOpencodeClient(WORKSPACE);
  sessionResponses = [];
  moveStatus = 204;
  requests = [];
  globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  resetOpencodeClient(WORKSPACE);
  globalThis.fetch = originalFetch;
});

describe('OpenCode session relocation helpers', () => {
  test('returns the exact canonical directory reported by bootstrap', async () => {
    await expect(getOpencodeCanonicalDirectory(WORKSPACE)).resolves.toBe(CANONICAL_DIRECTORY);
  });

  test('captures the source, posts moveChanges false, and accepts a Windows-equivalent destination', async () => {
    const sourceDirectory = 'C:\\Repo\\.tagma';
    const destinationDirectory = 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma';
    const returnedDestinationDirectory =
      'c:\\repo\\.tagma\\.chat-staging\\stage-1\\agent-workspace\\.tagma';
    sessionResponses = [
      { id: 'session-1', directory: sourceDirectory },
      { id: 'session-1', directory: sourceDirectory },
      { id: 'session-1', directory: returnedDestinationDirectory },
    ];

    const result = await moveOpencodeSessionDirectory({
      sessionID: 'session-1',
      destinationDirectory,
      workspaceKey: WORKSPACE,
      verification: { timeoutMs: 100, pollIntervalMs: 0 },
    });

    expect(result.moved).toBe(true);
    expect(result.sourceDirectory).toBe(sourceDirectory);
    expect(result.destinationDirectory).toBe(destinationDirectory);
    expect(result.session).toMatchObject({
      id: 'session-1',
      directory: returnedDestinationDirectory,
    });
    const operations = requests
      .filter((request) => request.url.origin === BASE_URL)
      .map((request) => `${request.method} ${request.url.pathname}`);
    expect(operations).toEqual([
      'GET /session/session-1',
      'POST /experimental/control-plane/move-session',
      'GET /session/session-1',
      'GET /session/session-1',
    ]);
    expect(
      requests.find(
        (request) => request.url.pathname === '/experimental/control-plane/move-session',
      )?.body,
    ).toEqual({
      sessionID: 'session-1',
      destination: { directory: destinationDirectory },
      moveChanges: false,
    });
  });

  test('is idempotent only when the exact source already equals the destination', async () => {
    const destinationDirectory = 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma';
    sessionResponses = [{ id: 'session-1', directory: destinationDirectory }];

    const result = await moveOpencodeSessionDirectory({
      sessionID: 'session-1',
      destinationDirectory,
      workspaceKey: WORKSPACE,
    });

    expect(result.moved).toBe(false);
    expect(result.sourceDirectory).toBe(destinationDirectory);
    expect(
      requests.some(
        (request) => request.url.pathname === '/experimental/control-plane/move-session',
      ),
    ).toBe(false);
  });

  test('treats Windows drive casing and separators as the same allowed source', async () => {
    const returnedDirectory = 'c:\\repo\\.tagma';
    sessionResponses = [{ id: 'session-1', directory: returnedDirectory }];

    const result = await moveOpencodeSessionDirectory({
      sessionID: 'session-1',
      destinationDirectory: CANONICAL_DIRECTORY,
      expectedSourceDirectories: [CANONICAL_DIRECTORY],
      workspaceKey: WORKSPACE,
    });

    expect(result).toMatchObject({
      moved: false,
      sourceDirectory: returnedDirectory,
      destinationDirectory: CANONICAL_DIRECTORY,
    });
    expect(
      requests.some(
        (request) => request.url.pathname === '/experimental/control-plane/move-session',
      ),
    ).toBe(false);
  });

  test('keeps POSIX directory comparisons case-sensitive', async () => {
    sessionResponses = [{ id: 'session-1', directory: '/Repo/.tagma' }];

    await expect(
      moveOpencodeSessionDirectory({
        sessionID: 'session-1',
        destinationDirectory: '/repo/.tagma',
        expectedSourceDirectories: ['/repo/.tagma'],
        workspaceKey: WORKSPACE,
      }),
    ).rejects.toThrow('unexpected source directory');
    expect(
      requests.some(
        (request) => request.url.pathname === '/experimental/control-plane/move-session',
      ),
    ).toBe(false);
  });

  test('rejects workspace sessions before attempting a move', async () => {
    sessionResponses = [
      { id: 'session-1', directory: CANONICAL_DIRECTORY, workspaceID: 'worktree-1' },
    ];

    await expect(
      moveOpencodeSessionDirectory({
        sessionID: 'session-1',
        destinationDirectory: 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma',
        workspaceKey: WORKSPACE,
      }),
    ).rejects.toThrow('workspaceID');
    expect(
      requests.some(
        (request) => request.url.pathname === '/experimental/control-plane/move-session',
      ),
    ).toBe(false);
  });

  test('rejects an empty or relative destination before any session mutation', async () => {
    for (const destinationDirectory of ['', 'relative/.tagma']) {
      requests = [];
      resetOpencodeClient(WORKSPACE);
      await expect(
        moveOpencodeSessionDirectory({
          sessionID: 'session-1',
          destinationDirectory,
          workspaceKey: WORKSPACE,
        }),
      ).rejects.toThrow('absolute');
      expect(
        requests.some(
          (request) =>
            request.url.pathname === '/session/session-1' ||
            request.url.pathname === '/experimental/control-plane/move-session',
        ),
      ).toBe(false);
    }
  });

  test('requires the control-plane endpoint to return 204 without inspecting data', async () => {
    sessionResponses = [{ id: 'session-1', directory: CANONICAL_DIRECTORY }];
    moveStatus = 200;

    await expect(
      moveOpencodeSessionDirectory({
        sessionID: 'session-1',
        destinationDirectory: 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma',
        workspaceKey: WORKSPACE,
      }),
    ).rejects.toThrow('expected 204');
    expect(
      requests.filter((request) => request.url.pathname === '/session/session-1'),
    ).toHaveLength(1);
  });
});
