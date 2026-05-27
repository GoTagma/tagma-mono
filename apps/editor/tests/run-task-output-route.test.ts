import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { registerRunRoutes } from '../server/routes/run';
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
const RUN_ID = 'run_taskoutput';

function runDirPath(): string {
  return join(tempDir, '.tagma', 'logs', RUN_ID);
}

function readSummaryFixture(): { tasks: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(runDirPath(), 'summary.json'), 'utf-8')) as {
    tasks: Array<Record<string, unknown>>;
  };
}

function writeSummaryFixture(summary: unknown): void {
  writeFileSync(join(runDirPath(), 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
}

function writeLatestRunFixture(): void {
  const latestRunDir = join(tempDir, '.tagma', 'logs', 'run_latest');
  mkdirSync(latestRunDir, { recursive: true });
  writeFileSync(join(tempDir, '.tagma', 'run-versions.json'), JSON.stringify({
    schemaVersion: 1,
    entries: {
      '.tagma/latest/latest.yaml': 4,
    },
  }), 'utf-8');
  writeFileSync(join(latestRunDir, 'pipeline.yaml'), 'pipeline:\n  name: Latest\n', 'utf-8');
  writeFileSync(join(latestRunDir, 'pipeline.log'), 'latest run log line\n', 'utf-8');
  writeFileSync(join(latestRunDir, 't_a.stdout'), 'latest stdout\n', 'utf-8');
  writeFileSync(
    join(latestRunDir, 'summary.json'),
    JSON.stringify(
      {
        runId: 'run_latest',
        pipelineName: 'Latest',
        startedAt: '2026-05-18T00:02:00.000Z',
        finishedAt: '2026-05-18T00:03:00.000Z',
        yamlRunVersion: 4,
        success: true,
        error: null,
        tasks: [
          {
            taskId: 't.a',
            trackId: 't',
            trackName: 'Track',
            taskName: 'Task A',
            status: 'success',
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            exitCode: 0,
            driver: null,
            model: null,
            stdoutPath: 't_a.stdout',
            stderrPath: null,
            normalizedOutput: 'latest normalized output',
          },
        ],
        tracks: [{ id: 't', name: 'Track' }],
        hasYamlSnapshot: true,
      },
      null,
      2,
    ),
    'utf-8',
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-task-output-'));
  // The engine writes per-task streams to .tagma/logs/<runId>/<taskId>.<stream>
  // with dots in the qualified id replaced by underscores (RuntimeAdapter
  // .taskOutputPath). Recreate that on-disk shape for task `t.a`.
  const runDir = runDirPath();
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 't_a.stdout'), 'hello from stdout\nline two\n', 'utf-8');
  writeFileSync(join(runDir, 't_a.stderr'), 'a warning on stderr\n', 'utf-8');
  writeFileSync(join(runDir, 'pipeline.yaml'), 'pipeline:\n  name: Historical\n', 'utf-8');
  writeFileSync(join(runDir, 'pipeline.log'), 'historical log line\n', 'utf-8');
  writeFileSync(
    join(runDir, 'summary.json'),
    JSON.stringify(
      {
        runId: RUN_ID,
        pipelineName: 'Historical',
        startedAt: '2026-05-18T00:00:00.000Z',
        finishedAt: '2026-05-18T00:01:00.000Z',
        yamlRunVersion: 3,
        success: true,
        error: null,
        tasks: [
          {
            taskId: 't.a',
            trackId: 't',
            trackName: 'Track',
            taskName: 'Task A',
            status: 'success',
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            exitCode: 0,
            driver: null,
            model: null,
            stdoutPath: 't_a.stdout',
            stderrPath: 't_a.stderr',
            normalizedOutput: 'normalized historical output',
          },
        ],
        tracks: [{ id: 't', name: 'Track' }],
        hasYamlSnapshot: true,
      },
      null,
      2,
    ),
    'utf-8',
  );
  const pipelineDir = join(tempDir, '.tagma', 'latest');
  mkdirSync(pipelineDir, { recursive: true });
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;
  ws.yamlPath = join(pipelineDir, 'latest.yaml');
  writeFileSync(ws.yamlPath, 'pipeline:\n  name: Latest\n', 'utf-8');
  writeFileSync(join(pipelineDir, 'latest.compile.log'), 'success: true\n', 'utf-8');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
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

test('returns the full persisted stdout for a past task', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=t.a&stream=stdout`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      taskId: string;
      stream: string;
      content: string;
      truncated: boolean;
    };
    expect(body.taskId).toBe('t.a');
    expect(body.stream).toBe('stdout');
    expect(body.content).toBe('hello from stdout\nline two\n');
    expect(body.truncated).toBe(false);
  } finally {
    await close();
  }
});

test('returns the persisted stderr for a past task', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=t.a&stream=stderr`,
    );
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { content: string }).content).toBe('a warning on stderr\n');
  } finally {
    await close();
  }
});

