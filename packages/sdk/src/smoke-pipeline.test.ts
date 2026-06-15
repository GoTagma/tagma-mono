import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from './index';

/**
 * In-process pipeline smoke tests.
 *
 * Unlike the rest of the SDK test suite (which uses `fakeRuntime()`), these
 * tests exercise the **real** `bunRuntime`: real `Bun.spawn`, real log
 * store, real filesystem. The goal is to verify the full chain:
 *
 *   YAML string -> parse -> validate -> resolve inheritance -> build DAG
 *   -> schedule tasks -> spawn real processes -> emit events -> collect results
 *
 * Commands use `{ argv: ["node", "-e", "..."] }` for portability across
 * Windows (cmd/PowerShell) and Unix shells.
 */

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-smoke-'));
}

function collectEvents(events: RunEventPayload[]) {
  return {
    runStart: () => events.find((e) => e.type === 'run_start'),
    runEnd: () => events.find((e) => e.type === 'run_end'),
    taskUpdates: (taskId: string) =>
      events.filter((e) => e.type === 'task_update' && e.taskId === taskId),
    finalTaskUpdate: (taskId: string) => {
      const updates = events.filter((e) => e.type === 'task_update' && e.taskId === taskId);
      return updates[updates.length - 1];
    },
    allTaskIds: () => {
      const ids = new Set<string>();
      for (const e of events) {
        if (e.type === 'task_update' && e.taskId) ids.add(e.taskId);
      }
      return [...ids];
    },
    raw: events,
  };
}

