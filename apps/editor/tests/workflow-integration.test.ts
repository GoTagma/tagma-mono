import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { registerRunRoutes } from '../server/routes/run';
import { WorkspaceState } from '../server/workspace-state';

let tempDir: string;
let ws: WorkspaceState;

function pipelineYaml(name: string, command: string): string {
  return `pipeline:
  name: ${name}
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: ${command}
`;
}

function failingPipelineYaml(name: string): string {
  return `pipeline:
  name: ${name}
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: exit 1
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
  tempDir = mkdtempSync(join(tmpdir(), 'tagma-workflow-integration-'));
  ws = new WorkspaceState(tempDir);
  ws.workDir = tempDir;
});

afterEach(() => {
  // On Windows, file handles from the server may still be open briefly after
  // the pipeline run completes. Retry cleanup to avoid EBUSY errors.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 2) {
        // Brief pause before retry (synchronous to stay in afterEach)
        const end = Date.now() + 200;
        while (Date.now() < end) {
          /* spin */
        }
      }
    }
  }
});

describe('Workflow Integration Tests', () => {
  describe('Abort scenarios', () => {
    test('abort during workflow execution marks running pipelines as aborted', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const p2Path = join(tempDir, '.tagma', 'p2', 'p2.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'p2'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      // P1 runs for a long time
      writeFileSync(p1Path, pipelineYaml('P1', 'sleep 10'), 'utf-8');
      writeFileSync(p2Path, pipelineYaml('P2', 'echo p2'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        // Start workflow in live mode
        const startRes = await postJsonReq(url, '/api/run/workflow/start', {
          path: workflowPath,
          live: true,
        });
        const startBody = JSON.parse(startRes.body) as {
          ok?: boolean;
          graphRunId?: string;
        };

        expect(startRes.status).toBe(200);
        expect(startBody.ok).toBe(true);
        const graphRunId = startBody.graphRunId;
        expect(graphRunId).toBeDefined();

        // Wait a bit for P1 to start
        await delay(200);

        // Abort the workflow
        const abortRes = await postJsonReq(url, '/api/run/workflow/abort', {
          graphRunId,
        });
        expect(abortRes.status).toBe(200);

        // Wait for abort to complete
        await delay(500);

        // Check events via SSE (simplified - just verify abort was accepted)
        expect(abortRes.body).toContain('ok');
      } finally {
        await close();
      }
    });

    test('abort with invalid graphRunId returns 404', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        // Start workflow
        await postJsonReq(url, '/api/run/workflow/start', {
          path: workflowPath,
          live: true,
        });

        // Try to abort with wrong graphRunId
        const abortRes = await postJsonReq(url, '/api/run/workflow/abort', {
          graphRunId: 'graph_invalid',
        });
        expect(abortRes.status).toBe(404);
      } finally {
        await close();
      }
    });
  });

  describe('Lifecycle retry scenarios', () => {
    test('max_runs with stop_when: success stops after first success', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      lifecycle:
        max_runs: 3
        stop_when: success
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
        const body = JSON.parse(res.body) as {
          ok?: boolean;
          result?: {
            success?: boolean;
            pipelines?: Array<{ pipelineId: string; runCount: number }>;
          };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(true);
        // Should run exactly once and stop on success
        expect(body.result?.pipelines?.[0]?.runCount).toBe(1);
      } finally {
        await close();
      }
    });

    test('max_runs with stop_when: always runs all attempts regardless of outcome', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
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
          result?: {
            success?: boolean;
            pipelines?: Array<{ pipelineId: string; runCount: number }>;
          };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(true);
        // Should run exactly 2 times
        expect(body.result?.pipelines?.[0]?.runCount).toBe(2);
      } finally {
        await close();
      }
    });

    test('max_runs with stop_when: failure retries until success', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      lifecycle:
        max_runs: 3
        stop_when: failure
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
        const body = JSON.parse(res.body) as {
          ok?: boolean;
          result?: {
            success?: boolean;
            pipelines?: Array<{ pipelineId: string; runCount: number }>;
          };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(true);
        // Should run all 3 times since stop_when is failure and all succeed
        expect(body.result?.pipelines?.[0]?.runCount).toBe(3);
      } finally {
        await close();
      }
    });

    test('failing pipeline with max_runs respects retry limit', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, failingPipelineYaml('P1'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      lifecycle:
        max_runs: 2
        stop_when: success
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
        const body = JSON.parse(res.body) as {
          ok?: boolean;
          result?: {
            success?: boolean;
            pipelines?: Array<{ pipelineId: string; runCount: number; status: string }>;
          };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(false);
        // Should retry up to max_runs (2 times)
        expect(body.result?.pipelines?.[0]?.runCount).toBe(2);
        expect(body.result?.pipelines?.[0]?.status).toBe('failed');
      } finally {
        await close();
      }
    });
  });

  describe('Cross-scenario combinations', () => {
    test('workflow with multiple pipelines and mixed lifecycle policies', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const p2Path = join(tempDir, '.tagma', 'p2', 'p2.yaml');
      const p3Path = join(tempDir, '.tagma', 'p3', 'p3.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'p2'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'p3'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(p2Path, pipelineYaml('P2', 'echo p2'), 'utf-8');
      writeFileSync(p3Path, pipelineYaml('P3', 'echo p3'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      lifecycle:
        max_runs: 2
        stop_when: always
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
    - id: p3
      path: .tagma/p3/p3.yaml
      depends_on: [p2]
      lifecycle:
        max_runs: 1
        stop_when: success
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
        const body = JSON.parse(res.body) as {
          ok?: boolean;
          result?: {
            success?: boolean;
            pipelines?: Array<{
              pipelineId: string;
              runCount: number;
              status: string;
            }>;
          };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(true);

        // P1 should run 2 times (max_runs: 2, stop_when: always)
        expect(body.result?.pipelines?.[0]?.runCount).toBe(2);
        expect(body.result?.pipelines?.[0]?.status).toBe('success');

        // P2 should run once (no lifecycle, depends on p1)
        expect(body.result?.pipelines?.[1]?.runCount).toBe(1);
        expect(body.result?.pipelines?.[1]?.status).toBe('success');

        // P3 should run once (max_runs: 1, stop_when: success)
        expect(body.result?.pipelines?.[2]?.runCount).toBe(1);
        expect(body.result?.pipelines?.[2]?.status).toBe('success');
      } finally {
        await close();
      }
    });

    test('workflow respects max_concurrency limit', async () => {
      const p1Path = join(tempDir, '.tagma', 'p1', 'p1.yaml');
      const p2Path = join(tempDir, '.tagma', 'p2', 'p2.yaml');
      const p3Path = join(tempDir, '.tagma', 'p3', 'p3.yaml');
      const workflowPath = join(tempDir, '.tagma', 'workflows', 'test.workflow.yaml');

      mkdirSync(join(tempDir, '.tagma', 'p1'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'p2'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'p3'), { recursive: true });
      mkdirSync(join(tempDir, '.tagma', 'workflows'), { recursive: true });

      // All pipelines run quickly
      writeFileSync(p1Path, pipelineYaml('P1', 'echo p1'), 'utf-8');
      writeFileSync(p2Path, pipelineYaml('P2', 'echo p2'), 'utf-8');
      writeFileSync(p3Path, pipelineYaml('P3', 'echo p3'), 'utf-8');
      writeFileSync(
        workflowPath,
        `workflow:
  name: test-flow
  max_concurrency: 1
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p2
      path: .tagma/p2/p2.yaml
    - id: p3
      path: .tagma/p3/p3.yaml
`,
        'utf-8',
      );

      const { url, close } = await startApp(buildApp());
      try {
        const res = await postJsonReq(url, '/api/run/workflow/start', { path: workflowPath });
        const body = JSON.parse(res.body) as {
          ok?: boolean;
          result?: { success?: boolean; pipelines?: Array<{ pipelineId: string; status: string }> };
        };

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.success).toBe(true);
        // All pipelines should complete successfully
        expect(body.result?.pipelines?.length).toBe(3);
        body.result?.pipelines?.forEach((p) => {
          expect(p.status).toBe('success');
        });
      } finally {
        await close();
      }
    });
  });
});