test('builds history Ask AI context with latest and selected snapshot artifacts', async () => {
  writeLatestRunFixture();
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/ask-ai-context?taskId=t.a`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { label: string; content: string };
    expect(body.label).toContain(RUN_ID);
    expect(body.content).toContain('<history-version-compare>');
    expect(body.content).toContain('selected-run-yaml-version: 3');
    expect(body.content).toContain('latest-yaml-version: 4');
    expect(body.content).toContain('latest-run-id: run_latest');
    expect(body.content).toContain('pipeline:\n  name: Latest');
    expect(body.content).toContain('pipeline:\n  name: Historical');
    expect(body.content).toContain('Latest matching run summary JSON (run_latest)');
    expect(body.content).toContain('latest run log line');
    expect(body.content).toContain('latest stdout');
    expect(body.content).toContain('latest normalized output');
    expect(body.content).toContain('historical log line');
    expect(body.content).toContain('hello from stdout');
    expect(body.content).toContain('normalized historical output');
    expect(body.content).toContain('stateless tagma-history-compare agent');
  } finally {
    await close();
  }
});

test('bounds history Ask AI context and tails long logs and streams', async () => {
  const runDir = runDirPath();
  const longLog = `old historical log head only\n${'x'.repeat(150000)}\nimportant historical tail\n`;
  const longStdout = `old stdout head only\n${'y'.repeat(90000)}\nimportant stdout tail\n`;
  writeFileSync(join(runDir, 'pipeline.log'), longLog, 'utf-8');
  writeFileSync(join(runDir, 't_a.stdout'), longStdout, 'utf-8');
  const summary = readSummaryFixture();
  summary.tasks[0].normalizedOutput = `${'n'.repeat(300000)}normalized tail should be clipped`;
  writeSummaryFixture(summary);

  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/ask-ai-context?taskId=t.a`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: string };
    expect(Buffer.byteLength(body.content, 'utf-8')).toBeLessThan(450 * 1024);
    expect(body.content).toContain('important historical tail');
    expect(body.content).toContain('important stdout tail');
    expect(body.content).not.toContain('old historical log head only');
    expect(body.content).not.toContain('old stdout head only');
    expect(body.content).toContain('[truncated to last 131072 bytes');
    expect(body.content).toContain('[truncated at 65536 bytes');
    expect(body.content).not.toContain('normalized tail should be clipped');
  } finally {
    await close();
  }
});

test('builds history Ask AI context only from the selected task output', async () => {
  const runDir = runDirPath();
  writeFileSync(join(runDir, 't_other.stdout'), 'unrelated stdout\n', 'utf-8');
  const summary = readSummaryFixture();
  summary.tasks.unshift({
    ...summary.tasks[0],
    taskId: 't.other',
    stdoutPath: 't_other.stdout',
    stderrPath: null,
    normalizedOutput: 'unrelated normalized output',
  });
  writeSummaryFixture(summary);

  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/ask-ai-context?taskId=t.a`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: string };
    expect(body.content).toContain('hello from stdout');
    expect(body.content).toContain('normalized historical output');
    expect(body.content).not.toContain('unrelated stdout');
    expect(body.content).not.toContain('unrelated normalized output');
  } finally {
    await close();
  }
});

test('404 when history Ask AI context is requested for a task absent from summary', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/ask-ai-context?taskId=t.missing`,
    );
    expect(res.status).toBe(404);
  } finally {
    await close();
  }
});

test('404 when the task produced no such stream file', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=t.missing&stream=stdout`,
    );
    expect(res.status).toBe(404);
  } finally {
    await close();
  }
});

test('400 on an unknown stream', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=t.a&stream=trace`,
    );
    expect(res.status).toBe(400);
  } finally {
    await close();
  }
});

test('400 rejects a path-traversal taskId before any file access', async () => {
  const { port, close } = await startApp(buildApp());
  try {
    // %2F decodes to "/" — outside the allowed [A-Za-z0-9._-] charset, so
    // the request is refused before a filename is ever derived.
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=..%2F..%2Fsummary&stream=stdout`,
    );
    expect(res.status).toBe(400);
  } finally {
    await close();
  }
});

test('caps oversized output at 1 MB and flags truncation', async () => {
  const big = `${'x'.repeat(64)}\n`.repeat(20000); // ~1.27 MB, newline-delimited
  writeFileSync(join(tempDir, '.tagma', 'logs', RUN_ID, 't_big.stdout'), big, 'utf-8');
  const { port, close } = await startApp(buildApp());
  try {
    const res = await getReq(
      port,
      `/api/run/history/${RUN_ID}/task-output?taskId=t.big&stream=stdout`,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      content: string;
      size: number;
      truncated: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.size).toBe(Buffer.byteLength(big));
    // Only the last ~1 MB is returned, and the partial first line is dropped.
    expect(body.content.length).toBeLessThan(body.size);
    expect(body.content.length).toBeLessThanOrEqual(1024 * 1024);
  } finally {
    await close();
  }
});
