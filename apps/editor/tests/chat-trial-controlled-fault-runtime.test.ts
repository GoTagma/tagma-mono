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
import type { RunEventPayload } from '@tagma/types';

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

for (const mode of ['hardlink', 'parent-junction', 'pre-seeded', 'unchanged'] as const)
  test(`artifact fault rejects ${mode} without altering source bytes`, async () => {
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
        runtimeWithInjectedEnv({}),
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
      await instrumented.runtime.runCommand('exit 0', isolated, { stdoutPath });
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
