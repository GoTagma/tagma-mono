import { createOpencodeClient } from '@opencode-ai/sdk/client';
import {
  buildOpencodeEnv,
  createOpencodeServerAuth,
} from '../server/opencode-lifecycle';

const binaryPath = process.argv[2];
const directory = process.argv[3];
if (!binaryPath || !directory) {
  throw new Error(
    'usage: bun scripts/tmp-opencode-production-env-audit.ts <opencode-binary> <directory>',
  );
}

const portProbe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
const port = portProbe.port;
await portProbe.stop(true);

const auth = createOpencodeServerAuth();
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
    env: buildOpencodeEnv(directory, auth),
    stdout: 'pipe',
    stderr: 'pipe',
  },
);

const baseUrl = `http://127.0.0.1:${port}`;

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/path`, {
        headers: { Authorization: auth.authorization },
      });
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
    headers: { Authorization: auth.authorization },
    throwOnError: true,
  });
  const [unscoped, scoped] = await Promise.all([
    client.session.list(),
    client.session.list({ query: { directory } }),
  ]);
  if (unscoped.error) throw unscoped.error;
  if (scoped.error) throw scoped.error;
  console.log(
    JSON.stringify(
      {
        runtimeDataHome: buildOpencodeEnv(directory, auth).XDG_DATA_HOME,
        unscopedCount: unscoped.data?.length ?? 0,
        scopedCount: scoped.data?.length ?? 0,
        scopedSessions:
          scoped.data?.slice(0, 20).map((session) => ({
            id: session.id,
            directory: session.directory,
            parentID: session.parentID,
            metadata: (session as typeof session & { metadata?: unknown }).metadata,
          })) ?? [],
      },
      null,
      2,
    ),
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => undefined);
}
