import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginRegistry } from '@tagma/core';
import type {
  CompletionPlugin,
  DriverPlugin,
  PipelineConfig,
  PipelineGraphConfig,
  TaskResult,
  TagmaRuntime,
} from '@tagma/types';
import { bootstrapBuiltins } from './bootstrap';
import { YAML_REQUIRES_FIELD_MIN_SDK } from './compatibility';
import {
  PipelineGraphRunner,
  WorkflowValidationError,
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
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'task', name: command, command }],
      },
    ],
  };
}

function promptPipeline(name = 'Repair'): PipelineConfig {
  const permissions = { read: true, write: true, execute: true };
  return {
    name,
    driver: 'repair-test',
    permissions,
    tracks: [
      {
        id: 'main',
        name: 'Main',
        permissions,
        tasks: [
          {
            id: 'fix',
            name: 'Fix',
            prompt: 'Implement and verify the requested change.',
            permissions,
          },
        ],
      },
    ],
  };
}

interface PromptObservation {
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly sessionDriver: string | null;
  readonly normalizedOutput: string | null;
}

function repairRegistry(observations: PromptObservation[]): PluginRegistry {
  const reg = registry();
  const driver: DriverPlugin = {
    name: 'repair-test',
    capabilities: { sessionResume: true, systemPrompt: true, outputFormat: true },
    async buildCommand(task, _track, context) {
      const continuation = task.continue_from;
      observations.push({
        prompt: task.prompt ?? '',
        sessionId: continuation ? (context.sessionMap.get(continuation) ?? null) : null,
        sessionDriver: continuation ? (context.sessionDriverMap.get(continuation) ?? null) : null,
        normalizedOutput: continuation ? (context.normalizedMap.get(continuation) ?? null) : null,
      });
      return { args: ['repair-test'], stdin: task.prompt ?? '' };
    },
  };
  reg.registerPlugin('drivers', 'repair-test', driver);
  return reg;
}

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
  test('rejects missing or blank workDir before resolving pipeline paths', async () => {
    const yaml = `workflow:
  name: release-flow
  pipelines:
    - id: p1
      path: .tagma/p1/p1.yaml
`;

    await expect(loadWorkflow(yaml, '' as string)).rejects.toThrow(
      /workDir must be a non-empty string/,
    );
    await expect(loadWorkflow(yaml, undefined as unknown as string)).rejects.toThrow(
      /workDir must be a non-empty string/,
    );
  });

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

  test('loads and serializes empty workflow graphs', async () => {
    const dir = makeDir();
    try {
      const raw = parseWorkflowYaml(`workflow:
  name: empty-flow
  pipelines: []
`);

      expect(validateRawWorkflow(raw)).toEqual([]);
      expect(serializeWorkflow(raw)).toContain('pipelines: []');

      const workflow = await loadWorkflow(serializeWorkflow(raw), dir);
      expect(workflow.name).toBe('empty-flow');
      expect(workflow.pipelines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    const infinite = parseWorkflowYaml(`workflow:
  name: release-flow
  pipelines:
    - id: loop_forever
      path: .tagma/build/build.yaml
      lifecycle:
        max_runs: infinite
        stop_when: always
`);

    expect(validateRawWorkflow(infinite)).toEqual([]);
    expect(infinite.pipelines[0]?.lifecycle).toEqual({
      max_runs: 'infinite',
      stop_when: 'always',
    });
    expect(serializeWorkflow(infinite)).toContain('max_runs: infinite');

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

  test('validates and serializes workflow self-repair lifecycle controls', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: repair-flow
  pipelines:
    - id: repair
      path: .tagma/repair/repair.yaml
      lifecycle:
        max_runs: 3
        stop_when: success
        repair: true
`);

    expect(validateRawWorkflow(raw)).toEqual([]);
    expect(raw.pipelines[0]?.lifecycle).toEqual({
      max_runs: 3,
      stop_when: 'success',
      repair: true,
    });
    expect(serializeWorkflow(raw)).toContain('repair: true');
  });

  test('rejects invalid workflow self-repair lifecycle controls', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: invalid-repair-flow
  pipelines:
    - id: non_boolean
      path: .tagma/repair/repair.yaml
      lifecycle: { max_runs: 2, repair: yes }
    - id: missing_runs
      path: .tagma/repair/repair.yaml
      lifecycle: { repair: true }
    - id: single_run
      path: .tagma/repair/repair.yaml
      lifecycle: { max_runs: 1, repair: true }
    - id: infinite_runs
      path: .tagma/repair/repair.yaml
      lifecycle: { max_runs: infinite, repair: true }
    - id: wrong_stop
      path: .tagma/repair/repair.yaml
      lifecycle: { max_runs: 2, stop_when: always, repair: true }
`);

    expect(validateRawWorkflow(raw)).toEqual(
      expect.arrayContaining([
        {
          path: 'pipelines[0].lifecycle.repair',
          message: 'lifecycle.repair must be a boolean',
        },
        {
          path: 'pipelines[1].lifecycle.max_runs',
          message: 'lifecycle.repair requires a finite max_runs of at least 2',
        },
        {
          path: 'pipelines[2].lifecycle.max_runs',
          message: 'lifecycle.repair requires a finite max_runs of at least 2',
        },
        {
          path: 'pipelines[3].lifecycle.max_runs',
          message: 'lifecycle.repair requires a finite max_runs of at least 2',
        },
        {
          path: 'pipelines[4].lifecycle.stop_when',
          message: 'lifecycle.repair requires stop_when to be success when specified',
        },
      ]),
    );
  });

  test('rejects unknown workflow fields instead of silently ignoring misspelled graph controls', () => {
    const raw = parseWorkflowYaml(`workflow:
  name: release-flow
  maxConcurrency: 2
  failurePolicy: continue_independent
  pipelines:
    - id: retry_build
      path: .tagma/build/build.yaml
      dependsOn: [prepare]
      position:
        x: 120
        y: 80
        z: 10
      lifecycle:
        maxRuns: 3
        stopWhen: success
`);

    expect(validateRawWorkflow(raw)).toEqual(
      expect.arrayContaining([
        { path: 'maxConcurrency', message: 'Unknown workflow field "maxConcurrency"' },
        { path: 'failurePolicy', message: 'Unknown workflow field "failurePolicy"' },
        {
          path: 'pipelines[0].dependsOn',
          message: 'Unknown workflow pipeline field "dependsOn"',
        },
        {
          path: 'pipelines[0].position.z',
          message: 'Unknown workflow position field "z"',
        },
        {
          path: 'pipelines[0].lifecycle.maxRuns',
          message: 'Unknown workflow lifecycle field "maxRuns"',
        },
        {
          path: 'pipelines[0].lifecycle.stopWhen',
          message: 'Unknown workflow lifecycle field "stopWhen"',
        },
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
  requires:
    sdk: ">=${YAML_REQUIRES_FIELD_MIN_SDK}"
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
      expect(workflow.requires).toEqual({ sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}` });
      expect(parseWorkflowYaml(serializeWorkflow(workflow)).requires).toEqual({
        sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}`,
      });
      expect(workflow.pipelines[0]?.config.name).toBe('P1');
      expect(workflow.pipelines[1]?.depends_on).toEqual(['p1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loads child pipeline cwd relative to the child YAML directory', async () => {
    const dir = makeDir();
    const seenCwds: string[] = [];
    try {
      const childPath = join(dir, '.tagma', 'nested', 'child.yaml');
      const childDir = dirname(childPath);
      mkdirSync(childDir, { recursive: true });
      writeFileSync(
        childPath,
        `pipeline:
  name: Child
  tracks:
    - id: main
      name: Main
      cwd: childwd
      tasks:
        - id: task
          command: child
`,
        'utf8',
      );

      const workflow = await loadWorkflow(
        `workflow:
  name: release-flow
  pipelines:
    - id: child
      path: .tagma/nested/child.yaml
`,
        dir,
      );

      expect(workflow.pipelines[0]?.cwd).toBe(childDir);
      expect(workflow.pipelines[0]?.config.tracks[0]?.cwd).toBe(join(childDir, 'childwd'));

      const result = await runPipelineGraph(workflow, dir, {
        registry: registry(),
        runtime: fakeRuntime(async (command, cwd) => {
          seenCwds.push(cwd);
          return taskResult(String(command));
        }),
        skipPluginLoading: true,
      });

      expect(result.success).toBe(true);
      expect(seenCwds).toEqual([join(childDir, 'childwd')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('reports missing referenced pipeline files as workflow diagnostics', async () => {
    const dir = makeDir();
    try {
      let error: unknown;
      try {
        await loadWorkflow(
          `workflow:
  name: release-flow
  pipelines:
    - id: missing
      path: .tagma/missing/missing.yaml
`,
          dir,
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(WorkflowValidationError);
      const diagnostics = (error as WorkflowValidationError).diagnostics;
      expect(diagnostics).toEqual([
        expect.objectContaining({
          path: 'pipelines[0].path',
        }),
      ]);
      expect(diagnostics[0]?.message).toMatch(/ENOENT|no such file|cannot find/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prefixes referenced pipeline validation diagnostics with workflow context', async () => {
    const dir = makeDir();
    try {
      const pipelinePath = join(dir, '.tagma', 'bad', 'bad.yaml');
      mkdirSync(dirname(pipelinePath), { recursive: true });
      writeFileSync(
        pipelinePath,
        `pipeline:
  name: Bad
  tracks: []
`,
        'utf8',
      );

      let error: unknown;
      try {
        await loadWorkflow(
          `workflow:
  name: release-flow
  pipelines:
    - id: bad
      path: .tagma/bad/bad.yaml
`,
          dir,
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'pipelines[0].config.tracks',
          }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PipelineGraphRunner', () => {
  test('rejects missing or blank graph workDir before execution starts', async () => {
    await expect(
      runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [{ id: 'p1', config: commandPipeline('P1', 'p1') }],
        },
        '' as string,
        {
          registry: registry(),
          runtime: fakeRuntime(),
          skipPluginLoading: true,
        },
      ),
    ).rejects.toThrow(/workDir must be a non-empty string/);
  });

  test('runs an empty workflow graph as a no-op success', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      const result = await runPipelineGraph(
        {
          name: 'empty-flow',
          pipelines: [],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async () => {
            throw new Error('empty graph should not run pipeline commands');
          }),
          skipPluginLoading: true,
          onEvent: (event) => events.push(event.type),
        },
      );

      expect(result.success).toBe(true);
      expect(result.pipelines).toEqual([]);
      expect(events).toEqual(['graph_start', 'graph_end']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

  test('self-repair succeeds where an ordinary retry repeats the same verifier failure', async () => {
    const root = makeDir();
    const controlDir = join(root, 'control');
    const repairDir = join(root, 'repair');
    mkdirSync(controlDir, { recursive: true });
    mkdirSync(repairDir, { recursive: true });

    const permissions = { read: true, write: true, execute: true };
    const config: PipelineConfig = {
      name: 'Verifier-driven repair',
      driver: 'repair-test',
      permissions,
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'fix',
              name: 'Fix',
              prompt: 'Produce the requested value.',
              completion: { type: 'expected-answer' },
            },
          ],
        },
      ],
    };

    const runVariant = async (workDir: string, repair: boolean) => {
      const observations: PromptObservation[] = [];
      const reg = repairRegistry(observations);
      reg.registerPlugin('completions', 'expected-answer', {
        name: 'expected-answer',
        async check(_completionConfig, result) {
          return result.stdout === 'teal'
            ? true
            : { passed: false, feedback: 'expected value is teal' };
        },
      } satisfies CompletionPlugin);
      const runtime: TagmaRuntime = {
        ...fakeRuntime(),
        async runSpawn(spec) {
          const receivedVerifierFeedback = spec.stdin?.includes('expected value is teal') ?? false;
          return taskResult(receivedVerifierFeedback ? 'teal' : 'TODO');
        },
      };
      const result = await runPipelineGraph(
        {
          name: repair ? 'repair' : 'control',
          failure_policy: 'continue_independent',
          pipelines: [
            {
              id: 'candidate',
              cwd: workDir,
              config,
              lifecycle: {
                max_runs: 2,
                stop_when: 'success',
                ...(repair ? { repair: true } : {}),
              },
            },
          ],
        },
        workDir,
        { registry: reg, runtime, skipPluginLoading: true },
      );
      return { result, observations };
    };

    try {
      const control = await runVariant(controlDir, false);
      const repaired = await runVariant(repairDir, true);

      expect(control.result.success).toBe(false);
      expect(control.result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'failed',
      ]);
      expect(control.observations).toHaveLength(2);
      expect(
        control.observations.every(({ prompt }) => !prompt.includes('expected value is teal')),
      ).toBe(true);

      expect(repaired.result.success).toBe(true);
      expect(repaired.result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'success',
      ]);
      expect(repaired.result.pipelines[0]?.attempts[0]?.repairFeedback).toContain(
        'expected value is teal',
      );
      expect(repaired.observations[0]?.prompt).not.toContain('expected value is teal');
      expect(repaired.observations[1]?.prompt).toContain('[Previous attempt failure]');
      expect(repaired.observations[1]?.prompt).toContain('expected value is teal');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('repairs a failed prompt task with failure feedback and its prior session', async () => {
    const dir = makeDir();
    const observations: PromptObservation[] = [];
    let attempts = 0;
    const continuationOutput =
      'previous normalized output api_key=continuation-secret ' +
      'x'.repeat(6_000) +
      ' final context';
    const failedStdout =
      'first stdout ' + JSON.stringify({ api_key: 'json-secret' }) + ' --token cli-secret';
    const failedStderr =
      'Authorization: ' +
      String.fromCharCode(34) +
      'Bearer header-secret' +
      String.fromCharCode(34) +
      ' failure';
    try {
      const runtime: TagmaRuntime = {
        ...fakeRuntime(),
        async runSpawn() {
          attempts += 1;
          if (attempts === 1) {
            return {
              ...taskResult(failedStdout),
              exitCode: 1,
              stderr: failedStderr,
              stderrBytes: new TextEncoder().encode(failedStderr).byteLength,
              sessionId: 'session-one',
              normalizedOutput: continuationOutput,
              failureKind: 'exit_nonzero',
            };
          }
          return taskResult('fixed');
        },
      };
      const result = await runPipelineGraph(
        {
          name: 'repair-flow',
          pipelines: [
            {
              id: 'repair',
              config: promptPipeline(),
              cwd: dir,
              lifecycle: { max_runs: 3, stop_when: 'success', repair: true },
            },
          ],
        },
        dir,
        {
          registry: repairRegistry(observations),
          runtime,
          skipPluginLoading: true,
          taskPromptContexts: {
            'main.fix': [{ label: 'Host context', content: 'base host value' }],
          },
          resolvePipelineOptions: () => ({
            taskPromptContexts: {
              'main.fix': [{ label: 'Resolved context', content: 'resolved host value' }],
            },
          }),
        },
      );

      expect(result.success).toBe(true);
      expect(attempts).toBe(2);
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'success',
      ]);
      expect(result.pipelines[0]?.attempts[0]?.repairFeedback).toContain('main.fix');
      expect(observations[1]?.prompt).toContain('[Previous attempt failure]');
      expect(observations[0]?.prompt).toContain('[Host context]');
      expect(observations[0]?.prompt).toContain('[Resolved context]');
      expect(observations[1]?.prompt).toContain('[Host context]');
      expect(observations[1]?.prompt).toContain('[Resolved context]');
      expect(observations[1]?.prompt).toContain('failureKind: exit_nonzero');
      expect(observations[1]?.prompt).toContain('first stdout');
      expect(observations[1]?.prompt).not.toContain('json-secret');
      expect(observations[1]?.prompt).not.toContain('cli-secret');
      expect(observations[1]?.prompt).not.toContain('header-secret');
      expect(observations[1]).toMatchObject({
        sessionId: 'session-one',
        sessionDriver: 'repair-test',
      });
      const retryOutput = observations[1]?.normalizedOutput ?? '';
      expect(retryOutput).toContain('previous normalized output');
      expect(retryOutput).toContain('final context');
      expect(retryOutput).not.toContain('continuation-secret');
      expect(new TextEncoder().encode(retryOutput).byteLength).toBeLessThanOrEqual(4 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('feeds a caught attempt error into the next repair prompt', async () => {
    const dir = makeDir();
    const observations: PromptObservation[] = [];
    try {
      const runtime: TagmaRuntime = {
        ...fakeRuntime(),
        async runSpawn() {
          return taskResult('fixed');
        },
      };
      const result = await runPipelineGraph(
        {
          name: 'repair-flow',
          pipelines: [
            {
              id: 'repair',
              config: promptPipeline(),
              cwd: dir,
              lifecycle: { max_runs: 2, stop_when: 'success', repair: true },
            },
          ],
        },
        dir,
        {
          registry: repairRegistry(observations),
          runtime,
          skipPluginLoading: true,
          resolvePipelineOptions: (_pipeline, context) => {
            if (context.attempt === 1) throw new Error('api_key=private-key unavailable');
            return {};
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.pipelines[0]?.attempts[0]?.repairFeedback).toContain(
        'threw before producing a result',
      );
      expect(result.pipelines[0]?.attempts[0]?.repairFeedback).not.toContain('private-key');
      expect(observations[0]?.prompt).toContain('[Previous attempt failure]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clears a stale pipeline result when the final repair attempt throws', async () => {
    const dir = makeDir();
    let runs = 0;
    try {
      const runtime = fakeRuntime(async () => {
        runs += 1;
        return {
          ...taskResult('first result'),
          exitCode: 1,
          stderr: 'first attempt failed',
          stderrBytes: 20,
          failureKind: 'exit_nonzero',
        };
      });
      const result = await runPipelineGraph(
        {
          name: 'repair-flow',
          pipelines: [
            {
              id: 'repair',
              config: commandPipeline('Repair', 'repair-command'),
              cwd: dir,
              lifecycle: { max_runs: 2, stop_when: 'success', repair: true },
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime,
          skipPluginLoading: true,
          resolvePipelineOptions: (_pipeline, context) => {
            if (context.attempt === 2) throw new Error('final attempt setup failed');
            return {};
          },
        },
      );

      expect(runs).toBe(1);
      expect(result.success).toBe(false);
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'failed',
        'failed',
      ]);
      expect(result.pipelines[0]?.error).toContain('final attempt setup failed');
      expect(result.pipelines[0]?.result).toBeNull();
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

  test('runs an infinite pipeline loop until the graph is aborted', async () => {
    const dir = makeDir();
    const abort = new AbortController();
    let attempts = 0;
    const maxRunsUpdates: Array<number | null> = [];
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'loop',
              config: commandPipeline('Loop', 'loop-command'),
              cwd: dir,
              lifecycle: { max_runs: 'infinite', stop_when: 'always' },
            },
          ],
        },
        dir,
        {
          signal: abort.signal,
          registry: registry(),
          runtime: fakeRuntime(async () => {
            attempts += 1;
            if (attempts === 3) abort.abort();
            return taskResult(`attempt ${attempts}\n`);
          }),
          skipPluginLoading: true,
          onEvent: (event) => {
            if (event.type === 'pipeline_update' && event.maxRuns !== undefined) {
              maxRunsUpdates.push(event.maxRuns);
            }
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.abortReason).toBe('external');
      expect(attempts).toBe(3);
      expect(result.pipelines[0]?.status).toBe('aborted');
      expect(result.pipelines[0]?.runCount).toBe(3);
      expect(result.pipelines[0]?.maxRuns).toBeNull();
      expect(result.pipelines[0]?.attempts.map((attempt) => attempt.status)).toEqual([
        'success',
        'success',
        'aborted',
      ]);
      expect(maxRunsUpdates).toContain(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks a self-repair pipeline failed after exhausting its attempts', async () => {
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
              lifecycle: { max_runs: 2, stop_when: 'success', repair: true },
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
      expect(result.pipelines[0]?.attempts[0]?.repairFeedback).toContain('main.task');
      expect(result.pipelines[0]?.attempts[1]?.repairFeedback).toBeNull();
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

  test('rejects malformed programmatic pipeline cwd before graph execution starts', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      await expect(
        runPipelineGraph(
          {
            name: 'release-flow',
            pipelines: [
              {
                id: 'bad',
                config: commandPipeline('Bad', 'bad'),
                cwd: '   ',
              },
            ],
          },
          dir,
          {
            registry: registry(),
            runtime: fakeRuntime(),
            skipPluginLoading: true,
            onEvent: (event) => events.push(event.type),
          },
        ),
      ).rejects.toThrow(/pipelines\[0\]\.cwd/);

      expect(events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects malformed programmatic graph shape before graph execution starts', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      const graph = {
        name: 'release-flow',
        maxConcurrency: 2,
        pipelines: [
          null,
          {
            id: 'api',
            config: commandPipeline('API', 'build-api'),
            cwd: dir,
            dependsOn: ['missing'],
            position: { x: 0, y: 0, z: 1 },
            lifecycle: { maxRuns: 2 },
          },
        ],
      } as unknown as PipelineGraphConfig;

      let error: unknown;
      try {
        await runPipelineGraph(graph, dir, {
          registry: registry(),
          runtime: fakeRuntime(),
          skipPluginLoading: true,
          onEvent: (event) => events.push(event.type),
        });
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).diagnostics).toEqual(
        expect.arrayContaining([
          { path: 'maxConcurrency', message: 'Unknown workflow field "maxConcurrency"' },
          { path: 'pipelines[0]', message: 'Pipeline node must be an object' },
          {
            path: 'pipelines[1].dependsOn',
            message: 'Unknown workflow pipeline field "dependsOn"',
          },
          {
            path: 'pipelines[1].position.z',
            message: 'Unknown workflow position field "z"',
          },
          {
            path: 'pipelines[1].lifecycle.maxRuns',
            message: 'Unknown workflow lifecycle field "maxRuns"',
          },
        ]),
      );
      expect(events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves relative programmatic pipeline cwd from the graph workDir', async () => {
    const dir = makeDir();
    const childDir = join(dir, 'services', 'api');
    const seenCwds: string[] = [];
    try {
      mkdirSync(childDir, { recursive: true });
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'api',
              config: commandPipeline('API', 'build-api'),
              cwd: 'services/api',
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async (command, cwd) => {
            seenCwds.push(cwd);
            return taskResult(String(command));
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(seenCwds).toEqual([childDir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps absolute programmatic pipeline cwd as an explicit workDir', async () => {
    const dir = makeDir();
    const externalDir = makeDir();
    const seenCwds: string[] = [];
    try {
      const result = await runPipelineGraph(
        {
          name: 'release-flow',
          pipelines: [
            {
              id: 'external',
              config: commandPipeline('External', 'build-external'),
              cwd: externalDir,
            },
          ],
        },
        dir,
        {
          registry: registry(),
          runtime: fakeRuntime(async (command, cwd) => {
            seenCwds.push(cwd);
            return taskResult(String(command));
          }),
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(seenCwds).toEqual([externalDir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  test('rejects relative programmatic pipeline cwd that escapes the graph workDir', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      await expect(
        runPipelineGraph(
          {
            name: 'release-flow',
            pipelines: [
              {
                id: 'bad',
                config: commandPipeline('Bad', 'bad'),
                cwd: '../outside',
              },
            ],
          },
          dir,
          {
            registry: registry(),
            runtime: fakeRuntime(),
            skipPluginLoading: true,
            onEvent: (event) => events.push(event.type),
          },
        ),
      ).rejects.toThrow(/pipelines\[0\]\.cwd/);

      expect(events).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects unsafe programmatic pipeline paths before graph execution starts', async () => {
    const dir = makeDir();
    const events: string[] = [];
    try {
      await expect(
        runPipelineGraph(
          {
            name: 'release-flow',
            pipelines: [
              {
                id: 'bad',
                path: '../outside.yaml',
                config: commandPipeline('Bad', 'bad'),
                cwd: dir,
              },
            ],
          },
          dir,
          {
            registry: registry(),
            runtime: fakeRuntime(),
            skipPluginLoading: true,
            onEvent: (event) => events.push(event.type),
          },
        ),
      ).rejects.toThrow(/pipelines\[0\]\.path/);

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
          pipelines: [
            {
              id: 'p1',
              config: commandPipeline('P1', 'p1'),
              cwd: dir,
              lifecycle: { max_runs: 3, stop_when: 'success', repair: true },
            },
          ],
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
      expect(result.pipelines[0]?.runCount).toBe(1);
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
