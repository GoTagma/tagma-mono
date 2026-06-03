import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { registerPluginRoutes } from '../server/routes/plugins';
import { WorkspaceState } from '../server/workspace-state';

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

function postJsonBody(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        [
          `POST ${path} HTTP/1.0`,
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(payload)}`,
          'Connection: close',
          '',
          payload,
        ].join('\r\n'),
      );
    });
    let buffer = Buffer.alloc(0);
    let resolved = false;
    const finish = (result: { status: number; body: string }) => {
      if (resolved) return;
      resolved = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    sock.on('data', (chunk: Buffer) => {
      if (resolved) return;
      buffer = Buffer.concat([buffer, chunk]);
      const raw = buffer.toString('utf-8');
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headerBlock = raw.slice(0, sep);
      const statusLine = headerBlock.split('\r\n', 1)[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      const lengthMatch = headerBlock.match(/^content-length:\s*(\d+)/im);
      const declared = lengthMatch ? Number(lengthMatch[1]) : null;
      const bodyStart = sep + 4;
      const bodyBytes = buffer.byteLength - bodyStart;
      if (declared === null || bodyBytes >= declared) {
        finish({
          status: match ? Number(match[1]) : 0,
          body:
            declared === null
              ? raw.slice(bodyStart)
              : buffer.slice(bodyStart, bodyStart + declared).toString('utf-8'),
        });
      }
    });
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

let tempDir: string;
let ws: WorkspaceState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-plugin-uninstall-'));
  mkdirSync(join(tempDir, '.tagma'), { recursive: true });
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;
  ws.loadedPluginMeta.set('@tagma/driver-foo', {
    registrations: [{ category: 'drivers', type: 'foo' }],
  });
});

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspace = ws;
    next();
  });
  registerPluginRoutes(app);
  return app;
}

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('local import checks the picker capability before probing the path', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const missingPath = join(tempDir, 'missing-plugin.tgz');
    const res = await postJsonBody(port, '/api/plugins/import-local', { path: missingPath });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toMatch(/requires a one-time filesystem capability/);
    expect(body.error).not.toContain(missingPath);
  } finally {
    await close();
  }
});

test('uninstall rejects newly discovered impacts not acknowledged by the client', async () => {
  // Foldered pipeline layout: .tagma/<stem>/<stem>.yaml
  const pipelineFolder = join(tempDir, '.tagma', 'pipeline');
  mkdirSync(pipelineFolder, { recursive: true });
  writeFileSync(
    join(pipelineFolder, 'pipeline.yaml'),
    [
      'pipeline:',
      '  name: Uses Foo',
      '  plugins:',
      '    - "@tagma/driver-foo"',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: task',
      '          name: Task',
      '          driver: foo',
      '          prompt: hello',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonBody(port, '/api/plugins/uninstall', {
      name: '@tagma/driver-foo',
      acknowledgedImpacts: [],
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as {
      kind?: string;
      impact?: { impacts?: Array<{ file: string; location: string }> };
    };
    expect(body.kind).toBe('impact-changed');
    expect(body.impact?.impacts).toContainEqual(
      expect.objectContaining({
        file: '.tagma/pipeline/pipeline.yaml',
        location: 'tracks[0].tasks[0].driver',
      }),
    );
  } finally {
    await close();
  }
});

test('uninstall impact includes pipeline plugin declarations', async () => {
  const pipelineFolder = join(tempDir, '.tagma', 'pipeline');
  mkdirSync(pipelineFolder, { recursive: true });
  writeFileSync(
    join(pipelineFolder, 'pipeline.yaml'),
    [
      'pipeline:',
      '  name: Declares Foo',
      '  plugins:',
      '    - "@tagma/driver-foo"',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks: []',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonBody(port, '/api/plugins/uninstall', {
      name: '@tagma/driver-foo',
      acknowledgedImpacts: [],
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as {
      kind?: string;
      impact?: { impacts?: Array<{ file: string; location: string; trackId: string }> };
    };
    expect(body.kind).toBe('impact-changed');
    expect(body.impact?.impacts).toContainEqual(
      expect.objectContaining({
        file: '.tagma/pipeline/pipeline.yaml',
        location: 'pipeline.plugins[0]',
        trackId: 'pipeline',
      }),
    );
  } finally {
    await close();
  }
});

test('uninstall impact reports top-level plugin declaration locations accurately', async () => {
  const pipelineFolder = join(tempDir, '.tagma', 'pipeline');
  mkdirSync(pipelineFolder, { recursive: true });
  writeFileSync(
    join(pipelineFolder, 'pipeline.yaml'),
    ['name: Flat Declares Foo', 'plugins:', '  - "@tagma/driver-foo"', 'tracks: []', ''].join('\n'),
    'utf-8',
  );

  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonBody(port, '/api/plugins/uninstall', {
      name: '@tagma/driver-foo',
      acknowledgedImpacts: [],
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as {
      impact?: { impacts?: Array<{ location: string }> };
    };
    expect(body.impact?.impacts).toContainEqual(
      expect.objectContaining({ location: 'plugins[0]' }),
    );
  } finally {
    await close();
  }
});

test('uninstall impact includes the current unsaved pipeline config', async () => {
  ws.config = {
    name: 'Unsaved Uses Foo',
    plugins: ['@tagma/driver-foo'],
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'task',
            name: 'Task',
            driver: 'foo',
            prompt: 'hello',
          },
        ],
      },
    ],
  };

  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonBody(port, '/api/plugins/uninstall', {
      name: '@tagma/driver-foo',
      acknowledgedImpacts: [],
    });
    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as {
      impact?: { impacts?: Array<{ file: string; location: string }> };
    };
    expect(body.impact?.impacts).toContainEqual(
      expect.objectContaining({
        file: '(current pipeline)',
        location: 'plugins[0]',
      }),
    );
    expect(body.impact?.impacts).toContainEqual(
      expect.objectContaining({
        file: '(current pipeline)',
        location: 'tracks[0].tasks[0].driver',
      }),
    );
  } finally {
    await close();
  }
});
