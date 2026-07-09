import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  editorDevScriptArgs,
  viteCliPath,
  waitForTcpPort,
  windowsTaskkillArgs,
} from '../scripts/dev';

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

  test('tracks real long-running dev processes instead of bun run wrappers', () => {
    expect(editorDevScriptArgs('ensure:opencode')).toEqual([
      process.execPath,
      '../electron/scripts/fetch-opencode.mjs',
    ]);
    expect(editorDevScriptArgs('dev:server:watch')).toEqual([
      process.execPath,
      '--watch',
      'server/index.ts',
    ]);
    expect(editorDevScriptArgs('dev:client')).toEqual([process.env.NODE ?? 'node', viteCliPath()]);
    expect(editorDevScriptArgs('dev:client')).not.toContain('run');
  });

  test('stops full child process trees on Windows', () => {
    expect(windowsTaskkillArgs(1234, false)).toEqual(['/T', '/PID', '1234']);
    expect(windowsTaskkillArgs(1234, true)).toEqual(['/F', '/T', '/PID', '1234']);
  });

  test('launcher cleans up children for console close and process exit paths', () => {
    const source = readFileSync(join(editorRoot, 'scripts', 'dev.ts'), 'utf-8');

    expect(source).toContain("'SIGBREAK'");
    expect(source).toContain("'SIGHUP'");
    expect(source).toContain("process.once('exit'");
    expect(source).toContain('killTrackedChildrenSync(children)');
  });

  test('server handles Windows console close signals during graceful shutdown', () => {
    const source = readFileSync(join(editorRoot, 'server', 'index.ts'), 'utf-8');

    expect(source).toContain("process.on('SIGBREAK', gracefulShutdown);");
    expect(source).toContain("process.on('SIGHUP', gracefulShutdown);");
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
