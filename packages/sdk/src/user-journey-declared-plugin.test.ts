import { describe, expect, test } from 'bun:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTagma } from './index';

const firstPartyWebhookPlugin = fileURLToPath(new URL('../../trigger-webhook/', import.meta.url));
const firstPartyTypesPackage = fileURLToPath(new URL('../../types/', import.meta.url));

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-declared-plugin-journey-'));
}

/**
 * Install the published-package shape into a consumer workspace. This avoids
 * importing source or registering a test double: plugin resolution must find
 * the real first-party package in the workspace's node_modules directory.
 */
function installBuiltPackage(source: string, destination: string): void {
  const builtEntry = join(source, 'dist', 'index.js');
  expect(existsSync(builtEntry), `expected built package entry at ${builtEntry}`).toBe(true);

  mkdirSync(destination, { recursive: true });
  copyFileSync(join(source, 'package.json'), join(destination, 'package.json'));
  cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
}

function installDeclaredWebhookPlugin(workspace: string): void {
  const scopeDir = join(workspace, 'node_modules', '@tagma');
  installBuiltPackage(firstPartyTypesPackage, join(scopeDir, 'types'));
  installBuiltPackage(firstPartyWebhookPlugin, join(scopeDir, 'trigger-webhook'));
}

function reservePort(): number {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response('reserved');
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function postWhenWebhookIsReady(url: string): Promise<number> {
  let lastFailure = 'the webhook listener did not start';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      if (response.status === 202) return response.status;
      lastFailure = `received HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(20);
  }
  throw new Error(`declared webhook plugin never accepted its event: ${lastFailure}`);
}

describe('user journey - declared first-party plugin in a consumer workspace', () => {
  test('loads a YAML-declared plugin only after explicit opt-in and runs it through the Bun runtime', async () => {
    const workspace = makeWorkspace();
    const port = reservePort();
    const webhookPath = '/release-approved';
    const outputPath = join(workspace, 'artifacts', 'release-approved.txt');
    const command = [
      process.execPath,
      '-e',
      [
        'const fs = require("node:fs");',
        `fs.mkdirSync(${JSON.stringify(dirname(outputPath))}, { recursive: true });`,
        `fs.writeFileSync(${JSON.stringify(outputPath)}, "release approved", "utf8");`,
        'process.stdout.write("release approved");',
      ].join(' '),
    ];
    const yaml = `pipeline:
  name: declared-plugin-user-journey
  plugins:
    - '@tagma/trigger-webhook'
  tracks:
    - id: release
      name: Release
      tasks:
        - id: publish
          name: Publish after approval
          trigger:
            type: webhook
            host: 127.0.0.1
            port: ${port}
            path: ${webhookPath}
            timeout: 5s
          command:
            argv: ${JSON.stringify(command)}
`;

    try {
      installDeclaredWebhookPlugin(workspace);

      const tagma = createTagma();
      await expect(tagma.runYaml(yaml, { cwd: workspace })).rejects.toThrow(
        /trigger "webhook" not registered/,
      );
      expect(tagma.registry.hasHandler('triggers', 'webhook')).toBe(false);

      const running = tagma.runYaml(yaml, { cwd: workspace, loadDeclaredPlugins: true });
      await expect(postWhenWebhookIsReady(`http://127.0.0.1:${port}${webhookPath}`)).resolves.toBe(
        202,
      );

      const result = await running;
      expect(result.kind).toBe('pipeline');
      if (result.kind !== 'pipeline') return;

      expect(result.result.success).toBe(true);
      expect(tagma.registry.hasHandler('triggers', 'webhook')).toBe(true);
      expect(readFileSync(outputPath, 'utf8')).toBe('release approved');
      expect(result.result.states.get('release.publish')?.result?.stdout).toBe('release approved');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
