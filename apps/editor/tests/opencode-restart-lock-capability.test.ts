import { afterEach, expect, test } from 'bun:test';
import { setClientAuthToken, setClientWorkspace } from '../src/api/client';
import { resetOpencodeClient, restartOpencodeForConfig } from '../src/api/opencode-chat';

const originalFetch = globalThis.fetch;

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? (record[key] ?? null) : null;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setClientAuthToken(null);
  setClientWorkspace(null);
  resetOpencodeClient();
});

test('restartOpencodeForConfig presents a YAML lock capability only for explicit force-stop', async () => {
  const lockHeaders: Array<string | null> = [];
  let resolveForcedRestart!: (response: Response) => void;
  const forcedRestartResponse = new Promise<Response>((resolve) => {
    resolveForcedRestart = resolve;
  });
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const lockHeader = headerValue(init?.headers, 'X-Tagma-Yaml-Lock-Id');
    lockHeaders.push(lockHeader);
    if (lockHeader === 'owner-lease-id' && lockHeaders.length === 3) return forcedRestartResponse;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          baseUrl: `http://opencode-${lockHeaders.length}.test`,
          authHeader: 'Bearer runtime',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }) as typeof fetch;
  const restart = restartOpencodeForConfig as (
    workspaceKey: string,
    options?: { forceStop?: boolean; yamlEditLockId?: string | null },
  ) => Promise<void>;

  await restart('C:/locked-workspace');
  await restart('C:/locked-workspace', { yamlEditLockId: 'owner-lease-id' });
  const forcedRestart = restart('C:/locked-workspace', {
    forceStop: true,
    yamlEditLockId: 'owner-lease-id',
  });
  while (lockHeaders.length < 3) await Promise.resolve();
  await restart('C:/locked-workspace');

  expect(lockHeaders).toEqual([null, null, 'owner-lease-id', null]);

  resolveForcedRestart(
    new Response(JSON.stringify({ ok: true, baseUrl: 'http://opencode-forced.test' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await forcedRestart;
});
