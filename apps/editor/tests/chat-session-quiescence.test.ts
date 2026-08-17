import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resetOpencodeClient } from '../src/api/opencode-chat';
import { waitForRelocatedSessionQuiescence } from '../src/store/chat-store';

const WORKSPACE = 'C:/repo';
const HOME = 'C:/repo/.tagma';
const STAGE = 'C:/repo/.tagma/.chat-staging/stage-1/agent-workspace/.tagma';
const ROOT_ID = 'ses-root';
const CHILD_ID = 'ses-child';

const originalFetch = globalThis.fetch;

interface Fixture {
  busyPolls: number;
  busyIds: string[];
}

let fixture: Fixture;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Minimal OpenCode stand-in for the quiescence wait: a root session with one
 * delegated child, both living in the staging directory. `/session/status`
 * reports `fixture.busyIds` as busy for `fixture.busyPolls` polls, then idle.
 */
async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(rawUrl, 'http://localhost');
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

  if (url.pathname === '/api/opencode/chat/ensure') {
    return json({ baseUrl: 'http://opencode-quiescence.test', directory: HOME });
  }
  if (url.pathname === `/session/${ROOT_ID}` && method === 'GET') {
    return json({ id: ROOT_ID, title: 'root', directory: STAGE });
  }
  if (url.pathname === `/session/${ROOT_ID}/children` && method === 'GET') {
    return json([{ id: CHILD_ID, title: 'child', directory: STAGE, parentID: ROOT_ID }]);
  }
  if (url.pathname === `/session/${CHILD_ID}/children` && method === 'GET') {
    return json([]);
  }
  if (url.pathname === '/session/status' && method === 'GET') {
    const directory = url.searchParams.get('directory');
    if (directory === STAGE && fixture.busyPolls > 0) {
      fixture.busyPolls -= 1;
      return json(Object.fromEntries(fixture.busyIds.map((id) => [id, { type: 'busy' }])));
    }
    return json({});
  }
  if (url.pathname === '/permission' || url.pathname === '/question') {
    return json([]);
  }
  if (/^\/session\/[^/]+\/message$/.test(url.pathname)) {
    return json([]);
  }
  return json({ error: `unexpected ${method} ${url.pathname}` }, 404);
}

beforeEach(() => {
  resetOpencodeClient(WORKSPACE);
  fixture = { busyPolls: 0, busyIds: [] };
  globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  resetOpencodeClient(WORKSPACE);
  globalThis.fetch = originalFetch;
});

describe('waitForRelocatedSessionQuiescence', () => {
  test('deadline error names the sessions still blocking the restore', async () => {
    // Live incident F1: a delegated child kept reporting busy long after its
    // task completed, and the deadline error discarded that identity.
    fixture = { busyPolls: Number.MAX_SAFE_INTEGER, busyIds: [CHILD_ID] };

    const error = await waitForRelocatedSessionQuiescence(
      WORKSPACE,
      ROOT_ID,
      STAGE,
      false,
      300,
      false,
      [HOME, STAGE],
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('did not become idle before the staged session restore deadline');
    expect(message).toContain(CHILD_ID);
    expect(message).toContain('busy');
    expect(message).toContain(STAGE);
  });

  test('resolves once a delegated child settles before the deadline', async () => {
    fixture = { busyPolls: 2, busyIds: [CHILD_ID] };

    await expect(
      waitForRelocatedSessionQuiescence(WORKSPACE, ROOT_ID, STAGE, false, 5_000, false, [
        HOME,
        STAGE,
      ]),
    ).resolves.toBeUndefined();
  });
});
