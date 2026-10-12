import { expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma } from '@tagma/sdk';
import { parseYaml, resolveConfig, serializePipeline } from '@tagma/sdk/yaml';
import { runtimeWithInjectedEnv } from '../server/execution/native-broker';
import { createControlledTrialFaultRuntime } from '../server/chat-trial-controlled-fault-runtime';
import type {
  DriverPlugin,
  RunEventPayload,
  RunOptions,
  SpawnSpec,
  TaskResult,
} from '@tagma/types';

function rejectedConsumerResult(): TaskResult {
  return {
    exitCode: 7,
    stdout: '',
    stderr: 'consumer rejected the changed artifact',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength('consumer rejected the changed artifact'),
    durationMs: 0,
    sessionId: null,
    normalizedOutput: null,
    failureKind: 'exit_nonzero',
  };
}

test('native driver sees the replacement before base.runSpawn and keeps its invocation unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-spawn-consumer-fault-'));
  try {
    const artifact = join(root, 'data.json');
    const spec: SpawnSpec = {
      args: ['fixture-driver', 'run'],
      cwd: root,
      stdin: 'fixture prompt',
      env: { FIXTURE_VALUE: 'native-driver-env' },
    };
    const driver: DriverPlugin = {
      name: 'fixture-driver',
      capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
      buildCommand: async () => spec,
    };
    const result = rejectedConsumerResult();
    let calls = 0;
    const base = {
      ...runtimeWithInjectedEnv({}),
      async runSpawn(
        actualSpec: SpawnSpec,
        actualDriver: DriverPlugin | null,
        actualOptions?: RunOptions,
      ) {
        // This is the first consumer instruction; no native executable is launched.
        expect(readFileSync(artifact, 'utf8')).toBe('[]');
        expect(actualSpec).toBe(spec);
        expect(actualDriver).toBe(driver);
        expect(actualOptions).toBe(options);
        calls += 1;
        return result;
      },
    };
    const controlled = createControlledTrialFaultRuntime(
      base,
      {
        type: 'artifact-replace',
        producerTaskId: 'flow.source',
        consumerTaskId: 'flow.report',
        path: 'data.json',
        content: '[]',
      },
      { workDir: root, relativeYamlPath: 'flow/flow.yaml', artifactPath: artifact },
    );
    writeFileSync(artifact, '[1]');
    controlled.observeEvent({
      type: 'task_update',
      taskId: 'flow.source',
      status: 'success',
    } as RunEventPayload);
    const stderrPath = controlled.runtime.logStore.taskOutputPath({
      workDir: root,
      runId: 'run_spawn',
      taskId: 'flow.report',
      stream: 'stderr',
    });
    const options: RunOptions = { stderrPath, timeoutMs: 1234, envPolicy: { mode: 'minimal' } };
    expect(await controlled.runtime.runSpawn(spec, driver, options)).toBe(result);
    expect(calls).toBe(1);
    expect(controlled.observed()).toMatchObject({
      applied: true,
      observed: true,
      diagnostic: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of [
  'failed-producer',
  'running-producer',
  'foreign-consumer',
  'unregistered-path',
] as const)
  test(`native artifact replacement does not inject for ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-spawn-scope-guard-'));
    try {
      const artifact = join(root, 'data.json');
      let calls = 0;
      const controlled = createControlledTrialFaultRuntime(
        {
          ...runtimeWithInjectedEnv({}),
          async runSpawn() {
            expect(readFileSync(artifact, 'utf8')).toBe('[1]');
            calls += 1;
            return rejectedConsumerResult();
          },
        },
        {
          type: 'artifact-replace',
          producerTaskId: 'flow.source',
          consumerTaskId: 'flow.report',
          path: 'data.json',
          content: '[]',
        },
        { workDir: root, relativeYamlPath: 'flow/flow.yaml', artifactPath: artifact },
      );
      writeFileSync(artifact, '[1]');
      controlled.observeEvent({
        type: 'task_update',
        taskId: 'flow.source',
        status:
          mode === 'failed-producer'
            ? 'failed'
            : mode === 'running-producer'
              ? 'running'
              : 'success',
      } as RunEventPayload);
      const stdoutPath =
        mode === 'unregistered-path'
          ? join(root, 'unregistered.stdout')
          : controlled.runtime.logStore.taskOutputPath({
              workDir: root,
              runId: 'run_scope',
              taskId: mode === 'foreign-consumer' ? 'flow.other' : 'flow.report',
              stream: 'stdout',
            });
      await controlled.runtime.runSpawn({ args: ['fixture-driver', 'run'], cwd: root }, null, {
        stdoutPath,
      });
      expect(calls).toBe(1);
      expect(controlled.observed()).toMatchObject({
        applied: false,
        observed: false,
        diagnostic:
          mode === 'failed-producer' || mode === 'running-producer'
            ? expect.stringContaining('producer did not complete')
            : null,
      });
      expect(readFileSync(artifact, 'utf8')).toBe('[1]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('artifact observation proves injection even when the consumer rejects the changed data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-consumer-fault-'));
  try {
    mkdirSync(join(root, '.tagma'));
    const config = resolveConfig(
      parseYaml(
        serializePipeline({
          name: 'Consumer recovery boundary',
          tracks: [
            {
              id: 'flow',
              name: 'Flow',
              tasks: [
                {
                  id: 'source',
                  name: 'Source',
                  command: {
                    argv: [
                      process.execPath,
                      '-e',
                      'require("node:fs").writeFileSync("data.json","[1]")',
                    ],
                  },
                  completion: { type: 'file_exists', path: 'data.json' },
                },
                {
                  id: 'report',
                  name: 'Report',
                  depends_on: ['flow.source'],
                  command: {
                    argv: [
                      process.execPath,
                      '-e',
                      'const data=JSON.parse(require("node:fs").readFileSync("data.json","utf8"));if(data.length===0)process.exit(7)',
                    ],
                  },
                },
              ],
            },
          ],
        }),
      ),
      root,
    );
    const controlled = createControlledTrialFaultRuntime(
      runtimeWithInjectedEnv({}),
      {
        type: 'artifact-replace',
        producerTaskId: 'flow.source',
        consumerTaskId: 'flow.report',
        path: 'data.json',
        content: '[]',
      },
      { workDir: root, relativeYamlPath: 'flow/flow.yaml', artifactPath: join(root, 'data.json') },
    );
    const result = await createTagma({ runtime: controlled.runtime }).run(config, {
      cwd: root,
      onEvent: (event) => {
        if (
          event.type === 'task_update' &&
          event.taskId === 'flow.report' &&
          event.status === 'running'
        )
          return;
        controlled.observeEvent(event);
      },
    });
    expect(controlled.observed().diagnostic).toBeNull();
    expect(result.states.get('flow.report')?.status).toBe('failed');
    expect(readFileSync(join(root, 'data.json'), 'utf8')).toBe('[]');
    expect(controlled.observed()).toMatchObject({ applied: true, observed: true });
  } finally {
    expect(root.startsWith(join(tmpdir(), 'tagma-consumer-fault-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Host timeout uses native process failure and the production downstream recovery path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-native-evidence-'));
  try {
    mkdirSync(join(root, '.tagma'));
    const config = {
      name: 'Recovery',
      tracks: [
        {
          id: 'flow',
          name: 'Flow',
          on_failure: 'ignore' as const,
          tasks: [
            {
              id: 'source',
              name: 'Source',
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  'require("node:fs").writeFileSync("data.json", "[1]")',
                ],
              },
              completion: { type: 'file_exists', path: 'data.json' },
            },
            {
              id: 'report',
              name: 'Report',
              depends_on: ['flow.source'],
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  'const fs=require("node:fs"); fs.writeFileSync("report.txt",fs.existsSync("data.json")?"R1":"Q7")',
                ],
              },
            },
          ],
        },
      ],
    };
    const fault = createControlledTrialFaultRuntime(
      runtimeWithInjectedEnv({}),
      { type: 'task-timeout', taskId: 'flow.source', timeoutMs: 100 },
      { workDir: root, relativeYamlPath: 'flow/flow.yaml', artifactPath: null },
    );
    const compiled = resolveConfig(parseYaml(serializePipeline(config)), root);
    const result = await createTagma({ runtime: fault.runtime }).run(compiled, {
      cwd: root,
      onEvent: fault.observeEvent,
    });
    expect(result.states.get('flow.source')?.status).toBe('timeout');
    expect(result.states.get('flow.report')?.status).toBe('success');
    expect(readFileSync(join(root, 'report.txt'), 'utf8')).toBe('Q7');
    expect(fault.observed()).toMatchObject({
      applied: true,
      observed: true,
      failureKind: 'timeout',
    });
  } finally {
    expect(root.startsWith(join(tmpdir(), 'tagma-native-evidence-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const boundary of ['command', 'spawn'] as const)
  for (const mode of ['hardlink', 'parent-junction', 'pre-seeded', 'unchanged'] as const)
    test(`artifact fault rejects ${mode} at the ${boundary} boundary without altering source bytes`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'tagma-artifact-guard-'));
      try {
        const isolated = join(root, 'case');
        const outside = join(root, 'outside');
        mkdirSync(isolated);
        mkdirSync(outside);
        const original = join(outside, 'data.json');
        writeFileSync(original, '[1]');
        const target = join(isolated, 'edge', 'data.json');
        if (mode === 'pre-seeded') {
          mkdirSync(join(isolated, 'edge'));
          writeFileSync(target, '[1]');
        }
        const instrumented = createControlledTrialFaultRuntime(
          {
            ...runtimeWithInjectedEnv({}),
            async runSpawn() {
              expect(readFileSync(target, 'utf8')).toBe('[1]');
              return rejectedConsumerResult();
            },
          },
          {
            type: 'artifact-replace',
            producerTaskId: 'flow.source',
            consumerTaskId: 'flow.report',
            path: 'edge/data.json',
            content: mode === 'unchanged' ? '[1]' : '[]',
          },
          { workDir: isolated, relativeYamlPath: 'flow/flow.yaml', artifactPath: target },
        );
        if (mode === 'parent-junction')
          symlinkSync(
            outside,
            join(isolated, 'edge'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        else if (mode !== 'pre-seeded') {
          mkdirSync(join(isolated, 'edge'));
          if (mode === 'hardlink') linkSync(original, target);
          else writeFileSync(target, '[1]');
        }
        const update = (taskId: string, status: string) =>
          instrumented.observeEvent({ type: 'task_update', taskId, status } as RunEventPayload);
        update('flow.source', 'success');
        update('flow.report', 'running');
        const stdoutPath = instrumented.runtime.logStore.taskOutputPath({
          workDir: isolated,
          runId: 'run_guard',
          taskId: 'flow.report',
          stream: 'stdout',
        });
        mkdirSync(join(isolated, '.tagma', 'logs', 'run_guard'), { recursive: true });
        if (boundary === 'command')
          await instrumented.runtime.runCommand('exit 0', isolated, { stdoutPath });
        else
          await instrumented.runtime.runSpawn(
            { args: ['fixture-driver', 'run'], cwd: isolated },
            null,
            { stdoutPath },
          );
        // The native invocation boundary, rather than asynchronous event projection,
        // owns injection. The command is harmless and cannot alter the test files.
        update('flow.report', 'success');
        expect(instrumented.observed()).toMatchObject({
          applied: false,
          observed: false,
          diagnostic: expect.any(String),
        });
        expect(readFileSync(original, 'utf8')).toBe('[1]');
        expect(readFileSync(target, 'utf8')).toBe('[1]');
      } finally {
        expect(root.startsWith(join(tmpdir(), 'tagma-artifact-guard-'))).toBe(true);
        rmSync(root, { recursive: true, force: true });
      }
    });
