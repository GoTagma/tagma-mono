import { beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import {
  beginRunSessionStart,
  endRunSessionStart,
  isRunSessionStarting,
  registerRunRoutes,
  RunSession,
} from '../server/routes/run';
import { WorkspaceState } from '../server/workspace-state';
import type { RawPipelineConfig } from '../src/api/client';

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

function getReq(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        [`GET ${path} HTTP/1.0`, 'Host: 127.0.0.1', 'Connection: close', '', ''].join('\r\n'),
      );
    });
    let buffer = Buffer.alloc(0);
    let resolved = false;
    const finish = (result: { status: number; body: string }) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
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

function postJsonReq(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
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
      sock.destroy();
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

async function removeTempDir(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        attempt === 9 ||
        !(err instanceof Error) ||
        !('code' in err) ||
        (err as NodeJS.ErrnoException).code !== 'EBUSY'
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function waitForSessionDone(runId: string): Promise<void> {
  const sessions = (ws as unknown as { runSessions: Map<string, RunSession> }).runSessions;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const session = sessions.get(runId) ?? null;
    if (!session || (session as unknown as { done?: boolean }).done) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-run-history-live-'));
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;

  const session = new RunSession(
    'run_live',
    {
      name: 'Live Pipeline',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'build', name: 'Build', command: 'echo build' }],
        },
      ],
    },
    null,
    undefined,
    7,
  );
  session.seedTasks();
  session.ingest({
    type: 'task_update',
    runId: 'run_live',
    taskId: 'main.build',
    status: 'running',
    startedAt: '2026-05-22T08:00:00.000Z',
  });
  ws.runSessions.set(session.runId, session);
});

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

test('history lists the active run even before a persisted summary exists', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(port, '/api/run/history');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      runs: Array<{
        runId: string;
        running?: boolean;
        pipelineName?: string;
        success?: boolean;
        taskCounts?: { running: number; total: number };
      }>;
    };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      runId: 'run_live',
      running: true,
      pipelineName: 'Live Pipeline',
      taskCounts: { running: 1, total: 1 },
    });
    expect('success' in body.runs[0]!).toBe(false);
  } finally {
    await close();
    await removeTempDir();
  }
});

test('history summary for the active run reflects the live task mirror', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(port, '/api/run/history/run_live/summary');
    expect(res.status).toBe(200);
    const summary = JSON.parse(res.body) as {
      runId: string;
      running?: boolean;
      finishedAt: string | null;
      tasks: Array<{ taskId: string; status: string; startedAt: string | null }>;
    };
    expect(summary.runId).toBe('run_live');
    expect(summary.running).toBe(true);
    expect(summary.finishedAt).toBeNull();
    expect(summary.tasks).toHaveLength(1);
    expect(summary.tasks[0]).toMatchObject({
      taskId: 'main.build',
      status: 'running',
      startedAt: '2026-05-22T08:00:00.000Z',
    });
  } finally {
    await close();
    await removeTempDir();
  }
});

test('abort rejects an invalid run id instead of aborting the current run', async () => {
  const session = ws.runSessions.get('run_live') as RunSession;
  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonReq(port, '/api/run/abort', { runId: 'not-a-run-id' });
    expect(res.status).toBe(400);
    expect(session.abort.signal.aborted).toBe(false);
  } finally {
    await close();
    await removeTempDir();
  }
});

test('run start lock is only released by the owner token', async () => {
  const token = beginRunSessionStart(ws);
  expect(token).not.toBeNull();
  expect(isRunSessionStarting(ws)).toBe(true);

  endRunSessionStart(ws, Symbol('other start'));
  expect(isRunSessionStarting(ws)).toBe(true);

  endRunSessionStart(ws, token!);
  expect(isRunSessionStarting(ws)).toBe(false);
});

test('run start accepts a new instance while another run is live', async () => {
  ws.config = {
    name: 'Concurrent Pipeline',
    mode: 'trusted',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'echo',
            name: 'Echo',
            command: 'echo ok',
          },
        ],
      },
    ],
  } satisfies RawPipelineConfig;

  const { port, close } = await startApp(buildApp());
  try {
    const res = await postJsonReq(port, '/api/run/start', {});
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { runId?: string };
    expect(body.runId).toMatch(/^run_/);
    await waitForSessionDone(body.runId!);
  } finally {
    await close();
    await removeTempDir();
  }
});

test('history can list multiple live pipeline runs at the same time', async () => {
  const other = new RunSession(
    'run_other',
    {
      name: 'Other Live Pipeline',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'test', name: 'Test', command: 'echo test' }],
        },
      ],
    },
    null,
    undefined,
    8,
  );
  other.seedTasks();
  other.ingest({
    type: 'task_update',
    runId: 'run_other',
    taskId: 'main.test',
    status: 'running',
    startedAt: '2026-05-22T08:01:00.000Z',
  });

  const sessions = (ws as unknown as { runSessions: Map<string, RunSession> }).runSessions;
  sessions.set('run_other', other);

  const { port, close } = await startApp(buildApp());
  try {
    const history = await getReq(port, '/api/run/history');
    expect(history.status).toBe(200);
    const body = JSON.parse(history.body) as {
      runs: Array<{ runId: string; running?: boolean; pipelineName?: string }>;
    };
    const liveIds = body.runs.filter((run) => run.running === true).map((run) => run.runId);
    expect(liveIds).toEqual(expect.arrayContaining(['run_live', 'run_other']));
  } finally {
    await close();
    await removeTempDir();
  }
});
