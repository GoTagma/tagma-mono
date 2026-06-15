import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { waitForTcpPort } from '../scripts/dev';

const editorRoot = join(import.meta.dir, '..');

describe('editor dev startup scripts', () => {
  test('starts through an ordered dev launcher instead of racing server and client', () => {
    const pkg = JSON.parse(readFileSync(join(editorRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.dev).toBe('bun scripts/dev.ts');
    expect(pkg.scripts['dev:server:watch']).toBe('bun --watch server/index.ts');
    expect(pkg.scripts['dev:server']).toBe('bun run ensure:opencode && bun run dev:server:watch');
  });

  test('proxies API requests to the loopback sidecar port selected by desktop HMR', () => {
    const viteConfig = readFileSync(join(editorRoot, 'vite.config.ts'), 'utf-8');

    expect(viteConfig).toContain(
      "const desktopRendererPort = positivePortFromEnv('TAGMA_DESKTOP_RENDERER_PORT', 5173);",
    );
    expect(viteConfig).toContain('port: desktopRendererPort');
    expect(viteConfig).toContain(
      "const desktopSidecarPort = process.env.TAGMA_DESKTOP_SIDECAR_PORT ?? '3001';",
    );
    expect(viteConfig).toContain("'/api': `http://127.0.0.1:${desktopSidecarPort}`");
  });

  test('waits for a TCP port before continuing startup', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('expected an ephemeral TCP port');
    }

    try {
      await waitForTcpPort({
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 1_000,
        intervalMs: 10,
        connectTimeoutMs: 100,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
