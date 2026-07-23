const binaryPath = process.argv[2];
const directory = process.argv[3];
if (!binaryPath || !directory) {
  throw new Error(
    'usage: bun scripts/.tmp-opencode-session-api-audit.ts <opencode-binary> <directory>',
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
  {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  },
);

const baseUrl = `http://127.0.0.1:${port}`;

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/path`);
      if (response.ok) return;
    } catch {
      // The process has not bound its loopback port yet.
    }
    await Bun.sleep(100);
  }
  throw new Error('OpenCode server did not become ready');
}

async function list(path: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  const body = JSON.parse(text);
  if (!Array.isArray(body)) throw new Error(`${path} returned a non-array body`);
  return body as Record<string, unknown>[];
}

function summarize(rows: Record<string, unknown>[]) {
  return {
    count: rows.length,
    rows: rows.slice(0, 20).map((row) => ({
      id: row.id,
      directory: row.directory,
      parentID: row.parentID,
      hasMetadata: Object.prototype.hasOwnProperty.call(row, 'metadata'),
      metadata: row.metadata,
    })),
  };
}

try {
  await waitUntilReady();
  const encodedDirectory = encodeURIComponent(directory);
  const [unscoped, scoped] = await Promise.all([
    list('/session'),
    list(`/session?directory=${encodedDirectory}`),
  ]);
  console.log(
    JSON.stringify(
      {
        serverDirectory: directory,
        unscoped: summarize(unscoped),
        scoped: summarize(scoped),
      },
      null,
      2,
    ),
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
}
