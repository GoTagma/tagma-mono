import { createOpencodeClient } from '@opencode-ai/sdk/client';

const binaryPath = process.argv[2];
const directory = process.argv[3];
if (!binaryPath || !directory) {
  throw new Error(
    'usage: bun scripts/tmp-opencode-session-sdk-audit.ts <opencode-binary> <directory>',
  );
}

const portProbe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
const port = portProbe.port;
await portProbe.stop(true);

const proc = Bun.spawn(
  [
    binaryPath,
    'serve',
    '--pure',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
    '--log-level',
    'ERROR',
  ],
  { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
);

const baseUrl = `http://127.0.0.1:${port}`;

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/path`);
      if (response.ok) return;
    } catch {
      // The loopback server has not bound its port yet.
    }
    await Bun.sleep(100);
  }
  throw new Error('OpenCode server did not become ready');
}

try {
  await waitUntilReady();
  const client = createOpencodeClient({
    baseUrl,
    directory,
    throwOnError: true,
  });
  const result = await client.session.list({ query: { directory } });
  if (result.error) throw result.error;
  if (!result.data) throw new Error('SDK session.list returned no data');
  console.log(
    JSON.stringify(
      {
        count: result.data.length,
        sessions: result.data.slice(0, 20).map((session) => ({
          id: session.id,
          directory: session.directory,
          parentID: session.parentID,
          metadata: (session as typeof session & { metadata?: unknown }).metadata,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
}
