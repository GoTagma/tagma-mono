import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawPipelineConfig } from '../src/api/client';
import { registerRunRoutes } from '../server/routes/run';
import { WorkspaceState } from '../server/workspace-state';
import { serializePipeline } from '@tagma/sdk/yaml';

let tempDir = '';
let ws: WorkspaceState;

function config(name: string): RawPipelineConfig {
  return {
    name,
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'noop', name: 'Noop', command: 'echo ok' }],
      },
    ],
  };
}

function startApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspace = ws;
    next();
  });
  registerRunRoutes(app);
  return app;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf-8');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-run-snapshot-'));
  const pipelineDir = join(tempDir, '.tagma', 'live');
  mkdirSync(pipelineDir, { recursive: true });
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;
  ws.yamlPath = join(pipelineDir, 'live.yaml');
  ws.config = config('Disk');
  writeFileSync(ws.yamlPath, serializePipeline(ws.config), 'utf-8');
});

afterEach(async () => {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test('POST /api/run/start executes and persists the supplied config snapshot instead of rereading disk YAML', async () => {
  const snapshot = config('Snapshot');
  const { port, close } = await startApp(buildApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/run/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yamlPath: ws.yamlPath, configSnapshot: snapshot }),
    });
    const responseBody = await res.text();
    expect(res.status, responseBody).toBe(200);
    const body = JSON.parse(responseBody) as { runId: string };
    const runYaml = await waitForFile(join(tempDir, '.tagma', 'logs', body.runId, 'pipeline.yaml'));

    expect(runYaml).toContain('name: Snapshot');
    expect(runYaml).not.toContain('name: Disk');
    expect(ws.config.name).toBe('Disk');
  } finally {
    await close();
  }
});
