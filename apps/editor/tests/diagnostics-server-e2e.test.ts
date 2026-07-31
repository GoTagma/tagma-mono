import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeWorkspaceKey } from '../server/workspace-registry.js';

const editorRoot = join(import.meta.dir, '..');

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>,
  output: string[],
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Sidecar readiness timed out.\n${output.join('')}`));
    }, 20_000);

    const drain = async (
      stream: ReadableStream<Uint8Array>,
      inspectReady: boolean,
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output.push(text);
        if (!inspectReady || settled) continue;
        carry += text;
        const match = carry.match(/TAGMA_READY port=(\d+)/);
        if (match) {
          settled = true;
          clearTimeout(timeout);
          resolve(Number(match[1]));
        } else if (carry.length > 8_192) {
          carry = carry.slice(-4_096);
        }
      }
      if (inspectReady && !settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited before readiness.\n${output.join('')}`));
      }
    };

    void drain(proc.stdout as ReadableStream<Uint8Array>, true);
    void drain(proc.stderr as ReadableStream<Uint8Array>, false);
  });
}

test(
  'real sidecar exposes only the temporary read-only diagnostics protocol',
  async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-diagnostics-e2e-'));
    const workspace = join(tempRoot, 'workspace');
    const globalSettingsDir = join(tempRoot, 'global-settings');
    const desktopLogFile = join(tempRoot, 'sidecar.log');
    mkdirSync(join(workspace, '.tagma'), { recursive: true });
    mkdirSync(globalSettingsDir, { recursive: true });
    writeFileSync(desktopLogFile, '2026-07-31T00:00:00.000Z stdout: release-log-line\n');

    const output: string[] = [];
    const managementToken = 'management-token-for-e2e';
    let origin: string | null = null;
    const proc = Bun.spawn([process.execPath, join(editorRoot, 'server/index.ts')], {
      cwd: editorRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        TAGMA_AUTH_TOKEN: managementToken,
        TAGMA_GLOBAL_SETTINGS_DIR: globalSettingsDir,
        TAGMA_DESKTOP_LOG_FILE: desktopLogFile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const port = await waitForReady(proc, output);
      origin = `http://127.0.0.1:${port}`;
      const managementHeaders = {
        Authorization: `Bearer ${managementToken}`,
        'X-Tagma-Workspace': workspace,
      };

      const enableResponse = await fetch(`${origin}/api/diagnostics/session`, {
        method: 'POST',
        headers: managementHeaders,
      });
      expect(enableResponse.status).toBe(200);
      const enabled = (await enableResponse.json()) as {
        enabled: boolean;
        connection: { token: string; baseUrl: string };
      };
      expect(enabled.enabled).toBe(true);
      expect(enabled.connection.baseUrl).toBe(`${origin}/api/diagnostics/v1`);
      expect(enabled.connection.token).not.toBe(managementToken);

      const diagnosticsHeaders = {
        Authorization: `Bearer ${enabled.connection.token}`,
      };
      const manifestResponse = await fetch(
        `${enabled.connection.baseUrl}/manifest`,
        { headers: diagnosticsHeaders },
      );
      expect(manifestResponse.status).toBe(200);
      expect(await manifestResponse.json()).toMatchObject({
        readOnly: true,
        sessionScoped: true,
        extensibility: { contextNamespace: 'features' },
      });

      const contextResponse = await fetch(
        `${enabled.connection.baseUrl}/context`,
        { headers: diagnosticsHeaders },
      );
      expect(contextResponse.status).toBe(200);
      expect(await contextResponse.json()).toMatchObject({
        workspace: { key: normalizeWorkspaceKey(workspace) },
        opencode: [],
        features: {},
      });

      const logsResponse = await fetch(
        `${enabled.connection.baseUrl}/logs?after=0&limit=10`,
        { headers: diagnosticsHeaders },
      );
      expect(logsResponse.status).toBe(200);
      expect(await logsResponse.json()).toMatchObject({
        desktopLogTail: { path: desktopLogFile, text: expect.stringContaining('release-log-line') },
      });

      const opencodeResponse = await fetch(
        `${enabled.connection.baseUrl}/opencode/sessions`,
        { headers: diagnosticsHeaders },
      );
      expect(opencodeResponse.status).toBe(409);

      const normalApiResponse = await fetch(`${origin}/api/fs/roots`, {
        headers: diagnosticsHeaders,
      });
      expect(normalApiResponse.status).toBe(403);

      const mutationResponse = await fetch(`${enabled.connection.baseUrl}/context`, {
        method: 'POST',
        headers: diagnosticsHeaders,
      });
      expect(mutationResponse.status).toBe(405);

      const disableResponse = await fetch(`${origin}/api/diagnostics/session`, {
        method: 'DELETE',
        headers: managementHeaders,
      });
      expect(disableResponse.status).toBe(200);

      const revokedResponse = await fetch(`${enabled.connection.baseUrl}/manifest`, {
        headers: diagnosticsHeaders,
      });
      expect(revokedResponse.status).toBe(403);
    } finally {
      if (origin) {
        await fetch(`${origin}/api/shutdown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${managementToken}` },
          signal: AbortSignal.timeout(1_500),
        }).catch(() => undefined);
      }
      const exitedCleanly = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!exitedCleanly) proc.kill();
      await proc.exited;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
  30_000,
);
