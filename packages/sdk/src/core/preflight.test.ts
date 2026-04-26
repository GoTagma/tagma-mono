import { describe, expect, test } from 'bun:test';
import { preflight } from './preflight';
import { buildDag } from '../dag';
import { PluginRegistry } from '../registry';
import { bootstrapBuiltins } from '../bootstrap';
import type { PipelineConfig } from '../types';

function emptyConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    name: 'p',
    tracks: [{ id: 't', name: 'T', tasks: [] }],
    ...overrides,
  };
}

describe('preflight', () => {
  test('throws when a referenced driver is not registered', () => {
    const reg = new PluginRegistry();
    const cfg = emptyConfig({
      tracks: [
        { id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', prompt: 'hi' }] },
      ],
    });
    expect(() => preflight(cfg, buildDag(cfg), reg)).toThrow(
      /driver "opencode" not registered/,
    );
  });

  test('passes when all referenced plugins are registered', () => {
    const reg = new PluginRegistry();
    bootstrapBuiltins(reg);
    const cfg = emptyConfig({
      tracks: [
        { id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', prompt: 'hi' }] },
      ],
    });
    expect(() => preflight(cfg, buildDag(cfg), reg)).not.toThrow();
  });

  test('skips driver check for command-only tasks', () => {
    const reg = new PluginRegistry(); // no drivers registered
    const cfg = emptyConfig({
      tracks: [
        { id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', command: 'echo hi' }] },
      ],
    });
    expect(() => preflight(cfg, buildDag(cfg), reg)).not.toThrow();
  });
});
