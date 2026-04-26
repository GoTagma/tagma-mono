import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PipelineRunner } from './pipeline-runner';
import { PluginRegistry } from './registry';
import type { PipelineConfig } from './types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-pipeline-runner-'));
}

function bindingsPipeline(dir: string): PipelineConfig {
  const emit = join(dir, 'emit.js');
  writeFileSync(
    emit,
    'process.stdout.write(JSON.stringify({ city: "Shanghai" }) + "\\n");\n',
  );
  const echo = join(dir, 'echo.js');
  writeFileSync(echo, 'process.stdout.write(process.argv[2] + "\\n");\n');

  return {
    name: 'runner-snapshot',
    tracks: [
      {
        id: 't',
        name: 'T',
        tasks: [
          {
            id: 'up',
            name: 'up',
            command: `node "${emit}"`,
            outputs: { city: { type: 'string' } },
          },
          {
            id: 'down',
            name: 'down',
            depends_on: ['up'],
            command: `node "${echo}" "{{inputs.city}}"`,
            inputs: { city: { from: 't.up.outputs.city', type: 'string', required: true } },
          },
        ],
      },
    ],
  };
}

async function run(config: PipelineConfig, dir: string): Promise<PipelineRunner> {
  const registry = new PluginRegistry();
  bootstrapBuiltins(registry);
  const runner = new PipelineRunner(config, dir, {
    registry,
    skipPluginLoading: true,
  });

  const result = await runner.start();
  expect(result.success).toBe(true);
  return runner;
}

describe('PipelineRunner task snapshot', () => {
  test('getTasks reflects task_update inputs and outputs', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      const down = tasks.get('t.down');
      expect(up?.outputs).toEqual({ city: 'Shanghai' });
      expect(down?.inputs).toEqual({ city: 'Shanghai' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getTasks folds streamed task logs into the task snapshot', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      expect(up?.logs.length).toBeGreaterThan(0);
      expect(up?.totalLogCount).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
