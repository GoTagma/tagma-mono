import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma } from './tagma';
import type { DriverPlugin, PipelineConfig } from './types';

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDriver(name: string, marker: string[]): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    async buildCommand() {
      marker.push(name);
      return { args: ['echo', name] };
    },
  };
}

describe('createTagma', () => {
  test('instances own isolated plugin registries', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const tagmaA = createTagma({ builtins: false });
    const tagmaB = createTagma({ builtins: false });

    tagmaA.registry.registerPlugin('drivers', 'mock', makeDriver('driver-a', seenA));
    tagmaB.registry.registerPlugin('drivers', 'mock', makeDriver('driver-b', seenB));

    expect(tagmaA.registry.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('driver-a');
    expect(tagmaB.registry.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('driver-b');
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
  });

  test('run uses only the instance registry', async () => {
    const tagma = createTagma({ builtins: false });
    const dir = makeDir('tagma-instance-run-');
    try {
      await expect(
        tagma.run(
          {
            name: 'instance-run',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [{ id: 'prompt', name: 'prompt', prompt: 'hello' }],
              },
            ],
          },
          {
            cwd: dir,
            skipPluginLoading: true,
          },
        ),
      ).rejects.toThrow(/driver "opencode" not registered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validate returns structural pipeline errors without running tasks', () => {
    const tagma = createTagma({ builtins: false });

    expect(
      tagma.validate({
        name: 'invalid',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [
              { id: 'a', name: 'A', command: 'echo a', depends_on: ['missing'] },
            ],
          },
        ],
      }),
    ).toEqual(['Task reference "missing" not found']);
  });
});
