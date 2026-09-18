import { describe, expect, test } from 'bun:test';

import { PluginRegistry, bootstrapBuiltins } from '@tagma/sdk/plugins';
import type { DriverPlugin, PipelineConfig, TriggerPlugin } from '@tagma/types';

import { buildChatPipelineTrialabilityReport } from '../server/chat-pipeline-trialability';

function registryWithBuiltins(): PluginRegistry {
  const registry = new PluginRegistry();
  bootstrapBuiltins(registry);
  return registry;
}

function pipelineWithEveryHostSurface(): PipelineConfig {
  return {
    name: 'Trialability surfaces',
    hooks: {
      pipeline_start: { argv: ['host-hook'] },
    },
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'command',
            name: 'Command',
            command: { argv: ['host-command'] },
            trigger: { type: 'manual' },
            middlewares: [{ type: 'static_context', path: 'context.md' }],
            completion: { type: 'exit_code', code: 0 },
          },
          {
            id: 'prompt',
            name: 'Prompt',
            prompt: 'Summarize the input.',
            driver: 'opencode',
          },
        ],
      },
    ],
  };
}

describe('chat pipeline Trial Interaction Protocol preflight', () => {
  test('reports every execution surface before a Sandbox Trial', () => {
    const report = buildChatPipelineTrialabilityReport({
      pipelineConfig: pipelineWithEveryHostSurface(),
      registry: registryWithBuiltins(),
      capabilityOwners: new Map(),
    });

    expect(report.protocolVersion).toBe(1);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: 'hook', type: 'pipeline_start' }),
        expect.objectContaining({
          component: 'command',
          taskId: 'main.command',
          disposition: 'sandbox-ready-with-host-risk',
        }),
        expect.objectContaining({
          component: 'trigger',
          taskId: 'main.command',
          type: 'manual',
          disposition: 'sandbox-ready',
        }),
        expect.objectContaining({
          component: 'middleware',
          taskId: 'main.command',
          type: 'static_context',
          disposition: 'sandbox-ready',
        }),
        expect.objectContaining({
          component: 'completion',
          taskId: 'main.command',
          type: 'exit_code',
          disposition: 'sandbox-ready',
        }),
        expect.objectContaining({
          component: 'driver',
          taskId: 'main.prompt',
          type: 'opencode',
          disposition: 'sandbox-ready-with-host-risk',
        }),
      ]),
    );
    expect(report.enforcement).toEqual({
      sandboxCases: {
        workspace: 'temporary-copy',
        stdin: 'closed',
        tty: 'none',
        secrets: 'synthetic',
        filesystem: 'host-unrestricted-outside-copy',
        network: 'host-unrestricted',
        process: 'host-unrestricted',
      },
    });
    expect(report.runnable).toBe(true);
  });

  test('fails fast when a legacy plugin omits the Trial protocol declaration', () => {
    const registry = registryWithBuiltins();
    const legacyTrigger: TriggerPlugin = {
      name: 'legacy-trigger',
      watch() {
        throw new Error('legacy trigger must not execute during preflight');
      },
    };
    registry.registerPlugin('triggers', 'legacy', legacyTrigger);

    const report = buildChatPipelineTrialabilityReport({
      pipelineConfig: {
        name: 'Legacy trigger',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'wait',
                name: 'Wait',
                command: { argv: ['noop'] },
                trigger: { type: 'legacy' },
              },
            ],
          },
        ],
      },
      registry,
      capabilityOwners: new Map([['triggers/legacy', '@example/legacy-trigger']]),
    });

    expect(report.runnable).toBe(false);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'trigger',
          type: 'legacy',
          provider: '@example/legacy-trigger',
          declaration: null,
          disposition: 'unsupported-in-unattended-trial',
        }),
      ]),
    );
    expect(report.blockers.join('\n')).toContain('does not declare Trial Interaction Protocol v1');
  });

  test('does not trust an undeclared replacement that mimics a built-in handler', () => {
    const registry = registryWithBuiltins();
    let watched = false;
    const lookalike: TriggerPlugin = {
      name: 'manual',
      watch() {
        watched = true;
        throw new Error('lookalike trigger must not execute during preflight');
      },
    };
    registry.registerPlugin('triggers', 'manual', lookalike, { replace: true });

    const report = buildChatPipelineTrialabilityReport({
      pipelineConfig: {
        name: 'Built-in lookalike',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'wait',
                name: 'Wait',
                command: { argv: ['noop'] },
                trigger: { type: 'manual' },
              },
            ],
          },
        ],
      },
      registry,
      capabilityOwners: new Map(),
    });

    expect(report.runnable).toBe(false);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'trigger',
          type: 'manual',
          declaration: null,
          disposition: 'unsupported-in-unattended-trial',
        }),
      ]),
    );
    expect(watched).toBe(false);
  });

  test('downgrades declared real credentials and network to an explicit host-risk warning', () => {
    const registry = registryWithBuiltins();
    const driver: DriverPlugin = {
      name: 'remote-driver',
      capabilities: {
        sessionResume: false,
        systemPrompt: true,
        outputFormat: false,
      },
      trial: {
        protocolVersion: 1,
        interaction: 'credential',
        unattended: 'host-adapter',
        filesystem: 'workspace-write',
        network: 'write',
        secrets: 'real-required',
        runtime: 'bounded',
      },
      async buildCommand() {
        return { args: ['remote-driver'] };
      },
    };
    registry.registerPlugin('drivers', 'remote', driver);
    const pipelineConfig: PipelineConfig = {
      name: 'Remote driver',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'ask', name: 'Ask', prompt: 'Answer.', driver: 'remote' }],
        },
      ],
    };

    const report = buildChatPipelineTrialabilityReport({
      pipelineConfig,
      registry,
      capabilityOwners: new Map([['drivers/remote', '@example/remote-driver']]),
    });

    expect(report.runnable).toBe(true);
    expect(report.items[0]).toMatchObject({ disposition: 'sandbox-ready-with-host-risk' });
    expect(report.blockers).toEqual([]);
    expect(report.warnings.join('\n')).toContain('real credentials');
    expect(report.warnings.join('\n')).toContain('external network writes');
    expect(report.warnings.join('\n')).toContain('with normal host authority');
  });

  test('keeps human interaction and malformed declarations blocked in the Sandbox Trial', () => {
    const registry = registryWithBuiltins();
    const browserDriver: DriverPlugin = {
      name: 'browser-driver',
      capabilities: {
        sessionResume: false,
        systemPrompt: false,
        outputFormat: false,
      },
      trial: {
        protocolVersion: 1,
        interaction: 'browser-auth',
        unattended: 'unsupported',
        filesystem: 'workspace-write',
        network: 'write',
        secrets: 'real-required',
        runtime: 'bounded',
      },
      async buildCommand() {
        return { args: ['browser-driver'] };
      },
    };
    registry.registerPlugin('drivers', 'browser', browserDriver);
    registry.registerPlugin('triggers', 'malformed', {
      name: 'malformed-trigger',
      trial: { protocolVersion: 99 },
      watch() {
        throw new Error('malformed trigger must not execute during preflight');
      },
    } as unknown as TriggerPlugin);
    const pipelineConfig: PipelineConfig = {
      name: 'Human required',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'ask',
              name: 'Ask',
              prompt: 'Answer.',
              driver: 'browser',
              trigger: { type: 'malformed' },
            },
          ],
        },
      ],
    };

    const report = buildChatPipelineTrialabilityReport({
      pipelineConfig,
      registry,
      capabilityOwners: new Map(),
    });

    expect(report.runnable).toBe(false);
    expect(report.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'driver',
          disposition: 'human-required',
        }),
        expect.objectContaining({
          component: 'trigger',
          disposition: 'unsupported-in-unattended-trial',
        }),
      ]),
    );
  });
});
