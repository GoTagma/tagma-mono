import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '@tagma/core';
import type { PipelineConfig, TaskResult, TagmaRuntime } from '@tagma/types';
import { bootstrapBuiltins } from './bootstrap';
import {
  PipelineGraphRunner,
  createPipelineGroup,
  loadWorkflow,
  parseWorkflowYaml,
  runPipelineGraph,
  serializeWorkflow,
  validateRawWorkflow,
} from './workflow';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-workflow-'));
}

function commandPipeline(name: string, command: string): PipelineConfig {
  return {
    name,
    mode: 'trusted',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'task', name: command, command }],
      },
    ],
  };
}

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

function taskResult(stdout = ''): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(
  runCommand: TagmaRuntime['runCommand'] = async (command) => taskResult(String(command)),
): TagmaRuntime {
  return {
    runCommand,
    async runSpawn() {
      throw new Error('runSpawn should not be called');
    },
    async ensureDir() {
      /* no-op */
    },
    async fileExists() {
      return false;
    },
    async *watch() {
      /* no-op */
    },
    logStore: {
      openRunLog({ runId }) {
        return {
          path: `mem://${runId}/pipeline.log`,
          dir: `mem://${runId}`,
          append() {
            /* memory sink */
          },
          close() {
            /* memory sink */
          },
        };
      },
      taskOutputPath({ runId, taskId, stream }) {
        return `mem://${runId}/${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
    },
    now: () => new Date('2026-05-16T00:00:00.000Z'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function registry(): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  return reg;
}

describe('workflow YAML model', () => {
  test('parses and validates a top-level workflow document', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: release-flow
  max_concurrency: 2
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
    - id: p3
      path: .tagma/p3/p3.yaml
      depends_on: [p1]
`);

    expect(raw.name).toBe('release-flow');
    expect(raw.max_concurrency).toBe(2);
    expect(raw.pipelines.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(validateRawWorkflow(raw)).toEqual([]);
  });

  test('validates and serializes workflow node positions', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: release-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      position:
        x: 120
        y: 80
`);

    expect(validateRawWorkflow(raw)).toEqual([]);
    expect(serializeWorkflow(raw)).toContain('position:');
    expect(serializeWorkflow(raw)).toContain('x: 120');
    expect(serializeWorkflow(raw)).toContain('y: 80');

    const invalid = parseWorkflowYaml(`workflow:
  name: bad
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      position:
        x: no
        y: 10
`);
    expect(validateRawWorkflow(invalid).map((e) => e.path)).toContain('pipelines[0].position');
  });

  test('validates and serializes workflow node lifecycle controls', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: release-flow
  pipelines:
    - id: retry_build
      path: .tagma/build/build.yaml
      lifecycle:
        max_runs: 3
        stop_when: success
`);

    expect(validateRawWorkflow(raw)).toEqual([]);
    expect(raw.pipelines[0]?.lifecycle).toEqual({ max_runs: 3, stop_when: 'success' });
    expect(serializeWorkflow(raw)).toContain('lifecycle:');
    expect(serializeWorkflow(raw)).toContain('max_runs: 3');
    expect(serializeWorkflow(raw)).toContain('stop_when: success');

    const invalid = parseWorkflowYaml(`workflow:
  name: bad
  pipelines:
    - id: retry_build
      path: .tagma/build/build.yaml
      lifecycle:
        max_runs: 0
        stop_when: unknown
`);
    expect(validateRawWorkflow(invalid).map((e) => e.path)).toEqual(
      expect.arrayContaining([
        'pipelines[0].lifecycle.max_runs',
        'pipelines[0].lifecycle.stop_when',
      ]),
    );
  });

  test('defaults workflow graph documents to kind graph when serialized and loaded', async () => {
    const dir = makeDir();
    try {
      const pipelinePath = join(dir, '.tagma', 'build', 'build.yaml');
      mkdirSync(dirname(pipelinePath), { recursive: true });
      writeFileSync(pipelinePath, pipelineYaml('Build', 'build'), 'utf8');

      const raw = parseWorkflowYaml(`workflow:
  name: release-flow
  pipelines:
    - id: build
      path: .tagma/build/build.yaml
`);

      expect(serializeWorkflow(raw)).toContain('kind: graph');

      const loaded = await loadWorkflow(serializeWorkflow(raw), dir);
      expect(loaded.kind).toBe('graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports duplicate ids, missing dependencies, cycles, and unsafe paths', () => {
    const duplicate = parseWorkflowYaml(`workflow:
  name: bad
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p1
      path: .tagma/p2/p2.yaml
`);
    expect(validateRawWorkflow(duplicate).map((e) => e.message)).toContain(
      'Duplicate pipeline id "p1"',
    );

    const missing = parseWorkflowYaml(`workflow:
  name: bad
  max_concurrency: 0
  pipelines:
    - id: p1
      path: ../p1.yaml
      depends_on: [missing]
`);
    expect(validateRawWorkflow(missing).map((e) => e.path)).toEqual(
      expect.arrayContaining(['max_concurrency', 'pipelines[0].path', 'pipelines[0].depends_on']),
    );

    const cycle = parseWorkflowYaml(`workflow:
  name: bad
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
      depends_on: [p2]
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
`);
    expect(validateRawWorkflow(cycle).some((e) => /Circular dependency/.test(e.message))).toBe(
      true,
    );
  });

  test('loads referenced pipeline YAML files from workspace-relative paths', async () => {
    const dir = makeDir();
    try {
      const p1Path = join(dir, '.tagma', 'p1', 'p1.yaml');
      const p2Path = join(dir, '.tagma', 'p2', 'p2.yaml');
      mkdirSync(dirname(p1Path), { recursive: true });
      mkdirSync(dirname(p2Path), { recursive: true });
      writeFileSync(p1Path, pipelineYaml('P1', 'p1'), 'utf8');
      writeFileSync(p2Path, pipelineYaml('P2', 'p2'), 'utf8');

      const workflow = await loadWorkflow(
        `workflow:
  name: release-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
    - id: p2
      path: .tagma/p2/p2.yaml
      depends_on: [p1]
`,
        dir,
      );

      expect(workflow.name).toBe('release-flow');
      expect(workflow.pipelines[0]?.config.name).toBe('P1');
      expect(workflow.pipelines[1]?.depends_on).toEqual(['p1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PipelineGraphRunner', () => {
  test('runs dependent pipelines after their upstream and fans out within max_concurrency', async () => {
    const dir = makeDir();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          max_concurrency: 2,
          pipelines: [
            { id: 'p1', config: commandPipeline('P1', 'p1'), cwd: dir },
            { id: 'p2', config: commandPipeline('P2', 'p2'), cwd: dir, depends_on: ['p1'] },
            { id: 'p3', config: commandPipeline('P3', 'p3'), cwd: dir, depends_on: ['p1'] },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async (command) => {
            const name = String(command);
            started.push(name);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, name === 'p1' ? 5 : 25));
            active -= 1;
            return taskResult(`${name}\n`);
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(started[0]).toBe('p1');
      expect(started.slice(1).sort()).toEqual(['p2', 'p3']);
      expect(maxActive).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('forwards nested pipeline events with pipeline ids', async () => {
    const dir = makeDir();
    const seen: string[] = [];
    try {
      const runner = new PipelineGraphRunner(
        {
          name: 'release-flow',
          pipelines: [{ id: 'p1', config: commandPipeline('P1', 'p1'), cwd: dir }],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(),
          skipPluginLoading: true,
        },
      );
      runner.subscribe((event) => {
        if (event.type === 'pipeline_event') seen.push(`${event.pipelineId}:${event.event.type}`);
      });

      const result = await runner.start();

      expect(result.success).toBe(true);
      expect(seen).toContain('p1:run_start');
      expect(seen).toContain('p1:run_end');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retries a pipeline node until success within max_runs', async () => {
    const dir = makeDir();
    let attempts = 0;
    const pipelineEvents: string[] = [];
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'flaky',
              config: commandPipeline('Flaky', 'flaky-command'),
              cwd: dir,
              lifecycle: { max_runs: 3, stop_when: 'success' },
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async () => {
            attempts += 1;
            return attempts < 2
              ? { ...taskResult(''), exitCode: 1, stderr: 'not yet', stderrBytes: 7 }
              : taskResult('ok\n');
          }),
          skipPluginLoading: true,
          onEvent: (event) => {
            if (event.type === 'pipeline_event') {
              pipelineEvents.push(`${event.pipelineId}:${event.attempt}:${event.event.type}`);
            }
          },
        },
      );

      expect(result.success).toBe(true);
      expect(attempts).toBe(2);
      expect(result.pipelines[0]?.status).toBe('success');
      expect(result.pipelines[0]?.runCount).toBe(2);
      expect(result.pipelines[0]?.maxRuns).toBe(3);
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'success',
      ]);
      expect(pipelineEvents).toEqual(
        expect.arrayContaining(['flaky:1:run_start', 'flaky:2:run_start']),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs a fixed-count pipeline loop when stop_when is always', async () => {
    const dir = makeDir();
    let attempts = 0;
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'loop',
              config: commandPipeline('Loop', 'loop-command'),
              cwd: dir,
              lifecycle: { max_runs: 3, stop_when: 'always' },
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async () => {
            attempts += 1;
            return taskResult(`attempt ${attempts}\n`);
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(result.pipelines[0]?.runCount).toBe(3);
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'success',
        'success',
        'success',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks a pipeline failed after exhausting success-conditioned retries', async () => {
    const dir = makeDir();
    let attempts = 0;
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'flaky',
              config: commandPipeline('Flaky', 'flaky-command'),
              cwd: dir,
              lifecycle: { max_runs: 2, stop_when: 'success' },
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async () => {
            attempts += 1;
            return { ...taskResult(''), exitCode: 1, stderr: 'still failing', stderrBytes: 13 };
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(false);
      expect(attempts).toBe(2);
      expect(result.pipelines[0]?.status).toBe('failed');
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'failed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stops a pipeline lifecycle when stop_when failure is reached', async () => {
    const dir = makeDir();
    let attempts = 0;
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'until_failure',
              config: commandPipeline('Until failure', 'until-failure'),
              cwd: dir,
              lifecycle: { max_runs: 4, stop_when: 'failure' },
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async () => {
            attempts += 1;
            return attempts < 3
              ? taskResult(`attempt ${attempts}\n`)
              : { ...taskResult(''), exitCode: 1, stderr: 'failed as requested', stderrBytes: 19 };
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(false);
      expect(attempts).toBe(3);
      expect(result.pipelines[0]?.runCount).toBe(3);
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'success',
        'success',
        'failed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects invalid programmatic pipeline configs before graph execution starts', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      const invalidPipeline = {
        name: 'Invalid',
        mode: 'trusted',
        tracks: [],
      } as unknown as PipelineConfig;

      await expect(
        runPipelineGraph(
          {
            name: 'release-flow',
            pipelines: [{ id: 'bad', config: invalidPipeline, cwd: dir }],
          },
          dir,
          {
            registry: registry(),
            runtime: fakeRuntime(),
            skipPluginLoading: true,
            onEvent: (event) => events.push(event.type),
          },
        ),
      ).rejects.toThrow(/pipelines\[0\]\.config\.tracks/);

      expect(events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips downstream pipelines when an upstream fails but continues independent nodes', async () => {
    const dir = makeDir();
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          failure_policy: 'continue_independent',
          max_concurrency: 2,
          pipelines: [
            { id: 'p1', config: commandPipeline('P1', 'p1'), cwd: dir },
            { id: 'p2', config: commandPipeline('P2', 'p2'), cwd: dir, depends_on: ['p1'] },
            { id: 'p3', config: commandPipeline('P3', 'p3'), cwd: dir },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async (command) =>
            command === 'p1'
              ? { ...taskResult(''), exitCode: 1, stderr: 'failed', stderrBytes: 6 }
              : taskResult(String(command)),
          ),
          skipPluginLoading: true,
        },
      );

      const statuses = new Map(result.pipelines.map((p) => [p.pipelineId, p.status]));
      expect(result.success).toBe(false);
      expect(statuses.get('p1')).toBe('failed');
      expect(statuses.get('p2')).toBe('skipped');
      expect(statuses.get('p3')).toBe('success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('abort cancels active pipelines and ends the graph as aborted', async () => {
    const dir = makeDir();
    try {
      const runner = new PipelineGraphRunner(
        {
          name: 'release-flow',
          pipelines: [{ id: 'p1', config: commandPipeline('P1', 'p1'), cwd: dir }],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(
            (_command, _cwd, options) =>
              new Promise<TaskResult>((resolve) => {
                const finish = () =>
                  resolve({
                    ...taskResult(''),
                    exitCode: -1,
                    stderr: 'aborted',
                    stderrBytes: 7,
                    failureKind: 'aborted',
                  });
                if (options?.signal?.aborted) {
                  finish();
                  return;
                }
                options?.signal?.addEventListener('abort', finish, { once: true });
              }),
          ),
          skipPluginLoading: true,
        },
      );

      const started = new Promise<void>((resolve) => {
        runner.subscribe((event) => {
          if (event.type === 'pipeline_update' && event.pipelineId === 'p1') resolve();
        });
      });
      const running = runner.start();
      await started;
      runner.abort('stop');
      const result = await running;

      expect(result.success).toBe(false);
      expect(result.abortReason).toBe('external');
      expect(result.pipelines[0]?.status).toBe('aborted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('createPipelineGroup builds and runs a programmatic pipeline graph', async () => {
    const dir = makeDir();
    try {
      const group = createPipelineGroup({ name: 'release-flow', maxConcurrency: 2 });
      group.add({ id: 'p1', config: commandPipeline('P1', 'p1'), cwd: dir });
      group.add({ id: 'p2', config: commandPipeline('P2', 'p2'), cwd: dir, dependsOn: ['p1'] });

      const result = await group.run(dir, {
        registry: registry(),
        runtime: fakeRuntime(),
        skipPluginLoading: true,
      });

      expect(result.success).toBe(true);
      expect(result.pipelines.map((p) => p.pipelineId)).toEqual(['p1', 'p2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
