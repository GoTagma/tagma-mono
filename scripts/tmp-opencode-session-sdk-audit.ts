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

function summarize(rows: Record<string, unknown>[]) {
  return {
    count: rows.length,
    rows: rows.slice(0, 20).map((row) => ({
      id: row.id,
      directory: row.directory,
      parentID: row.parentID,
      metadata: row.metadata,
    })),
  };
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
  console.log(JSON.stringify(summarize(result.data as unknown as Record<string, unknown>[]), null, 2));
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
}
