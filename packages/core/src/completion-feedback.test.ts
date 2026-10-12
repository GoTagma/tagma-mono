import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from './index';
import type { CompletionPlugin, TagmaRuntime, TaskResult } from './types';

function commandResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: '41',
    stderr: 'child warning',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 2,
    stderrBytes: 1_300,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(result: TaskResult = commandResult()): TagmaRuntime {
  return {
    async runCommand() {
      return result;
    },
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
      async prune() {
        /* no-op */
      },
    },
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

describe('completion feedback', () => {
  test('classifies a structured failed check and appends its feedback to stderr', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-completion-feedback-'));
    const registry = new PluginRegistry();
    registry.registerPlugin('completions', 'judge', {
      name: 'judge',
      async check() {
        return { passed: false, feedback: 'Expected 42, received 41.' };
      },
    } as CompletionPlugin);

    try {
      const result = await runPipeline(
        {
          name: 'completion-feedback',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                {
                  id: 'answer',
                  command: 'answer',
                  completion: { type: 'judge' },
                },
              ],
            },
          ],
        },
        workDir,
        {
          registry,
          runtime: fakeRuntime(),
          skipPluginLoading: true,
        },
      );

      const state = result.states.get('main.answer');
      expect(result.success).toBe(false);
      expect(state?.status).toBe('failed');
      expect(state?.result?.failureKind).toBe('completion_failed');
      const completionSuffix = '\n[completion] Expected 42, received 41.';
      const expectedStderr = 'child warning' + completionSuffix;
      expect(state?.result?.stderr).toBe(expectedStderr);
      expect(state?.result?.stderrBytes).toBe(
        1_300 + new TextEncoder().encode(completionSuffix).byteLength,
      );
      expect(state?.result?.stderrDiagnostics).toEqual({
        suffix: completionSuffix,
        completeSuffix: completionSuffix,
        sourceBytes: 1_300,
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('keeps complete completion feedback separately from the bounded display suffix', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-completion-full-feedback-'));
    const feedback = ' FIRST_DIAGNOSTIC\n' + 'context ☃ '.repeat(3000) + '\nLAST_DIAGNOSTIC ';
    const registry = new PluginRegistry();
    registry.registerPlugin('completions', 'judge', {
      name: 'judge',
      async check() {
        return { passed: false, feedback };
      },
    } as CompletionPlugin);
    try {
      const result = await runPipeline(
        {
          name: 'full-feedback',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [{ id: 'answer', command: 'answer', completion: { type: 'judge' } }],
            },
          ],
        },
        workDir,
        { registry, runtime: fakeRuntime(), skipPluginLoading: true },
      );
      const task = result.states.get('main.answer')!;
      expect(task.status).toBe('failed');
      expect(task.result?.failureKind).toBe('completion_failed');
      expect(task.result?.stderr).toBe(
        'child warning\n[completion] ' + feedback.trim().slice(-16_000),
      );
      expect(task.result?.stderr).not.toContain('FIRST_DIAGNOSTIC');
      expect(task.result?.stderrDiagnostics?.completeSuffix).toBe('\n[completion] ' + feedback);
      expect(task.result?.stderrDiagnostics?.sourceBytes).toBe(1_300);
      expect(task.result?.stdout).toBe('41');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('preserves original byte provenance while extending existing diagnostics', async () => {
    const child = 'child warning ☃';
    const priorSuffix = '\n[driver] bounded diagnostic';
    const priorCompleteSuffix =
      '\n[driver] FIRST_DIAGNOSTIC\n' + 'context ☃ '.repeat(2000) + '\nLAST_DIAGNOSTIC';
    const feedback = 'Expected 42, received 41.';
    const completionSuffix = '\n[completion] ' + feedback;
    for (const sourceBytes of [undefined, 0, 1_300]) {
      const workDir = mkdtempSync(join(tmpdir(), 'tagma-completion-existing-diagnostic-'));
      const registry = new PluginRegistry();
      registry.registerPlugin('completions', 'judge', {
        name: 'judge',
        async check() {
          return { passed: false, feedback };
        },
      } as CompletionPlugin);
      const runtimeResult: TaskResult = {
        ...commandResult(),
        stderr: child + priorSuffix,
        stderrBytes: new TextEncoder().encode(child + priorSuffix).byteLength,
        stderrDiagnostics: {
          suffix: priorSuffix,
          completeSuffix: priorCompleteSuffix,
          sourceBytes,
        },
      };
      try {
        const execution = await runPipeline(
          {
            name: 'existing-diagnostic-feedback',
            tracks: [
              {
                id: 'main',
                name: 'Main',
                tasks: [{ id: 'answer', command: 'answer', completion: { type: 'judge' } }],
              },
            ],
          },
          workDir,
          { registry, runtime: fakeRuntime(runtimeResult), skipPluginLoading: true },
        );
        const task = execution.states.get('main.answer')!;
        expect(execution.success).toBe(false);
        expect(task.status).toBe('failed');
        expect(task.result?.failureKind).toBe('completion_failed');
        expect(task.result?.stderr).toBe(child + priorSuffix + completionSuffix);
        expect(task.result?.stderrBytes).toBe(
          runtimeResult.stderrBytes! + new TextEncoder().encode(completionSuffix).byteLength,
        );
        expect(task.result?.stderrDiagnostics).toEqual({
          suffix: priorSuffix + completionSuffix,
          completeSuffix: priorCompleteSuffix + completionSuffix,
          sourceBytes,
        });
        expect(task.result?.stdout).toBe(runtimeResult.stdout);
        expect(task.result?.stdoutBytes).toBe(runtimeResult.stdoutBytes);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  test('does not let completion checks override runtime output or binary failures', async () => {
    for (const failureKind of ['output_error', 'binary_missing'] as const) {
      const workDir = mkdtempSync(join(tmpdir(), `tagma-completion-${failureKind}-`));
      const registry = new PluginRegistry();
      let completionChecks = 0;
      registry.registerPlugin('completions', 'always-pass', {
        name: 'always-pass',
        async check() {
          completionChecks += 1;
          return true;
        },
      } as CompletionPlugin);
      const runtimeResult: TaskResult = {
        ...commandResult(),
        exitCode: failureKind === 'binary_missing' ? -1 : 0,
        failureKind,
        ...(failureKind === 'binary_missing'
          ? { missingBinary: 'fixture-command' }
          : {
              outputDiagnostics: [
                {
                  stream: 'stdout',
                  stage: 'read',
                  message: 'fixture stream fault',
                  capturedBytes: 2,
                  path: null,
                },
              ],
            }),
      };

      try {
        const result = await runPipeline(
          {
            name: `completion-${failureKind}`,
            tracks: [
              {
                id: 'main',
                name: 'Main',
                tasks: [
                  {
                    id: 'answer',
                    command: 'answer',
                    completion: { type: 'always-pass' },
                  },
                ],
              },
            ],
          },
          workDir,
          {
            registry,
            runtime: fakeRuntime(runtimeResult),
            skipPluginLoading: true,
          },
        );

        expect(result.success).toBe(false);
        expect(result.states.get('main.answer')?.status).toBe('failed');
        expect(result.states.get('main.answer')?.result?.failureKind).toBe(failureKind);
        expect(completionChecks).toBe(0);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  test('keeps failed empty feedback byte counts without inventing a diagnostic', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-completion-empty-'));
    const registry = new PluginRegistry();
    registry.registerPlugin('completions', 'judge', {
      name: 'judge',
      async check() {
        return false;
      },
    } as CompletionPlugin);
    try {
      const result = await runPipeline(
        {
          name: 'empty-feedback',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [{ id: 'answer', command: 'answer', completion: { type: 'judge' } }],
            },
          ],
        },
        workDir,
        {
          registry,
          runtime: fakeRuntime({ ...commandResult(), stderrBytes: undefined }),
          skipPluginLoading: true,
        },
      );
      const task = result.states.get('main.answer')!.result!;
      expect(task.stderr).toBe('child warning');
      expect(task.stderrBytes).toBe(new TextEncoder().encode('child warning').byteLength);
      expect(task.stderrDiagnostics).toBeUndefined();
      expect(task.failureKind).toBe('completion_failed');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('keeps output binding failures as typed diagnostics with unchanged child bytes and failed dependents', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-output-diagnostic-'));
    try {
      const result = await runPipeline(
        {
          name: 'output-diagnostic',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                { id: 'answer', command: 'answer', outputs: { records: { type: 'array' } } },
                { id: 'consume', command: 'consume', depends_on: ['answer'] },
              ],
            },
          ],
        },
        workDir,
        { registry: new PluginRegistry(), runtime: fakeRuntime(), skipPluginLoading: true },
      );
      const state = result.states.get('main.answer')!;
      expect(result.success).toBe(false);
      expect(state.status).toBe('failed');
      expect(state.result?.failureKind).toBe('output_error');
      expect(state.result?.outputs).toBeNull();
      expect(state.result?.stdout).toBe('41');
      expect(state.result?.stderrBytes).toBe(1_300);
      expect(state.result?.stderrDiagnostics?.sourceBytes).toBe(1_300);
      expect(state.result?.stderrDiagnostics?.suffix).toContain('[engine]');
      expect(state.result?.stderrDiagnostics?.completeSuffix).toBe(
        state.result?.stderrDiagnostics?.suffix,
      );
      expect(state.result?.stderr).toBe('child warning' + state.result?.stderrDiagnostics?.suffix);
      expect(result.states.get('main.consume')?.status).toBe('skipped');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
