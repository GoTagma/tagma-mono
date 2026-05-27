import { describe, expect, test } from 'bun:test';
import { resolveDependencyLocateTarget } from '../src/utils/dependency-locate';
import type { RawPipelineConfig, RawTaskConfig } from '../src/api/client';

function task(id: string, overrides: Partial<RawTaskConfig> = {}): RawTaskConfig {
  return { id, prompt: 'x', ...overrides };
}

function pipe(tracks: { id: string; tasks: RawTaskConfig[] }[]): RawPipelineConfig {
  return {
    name: 'p',
    tracks: tracks.map((t) => ({ id: t.id, name: t.id, tasks: t.tasks })),
  };
}

describe('resolveDependencyLocateTarget', () => {
  test('prefers same-track shorthand dependencies', () => {
    const config = pipe([
      { id: 'main', tasks: [task('setup'), task('run', { depends_on: ['setup'] })] },
      { id: 'other', tasks: [task('setup')] },
    ]);

    expect(resolveDependencyLocateTarget(config, 'main', 'setup')).toBe('main.setup');
  });

  test('resolves globally unique bare dependencies across tracks', () => {
    const config = pipe([
      { id: 'main', tasks: [task('run', { depends_on: ['setup'] })] },
      { id: 'other', tasks: [task('setup')] },
    ]);

    expect(resolveDependencyLocateTarget(config, 'main', 'setup')).toBe('other.setup');
  });

  test('resolves qualified dependencies exactly', () => {
    const config = pipe([
      { id: 'main', tasks: [task('run', { depends_on: ['other.setup'] })] },
      { id: 'other', tasks: [task('setup')] },
    ]);

    expect(resolveDependencyLocateTarget(config, 'main', 'other.setup')).toBe('other.setup');
  });

  test('does not locate unresolved or ambiguous dependencies', () => {
    const config = pipe([
      { id: 'main', tasks: [task('run', { depends_on: ['setup', 'missing'] })] },
      { id: 'a', tasks: [task('setup')] },
      { id: 'b', tasks: [task('setup')] },
    ]);

    expect(resolveDependencyLocateTarget(config, 'main', 'setup')).toBeNull();
    expect(resolveDependencyLocateTarget(config, 'main', 'missing')).toBeNull();
  });
});