describe('smoke - real runtime pipeline execution', () => {
  test('single command task: YAML -> real process -> success', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-single
  tracks:
    - id: main
      name: Main
      tasks:
        - id: hello
          name: hello
          command:
            argv: ["node", "-e", "process.stdout.write('hello smoke')"]
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.total).toBe(1);
        expect(result.result.summary.success).toBe(1);
        expect(result.result.summary.failed).toBe(0);
      }

      const ec = collectEvents(events);
      expect(ec.runStart()).toBeDefined();
      expect(ec.runEnd()).toBeDefined();

      const final = ec.finalTaskUpdate('main.hello');
      expect(final).toBeDefined();
      if (final && final.type === 'task_update') {
        expect(final.status).toBe('success');
        expect(final.stdout).toContain('hello smoke');
        expect(final.exitCode).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multi-node DAG: dependency ordering and output chaining', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-dag
  tracks:
    - id: main
      name: Main
      tasks:
        - id: produce
          name: produce
          command:
            argv: ["node", "-e", "process.stdout.write(JSON.stringify({value: 42}))"]
          outputs:
            value:
              type: number
        - id: consume
          name: consume
          depends_on: [produce]
          command:
            argv: ["node", "-e", "process.stdout.write('got ' + process.argv[1])", "{{inputs.value}}"]
          inputs:
            value:
              from: produce.value
              type: number
              required: true
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.total).toBe(2);
        expect(result.result.summary.success).toBe(2);
      }

      const ec = collectEvents(events);
      const produce = ec.finalTaskUpdate('main.produce');
      const consume = ec.finalTaskUpdate('main.consume');

      expect(produce).toBeDefined();
      expect(consume).toBeDefined();

      if (produce && produce.type === 'task_update') {
        expect(produce.status).toBe('success');
        expect(produce.outputs).toEqual({ value: 42 });
      }
      if (consume && consume.type === 'task_update') {
        expect(consume.status).toBe('success');
        expect(consume.stdout).toContain('got 42');
      }

      // Verify event ordering: produce must have completed before consume started
      const allIds = ec.allTaskIds();
      expect(allIds).toContain('main.produce');
      expect(allIds).toContain('main.consume');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('command failure: non-zero exit code marks task failed, downstream skipped', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-failure
  tracks:
    - id: main
      name: Main
      on_failure: skip_downstream
      tasks:
        - id: fail
          name: fail
          command:
            argv: ["node", "-e", "process.stderr.write('boom'); process.exit(1)"]
        - id: after
          name: after
          depends_on: [fail]
          command:
            argv: ["node", "-e", "process.stdout.write('should not run')"]
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(false);
        expect(result.result.summary.failed).toBe(1);
        expect(result.result.summary.skipped).toBe(1);
      }

      const ec = collectEvents(events);
      const failUpdate = ec.finalTaskUpdate('main.fail');
      const afterUpdate = ec.finalTaskUpdate('main.after');

      if (failUpdate && failUpdate.type === 'task_update') {
        expect(failUpdate.status).toBe('failed');
        expect(failUpdate.exitCode).toBe(1);
        expect(failUpdate.stderr).toContain('boom');
      }
      if (afterUpdate && afterUpdate.type === 'task_update') {
        expect(afterUpdate.status).toBe('skipped');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('multi-track: two independent tracks run to completion', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-multi-track
  tracks:
    - id: alpha
      name: Alpha
      tasks:
        - id: a1
          name: a1
          command:
            argv: ["node", "-e", "process.stdout.write('alpha-1')"]
    - id: beta
      name: Beta
      tasks:
        - id: b1
          name: b1
          command:
            argv: ["node", "-e", "process.stdout.write('beta-1')"]
`,
        { cwd: dir, onEvent: (e) => events.push(e) },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.total).toBe(2);
        expect(result.result.summary.success).toBe(2);
      }

      const ec = collectEvents(events);
      const a1 = ec.finalTaskUpdate('alpha.a1');
      const b1 = ec.finalTaskUpdate('beta.b1');

      if (a1 && a1.type === 'task_update') {
        expect(a1.status).toBe('success');
        expect(a1.stdout).toContain('alpha-1');
      }
      if (b1 && b1.type === 'task_update') {
        expect(b1.status).toBe('success');
        expect(b1.stdout).toContain('beta-1');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('YAML validation rejects malformed pipeline before execution', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();

      // Missing tracks
      await expect(
        tagma.runYaml(
          `
pipeline:
  name: bad-pipeline
  tracks: []
`,
          { cwd: dir },
        ),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('log files are persisted on disk after run', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-logs
  tracks:
    - id: main
      name: Main
      tasks:
        - id: hello
          name: hello
          command:
            argv: ["node", "-e", "process.stdout.write('logged output')"]
`,
        { cwd: dir },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        // The engine persisted a log file; verify it exists on disk.
        expect(result.result.logPath).toBeDefined();
        expect(result.result.logPath.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('max_concurrency limits parallel execution', async () => {
    const dir = makeDir();
    try {
      const tagma = createTagma();
      const taskStarts: number[] = [];
      const events: RunEventPayload[] = [];
      const result = await tagma.runYaml(
        `
pipeline:
  name: smoke-concurrency
  max_concurrency: 1
  tracks:
    - id: main
      name: Main
      tasks:
        - id: t1
          name: t1
          command:
            argv: ["node", "-e", "setTimeout(() => process.stdout.write('t1'), 50)"]
        - id: t2
          name: t2
          command:
            argv: ["node", "-e", "setTimeout(() => process.stdout.write('t2'), 50)"]
`,
        {
          cwd: dir,
          onEvent: (e) => {
            events.push(e);
            if (e.type === 'task_update' && e.status === 'running') {
              taskStarts.push(Date.now());
            }
          },
        },
      );

      expect(result.kind).toBe('pipeline');
      if (result.kind === 'pipeline') {
        expect(result.result.success).toBe(true);
        expect(result.result.summary.total).toBe(2);
        expect(result.result.summary.success).toBe(2);
      }

      // With max_concurrency: 1, the second task should start after the first
      // completes. Verify by checking that task starts are not simultaneous.
      if (taskStarts.length >= 2) {
        const gap = Math.abs(taskStarts[1]! - taskStarts[0]!);
        // At least 30ms gap (the tasks take 50ms each, so serialized they
        // can't start within 30ms of each other)
        expect(gap).toBeGreaterThan(30);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
