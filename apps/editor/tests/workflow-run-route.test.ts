import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { buildFatalWorkflowGraphEndEvent, registerRunRoutes } from '../server/routes/run';
import { WorkflowRunSession } from '../server/routes/run-session';
import { WorkspaceState } from '../server/workspace-state';

let tempDir: string;
let ws: WorkspaceState;

function pipelineYaml(name: string, command: string): string {
  return `pipeline:
  name: ${name}
  mode: trusted
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: ${command}
`;
}

function workflowYaml(): string {
  return `workflow:
  name: release-flow
  max_concurrency: 2
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
`;
}

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function postJsonReq(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const port = Number(new URL(url).port);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('buildFatalWorkflowGraphEndEvent turns unexpected live workflow failures into graph_end', () => {
  const event = buildFatalWorkflowGraphEndEvent(
    'graph_1',
    [
      {
        pipelineId: 'p1',
        path: '.tagma/p1/p1.yaml',
        dependsOn: [],
        status: 'running',
        runId: 'run_1',
        runCount: 1,
        maxRuns: 1,
        attempts: [
          {
            attempt: 1,
            runId: 'run_1',
            status: 'running',
            startedAt: '2026-05-24T00:00:00.000Z',
            finishedAt: null,
            error: null,
          },
        ],
        startedAt: '2026-05-24T00:00:00.000Z',
        finishedAt: null,
        error: null,
      },
    ],
    'runner rejected',
  );

  expect(event.type).toBe('graph_end');
  expect(event.success).toBe(false);
  expect(event.abortReason).toBe(null);
  expect(event.pipelines[0]?.status).toBe('failed');
  expect(event.pipelines[0]?.error).toBe('runner rejected');
  expect(event.pipelines[0]?.attempts[0]?.status).toBe('failed');
});

test('WorkflowRunSession stamps workflow events and can replay after a seq', () => {
  const session = new WorkflowRunSession({ graphRunId: 'graph_1' } as never, new AbortController());
  const start = session.ingest({
    type: 'graph_start',
    graphRunId: 'graph_1',
    workflowName: 'release',
    pipelines: [],
  });
  const update = session.ingest({
    type: 'pipeline_update',
    graphRunId: 'graph_1',
    pipelineId: 'p1',
    status: 'running',
  });

  expect(start.seq).toBe(1);
  expect(update.seq).toBe(2);
  expect(session.replayAfter(1)).toEqual([update]);
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-workflow-run-route-'));
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;
  const p1 = join(tempDir, '.tagma', 'p1', 'p1.yaml');
  const p2 = join(tempDir, '.tagma', 'p2', 'p2.yaml');
  const workflow = join(tempDir, '.tagma', 'workflows', 'release.workflow.yaml');
  mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
  mkdirSync(join(tempDir, '.tagma', 'p2'), { recursive: true });
  mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });
  writeFileSync(p1, pipelineYaml('P1', 'echo p1'), 'utf-8');
  writeFileSync(p2, pipelineYaml('P2', 'echo p2'), 'utf-8');
  writeFileSync(workflow, workflowYaml(), 'utf-8');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test('POST /api/run/workflow/start runs a workspace workflow graph', async () => {
  const workflowPath = join(tempDir, '.tagma', 'workflows', 'release.workflow.yaml');
  const { url, close } = await startApp(buildApp());
  try {
    const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      result?: { success?: boolean; pipelines?: Array<{ pipelineId: string; status: string }> };
      events?: Array<{ type: string }>;
      error?: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result?.success).toBe(true);
    expect(body.result?.pipelines?.map((p) => [p.pipelineId, p.status])).toEqual([
      ['p1', 'success'],
      ['p2', 'success'],
    ]);
    expect(body.events?.some((event) => event.type === 'pipeline_event')).toBe(true);
  } finally {
    await close();
  }
});

test('POST /api/run/workflow/start honors workflow pipeline lifecycle attempts', async () => {
  const workflowPath = join(tempDir, '.tagma', 'workflows', 'release.workflow.yaml');
  writeFileSync(
    workflowPath,
    `workflow:
  name: release-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      lifecycle:
        max_runs: 2
        stop_when: always
`,
    'utf-8',
  );
  const { url, close } = await startApp(buildApp());
  try {
    const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
    const body = JSON.parse(res.body) as {
      ok?: boolean;
      result?: { success?: boolean; pipelines?: Array<{ pipelineId: string; runCount: number }> };
      events?: Array<{
        type: string;
        pipelineId?: string;
        attempt?: number;
        event?: { type: string };
      }>;
      error?: string;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result?.success).toBe(true);
    expect(body.result?.pipelines?.[0]).toMatchObject({ pipelineId: 'p1', runCount: 2 });
    expect(
      body.events
        ?.filter(
          (event) =>
            event.type === 'pipeline_event' &&
            event.pipelineId === 'p1' &&
            event.event?.type === 'run_start',
        )
        .map((event) => event.attempt),
    ).toEqual([1, 2]);
  } finally {
    await close();
  }
});

test('POST /api/run/workflow/start can launch a live workflow that is abortable', async () => {
  const workflowPath = join(tempDir, '.tagma', 'workflows', 'release.workflow.yaml');
  writeFileSync(
    join(tempDir, '.tagma', 'p1', 'p1.yaml'),
    pipelineYaml('P1', 'bun -e "setTimeout(() => process.exit(0), 500)"'),
    'utf-8',
  );
  const { url, close } = await startApp(buildApp());
  try {
    const start = await postJsonReq(url, '/api/run/workflow/start', {
      path: workflowPath,
      live: true,
    });
    const body = JSON.parse(start.body) as {
      ok?: boolean;
      graphRunId?: string;
      running?: boolean;
      events?: Array<{ type: string }>;
    };

    expect(start.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.graphRunId).toBe('string');
    expect(body.running).toBe(true);
    expect(body.events?.some((event) => event.type === 'graph_start')).toBe(true);

    const abort = await postJsonReq(url, '/api/run/workflow/abort', {
      graphRunId: body.graphRunId,
    });
    expect(abort.status).toBe(200);
    await delay(1500);
  } finally {
    await close();
  }
}, 10_000);
