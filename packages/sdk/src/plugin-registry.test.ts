import { describe, expect, test } from 'bun:test';
import { PluginRegistry, runPipeline } from '@tagma/core';
import { bootstrapBuiltins } from './bootstrap';
import type {
  DriverPlugin,
  TriggerPlugin,
  PipelineConfig,
  TagmaRuntime,
  TaskResult,
} from '@tagma/types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TagmaPlugin } from '@tagma/types';

function makeDriver(name: string, marker: string[]): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    async buildCommand() {
      marker.push(`buildCommand:${name}`);
      return { args: ['echo', 'noop'] };
    },
  };
}

function makeTrigger(name: string, marker: string[]): TriggerPlugin {
  return {
    name,
    watch: () => ({
      fired: Promise.resolve().then(() => {
        marker.push(`watch:${name}`);
      }),
      dispose() {
        /* no resources */
      },
    }),
  };
}

function taskResult(stdout = 'ok\n'): TaskResult {
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

function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand() {
      return taskResult();
    },
    async runSpawn() {
      return taskResult();
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
    now: () => new Date('2026-04-26T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

describe('PluginRegistry — instance isolation', () => {
  test('two registries do not share drivers registered under the same type', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    const markerA: string[] = [];
    const markerB: string[] = [];

    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', markerA));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', markerB));

    expect(regA.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('mockA');
    expect(regB.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('mockB');

    expect(regA.hasHandler('drivers', 'mock')).toBe(true);
    expect(regB.hasHandler('drivers', 'mock')).toBe(true);
    expect(regA.hasHandler('triggers', 'mock')).toBe(false);
  });

  test('unregistering in one registry does not affect the other', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', []));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', []));

    expect(regA.unregisterPlugin('drivers', 'mock')).toBe(true);
    expect(regA.hasHandler('drivers', 'mock')).toBe(false);
    expect(regB.hasHandler('drivers', 'mock')).toBe(true);
  });

  test('listRegistered is scoped per instance', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    regA.registerPlugin('triggers', 'a-only', makeTrigger('a-only', []));
    regB.registerPlugin('triggers', 'b-only', makeTrigger('b-only', []));

    expect(regA.listRegistered('triggers')).toEqual(['a-only']);
    expect(regB.listRegistered('triggers')).toEqual(['b-only']);
  });

  test('registering the same instance twice returns unchanged', () => {
    const reg = new PluginRegistry();
    const driver = makeDriver('same', []);
    expect(reg.registerPlugin('drivers', 'mock', driver)).toBe('registered');
    expect(reg.registerPlugin('drivers', 'mock', driver)).toBe('unchanged');
  });

  test('duplicate handler registration is rejected unless replacement is explicit', () => {
    const reg = new PluginRegistry();
    expect(reg.registerPlugin('drivers', 'mock', makeDriver('one', []))).toBe('registered');

    expect(() => reg.registerPlugin('drivers', 'mock', makeDriver('two', []))).toThrow(
      /Duplicate plugin capability "drivers\/mock"/,
    );
    expect(reg.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('one');
  });

  test('explicit replacement returns replaced', () => {
    const reg = new PluginRegistry();
    expect(reg.registerPlugin('drivers', 'mock', makeDriver('one', []))).toBe('registered');
    expect(reg.registerPlugin('drivers', 'mock', makeDriver('two', []), { replace: true })).toBe(
      'replaced',
    );
    expect(reg.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('two');
  });

  test('bootstrapBuiltins(target) populates a specific instance', () => {
    const fresh = new PluginRegistry();
    expect(fresh.hasHandler('drivers', 'opencode')).toBe(false);

    bootstrapBuiltins(fresh);

    expect(fresh.hasHandler('drivers', 'opencode')).toBe(true);
    expect(fresh.hasHandler('triggers', 'file')).toBe(true);
    expect(fresh.hasHandler('triggers', 'manual')).toBe(true);
    expect(fresh.hasHandler('completions', 'exit_code')).toBe(true);
    expect(fresh.hasHandler('middlewares', 'static_context')).toBe(true);

    // Default registry's state is independent of `fresh` — if the default
    // happens to have opencode (because another test bootstrapped it), that
    // is fine; the guarantee is that `fresh.unregister` does not leak.
    fresh.unregisterPlugin('drivers', 'opencode');
    expect(fresh.hasHandler('drivers', 'opencode')).toBe(false);
  });
});

