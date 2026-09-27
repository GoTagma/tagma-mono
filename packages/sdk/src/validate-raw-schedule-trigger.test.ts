import { describe, expect, test } from 'bun:test';
import { validateRaw } from './validate-raw';
import type { RawPipelineConfig, TriggerConfig } from '@tagma/types';

function pipelineWith(
  trigger: TriggerConfig,
  taskExtra: Record<string, unknown> = {},
): RawPipelineConfig {
  return {
    name: 'sched',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'scrape',
            name: 'Scrape',
            command: 'echo ok',
            trigger,
            ...taskExtra,
          },
        ],
      },
    ],
  };
}

function scheduleWarnings(config: RawPipelineConfig): string[] {
  return validateRaw(config, { triggers: [] })
    .map((d) => d.message)
    .filter((m) => m.includes('schedule'));
}

describe('validateRaw schedule trigger', () => {
  test('accepts a valid cron with an explicit task timeout', () => {
    const warnings = scheduleWarnings(
      pipelineWith({ type: 'schedule', cron: '0 8 * * 1-5' }, { timeout: '4d' }),
    );
    expect(warnings).toEqual([]);
  });

  test('does not warn that the built-in schedule type is unregistered', () => {
    const diagnostics = validateRaw(
      pipelineWith({ type: 'schedule', cron: '0 8 * * 1-5' }, { timeout: '4d' }),
      { triggers: [] },
    );
    expect(diagnostics.map((d) => d.message).join('\n')).not.toMatch(/not registered/);
  });

  test('warns on invalid cron syntax', () => {
    const diagnostics = validateRaw(
      pipelineWith({ type: 'schedule', cron: '0 8 * *' }, { timeout: '4d' }),
      { triggers: [] },
    );
    const cronWarning = diagnostics.find((d) => d.path === 'tracks[0].tasks[0].trigger.cron');
    expect(cronWarning?.message).toContain('schedule trigger cron is invalid');
    expect(cronWarning?.message).toContain('5 fields');
    expect(cronWarning?.severity).toBe('warning');
  });

  test('warns on a cron that never fires', () => {
    const warnings = scheduleWarnings(
      pipelineWith({ type: 'schedule', cron: '0 0 31 2 *' }, { timeout: '4d' }),
    );
    expect(warnings.join('\n')).toMatch(/no fire time within 5 years/);
  });

  test('warns when the task has no explicit timeout', () => {
    const warnings = scheduleWarnings(pipelineWith({ type: 'schedule', cron: '0 8 * * 1-5' }));
    expect(warnings.join('\n')).toMatch(/count against the task timeout/);
  });

  test('ignores a non-string cron value (left to schema validation)', () => {
    const diagnostics = validateRaw(pipelineWith({ type: 'schedule', cron: 42 }), {
      triggers: [],
    });
    expect(diagnostics.filter((d) => d.path === 'tracks[0].tasks[0].trigger.cron')).toEqual([]);
  });
});