describe('PluginRegistry — capability plugins', () => {
  test('registerTagmaPlugin registers multiple capabilities from one package', () => {
    const reg = new PluginRegistry();
    const driver = makeDriver('cap-driver', []);
    const trigger = makeTrigger('cap-trigger', []);
    const plugin: TagmaPlugin = {
      name: 'tagma-plugin-multi',
      capabilities: {
        drivers: { cap_driver: driver },
        triggers: { cap_trigger: trigger },
      },
    };

    expect(reg.registerTagmaPlugin(plugin)).toEqual([
      { category: 'drivers', type: 'cap_driver', result: 'registered' },
      { category: 'triggers', type: 'cap_trigger', result: 'registered' },
    ]);
    expect(reg.getHandler<DriverPlugin>('drivers', 'cap_driver')).toBe(driver);
    expect(reg.getHandler<TriggerPlugin>('triggers', 'cap_trigger')).toBe(trigger);
  });

  test('registerTagmaPlugin rejects duplicate capabilities', () => {
    const reg = new PluginRegistry();
    reg.registerPlugin('drivers', 'mock', makeDriver('first', []));

    expect(() =>
      reg.registerTagmaPlugin({
        name: 'tagma-plugin-replacement',
        capabilities: {
          drivers: { mock: makeDriver('second', []) },
        },
      }),
    ).toThrow(/Duplicate plugin capability "drivers\/mock"/);
    expect(reg.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('first');
  });

  test('loadPlugins accepts capability plugin default exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-capability-plugin-'));
    const pluginDir = join(dir, 'node_modules', 'tagma-plugin-capability');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'tagma-plugin-capability',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        'const driver = {',
        "  name: 'cap-driver',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'cap'] }; },",
        '};',
        'const trigger = {',
        "  name: 'cap-trigger',",
        '  watch() { return { fired: Promise.resolve(), dispose() {} }; }',
        '};',
        'export default {',
        "  name: 'tagma-plugin-capability',",
        '  capabilities: {',
        '    drivers: { cap_driver: driver },',
        '    triggers: { cap_trigger: trigger },',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const reg = new PluginRegistry();
      await reg.loadPlugins(['tagma-plugin-capability'], dir);
      expect(reg.hasHandler('drivers', 'cap_driver')).toBe(true);
      expect(reg.hasHandler('triggers', 'cap_trigger')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadPlugins rejects legacy plugin module exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-legacy-plugin-'));
    const pluginDir = join(dir, 'node_modules', 'tagma-plugin-legacy');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'tagma-plugin-legacy',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        "export const pluginCategory = 'drivers';",
        "export const pluginType = 'legacy';",
        'export default {',
        "  name: 'legacy',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'legacy'] }; },",
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const reg = new PluginRegistry();
      await expect(reg.loadPlugins(['tagma-plugin-legacy'], dir)).rejects.toThrow(
        /must default-export a TagmaPlugin/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PluginRegistry — validation', () => {
  test('rejects unknown category', () => {
    const reg = new PluginRegistry();
    expect(() => reg.registerPlugin('nope' as 'drivers', 'x', makeDriver('x', []))).toThrow(
      /Unknown plugin category/,
    );
  });

  test('rejects driver missing buildCommand', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'drivers',
        'broken',
        // deliberately bad: no buildCommand
        {
          name: 'broken',
          capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
        } as unknown as DriverPlugin,
      ),
    ).toThrow(/must export buildCommand/);
  });

  test('rejects trigger plugins without watch', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin('triggers', 'broken', {
        name: 'broken',
      } as unknown as TriggerPlugin),
    ).toThrow(/must export watch/);
  });

  test('rejects handler with missing name', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'drivers',
        'x',
        // deliberately bad: no name
        {
          capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
          buildCommand: async () => ({ args: [] }),
        } as unknown as DriverPlugin,
      ),
    ).toThrow(/non-empty "name"/);
  });

  test('rejects plugin type identifiers that are not YAML-safe ids', () => {
    const reg = new PluginRegistry();
    expect(() => reg.registerPlugin('drivers', '../evil', makeDriver('evil', []))).toThrow(
      /Plugin type .* must match/,
    );
  });

  test('middleware install hint uses singular middleware package name', () => {
    const reg = new PluginRegistry();
    expect(() => reg.getHandler('middlewares', 'audit')).toThrow(
      /bun add @tagma\/middleware-audit/,
    );
  });

  test('rejects middleware without enhanceDoc', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin('middlewares', 'old', {
        name: 'old',
        async enhance(prompt: string) {
          return prompt;
        },
      } as never),
    ).toThrow(/must export enhanceDoc/);
  });

  test('preflight applies registered plugin schemas strictly', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-plugin-schema-'));
    const reg = new PluginRegistry();
    reg.registerPlugin('triggers', 'typed', {
      name: 'typed',
      schema: {
        fields: {
          path: { type: 'string', required: true },
          timeout: { type: 'duration' },
        },
      },
      watch() {
        return { fired: Promise.resolve(), dispose() {} };
      },
    } as TriggerPlugin);

    try {
      await expect(
        runPipeline(
          {
            name: 'plugin-schema',
            mode: 'trusted',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [
                  {
                    id: 'x',
                    command: 'echo hi',
                    trigger: { type: 'typed', path: 42, extra: true },
                  },
                ],
              },
            ],
          },
          tmp,
          { registry: reg, runtime: fakeRuntime(), mode: 'trusted' },
        ),
      ).rejects.toThrow(/trigger\.extra is not a supported field[\s\S]*trigger\.path must be a string/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runPipeline — options.registry isolation', () => {
  test('concurrent runs with different registries see their own drivers', async () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    const seenA: string[] = [];
    const seenB: string[] = [];

    bootstrapBuiltins(regA);
    bootstrapBuiltins(regB);

    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', seenA));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', seenB));

    // Command-only pipeline exercises the preflight path (which uses the
    // registry) plus the run-loop path without requiring a real driver
    // invocation. We verify isolation by asserting that preflight with a
    // registry missing `mock` rejects, while the matching registry accepts.
    const config: PipelineConfig = {
      name: 'isolation-test',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'only', name: 'only', command: 'echo hi' }],
        },
      ],
    };

    const tmpA = mkdtempSync(join(tmpdir(), 'tagma-regA-'));
    const tmpB = mkdtempSync(join(tmpdir(), 'tagma-regB-'));
    try {
      const [resA, resB] = await Promise.all([
        runPipeline(config, tmpA, {
          registry: regA,
          runtime: fakeRuntime(),
          skipPluginLoading: true,
          mode: 'trusted',
        }),
        runPipeline(config, tmpB, {
          registry: regB,
          runtime: fakeRuntime(),
          skipPluginLoading: true,
          mode: 'trusted',
        }),
      ]);
      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.runId).not.toBe(resB.runId);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  test('preflight fails when referenced driver is missing from the passed registry', async () => {
    const regNoOpencode = new PluginRegistry();
    // Deliberately do NOT bootstrap builtins — opencode is not registered.
    const config: PipelineConfig = {
      name: 'preflight-miss',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'x', name: 'x', prompt: 'hello' }],
        },
      ],
    };
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-miss-'));
    try {
      await expect(
        runPipeline(config, tmp, {
          registry: regNoOpencode,
          skipPluginLoading: true,
          mode: 'trusted',
        }),
      ).rejects.toThrow(/driver "opencode" not registered/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('runPipeline rejects missing explicit registry', async () => {
    const config: PipelineConfig = {
      name: 'missing-registry',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'only', name: 'only', command: 'echo hi' }],
        },
      ],
    };
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-default-'));
    try {
      await expect(runPipeline(config, tmp, { skipPluginLoading: true } as never)).rejects.toThrow(
        /requires options\.registry/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('runPipeline defaults to safe mode when no mode is configured', async () => {
    const config: PipelineConfig = {
      name: 'safe-by-default',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'only', name: 'only', command: 'echo hi' }],
        },
      ],
    };
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-safe-default-'));
    try {
      await expect(
        runPipeline(config, tmp, { registry: new PluginRegistry(), runtime: fakeRuntime() }),
      ).rejects.toThrow(/safe mode blocks command task "t\.only"/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('runPipeline resolves pipeline plugins from the workspace workDir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-workdir-plugin-'));
    const pluginDir = join(tmp, 'node_modules', 'tagma-plugin-workspace-driver');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'tagma-plugin-workspace-driver',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        'const driver = {',
        "  name: 'workspace-driver',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'workspace'] }; },",
        '};',
        'export default {',
        "  name: 'tagma-plugin-workspace-driver',",
        '  capabilities: { drivers: { workspace: driver } },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    const reg = new PluginRegistry();
    const config: PipelineConfig = {
      name: 'workdir-plugin',
      driver: 'workspace',
      plugins: ['tagma-plugin-workspace-driver'],
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'x', name: 'x', prompt: 'hello' }],
        },
      ],
    };

    try {
      const result = await runPipeline(config, tmp, {
        registry: reg,
        runtime: fakeRuntime(),
        mode: 'trusted',
      });

      expect(result.success).toBe(true);
      expect(reg.hasHandler('drivers', 'workspace')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('safe mode blocks command tasks and unsafe capabilities', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-safe-mode-'));
    const reg = new PluginRegistry();
    try {
      await expect(
        runPipeline(
          {
            name: 'safe-command',
            tracks: [{ id: 't', name: 'T', tasks: [{ id: 'x', command: 'echo hi' }] }],
          },
          tmp,
          { registry: reg, runtime: fakeRuntime(), mode: 'safe' },
        ),
      ).rejects.toThrow(/safe mode blocks command task "t\.x"/);

      await expect(
        runPipeline(
          {
            name: 'safe-plugin',
            plugins: ['tagma-plugin-anything'],
            tracks: [{ id: 't', name: 'T', tasks: [{ id: 'x', prompt: 'hello' }] }],
          },
          tmp,
          { registry: reg, runtime: fakeRuntime(), mode: 'safe' },
        ),
      ).rejects.toThrow(/safe mode blocks automatic plugin loading/);

      await expect(
        runPipeline(
          {
            name: 'safe-execute-permission',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [
                  {
                    id: 'x',
                    prompt: 'hello',
                    permissions: { read: true, write: true, execute: true },
                  },
                ],
              },
            ],
          },
          tmp,
          { registry: reg, runtime: fakeRuntime(), mode: 'safe' },
        ),
      ).rejects.toThrow(/safe mode blocks execute permission on task "t\.x"/);

      const bootstrapped = new PluginRegistry();
      bootstrapBuiltins(bootstrapped);
      await expect(
        runPipeline(
          {
            name: 'safe-write-unenforced-driver',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [
                  {
                    id: 'x',
                    prompt: 'hello',
                    permissions: { read: true, write: true, execute: false },
                  },
                ],
              },
            ],
          },
          tmp,
          {
            registry: bootstrapped,
            runtime: fakeRuntime(),
            mode: 'safe',
            safeModeAllowlist: { drivers: ['opencode'] },
            skipPluginLoading: true,
          },
        ),
      ).rejects.toThrow(/safe mode blocks write permission for driver "opencode"/);

      await expect(
        runPipeline(
          {
            name: 'safe-unenforced-driver',
            tracks: [{ id: 't', name: 'T', tasks: [{ id: 'x', prompt: 'hello' }] }],
          },
          tmp,
          {
            registry: bootstrapped,
            runtime: fakeRuntime(),
            mode: 'safe',
            safeModeAllowlist: { drivers: ['opencode'] },
            skipPluginLoading: true,
          },
        ),
      ).rejects.toThrow(/safe mode blocks driver "opencode"/);

      await expect(
        runPipeline(
          {
            name: 'safe-completion',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [
                  {
                    id: 'x',
                    prompt: 'hello',
                    completion: { type: 'output_check', check: 'echo ok' },
                  },
                ],
              },
            ],
          },
          tmp,
          { registry: reg, runtime: fakeRuntime(), mode: 'safe' },
        ),
      ).rejects.toThrow(/safe mode blocks completion "output_check"/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('trigger timeout disposes an unsettled trigger watcher', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-trigger-dispose-'));
    const reg = new PluginRegistry();
    let disposeCount = 0;
    reg.registerPlugin('triggers', 'leaky', {
      name: 'leaky',
      watch() {
        return {
          fired: new Promise<never>(() => {
            /* intentionally never settles */
          }),
          dispose() {
            disposeCount++;
          },
        };
      },
    } as unknown as TriggerPlugin);

    try {
      const result = await runPipeline(
        {
          name: 'trigger-dispose',
          tracks: [
            {
              id: 't',
              name: 'T',
              tasks: [
                {
                  id: 'x',
                  command: 'echo hi',
                  timeout: '0.01s',
                  trigger: { type: 'leaky' },
                },
              ],
            },
          ],
        },
        tmp,
        { registry: reg, runtime: fakeRuntime(), mode: 'trusted' },
      );

      expect(result.success).toBe(false);
      expect(result.states.get('t.x')?.status).toBe('timeout');
      expect(disposeCount).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('trigger timeout honors on_failure stop_all across the whole pipeline', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-stop-all-trigger-'));
    const reg = new PluginRegistry();
    reg.registerPlugin('triggers', 'never', {
      name: 'never',
      watch() {
        return {
          fired: new Promise<never>(() => {
            /* intentionally never settles */
          }),
          dispose() {
            /* no resources */
          },
        };
      },
    } as unknown as TriggerPlugin);

    const commands: string[] = [];
    const runtime: TagmaRuntime = {
      ...fakeRuntime(),
      async runCommand(command) {
        commands.push(command);
        if (command === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return taskResult(command);
      },
    };
    const events: unknown[] = [];

    try {
      const result = await runPipeline(
        {
          name: 'stop-all-trigger-timeout',
          tracks: [
            {
              id: 't',
              name: 'T',
              on_failure: 'stop_all',
              tasks: [
                {
                  id: 'gate',
                  command: 'gate',
                  timeout: '0.01s',
                  trigger: { type: 'never' },
                },
                { id: 'slow', command: 'slow' },
                { id: 'after', command: 'after', depends_on: ['slow'] },
              ],
            },
          ],
        },
        tmp,
        {
          registry: reg,
          runtime,
          mode: 'trusted',
          onEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(false);
      expect(result.states.get('t.gate')?.status).toBe('timeout');
      expect(result.states.get('t.after')?.status).toBe('skipped');
      expect(commands).not.toContain('after');
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'run_end', abortReason: 'stop_all' }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('task_start blocked tasks honor on_failure stop_all', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-stop-all-task-start-'));
    const runtime: TagmaRuntime = {
      ...fakeRuntime(),
      async runSpawn() {
        return {
          ...taskResult(''),
          exitCode: 2,
          stderr: 'blocked by policy',
          stderrBytes: 'blocked by policy'.length,
          failureKind: 'exit_nonzero',
        };
      },
    };
    const events: unknown[] = [];

    try {
      const result = await runPipeline(
        {
          name: 'stop-all-task-start',
          hooks: { task_start: 'exit 2' },
          tracks: [
            {
              id: 't',
              name: 'T',
              on_failure: 'stop_all',
              tasks: [
                { id: 'gate', command: 'gate' },
                { id: 'after', command: 'after', depends_on: ['gate'] },
              ],
            },
          ],
        },
        tmp,
        {
          registry: new PluginRegistry(),
          runtime,
          mode: 'trusted',
          onEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(false);
      expect(result.states.get('t.gate')?.status).toBe('blocked');
      expect(result.states.get('t.after')?.status).toBe('skipped');
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'run_end', abortReason: 'stop_all' }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('pipeline_start gate marks all idle tasks blocked in summary', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-hook-blocked-'));
    const runtime: TagmaRuntime = {
      ...fakeRuntime(),
      async runSpawn() {
        return {
          ...taskResult(''),
          exitCode: 2,
          stderr: 'blocked by policy',
          stderrBytes: 'blocked by policy'.length,
          failureKind: 'exit_nonzero',
        };
      },
    };

    try {
      const result = await runPipeline(
        {
          name: 'blocked-start',
          hooks: { pipeline_start: 'exit 2' },
          tracks: [{ id: 't', name: 'T', tasks: [{ id: 'x', command: 'echo hi' }] }],
        },
        tmp,
        { registry: new PluginRegistry(), runtime, mode: 'trusted' },
      );

      expect(result.success).toBe(false);
      expect(result.summary.total).toBe(1);
      expect(result.summary.blocked).toBe(1);
      expect(result.summary.success).toBe(0);
      expect(result.states.get('t.x')?.status).toBe('blocked');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
