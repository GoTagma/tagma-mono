import { describe, expect, test } from 'bun:test';
import { autosaveTickOnce, type AutosaveDeps } from '../src/hooks/use-disk-autosave';

interface FakePipeline {
  isDirty: boolean;
  yamlPath: string | null;
  saveFile: () => Promise<boolean>;
}

interface MakeOpts {
  isDirty?: boolean;
  yamlPath?: string | null;
  yamlEditLocked?: boolean;
  runActive?: boolean;
  runStatus?: 'idle' | 'starting' | 'running' | 'success' | 'failed' | 'error' | 'aborted';
  saveResult?: boolean;
  savingRef?: { current: boolean };
  lastEditAt?: number | null;
  lastLocalEditAt?: number | null;
  now?: number;
  quietMs?: number;
}

function makeDeps(opts: MakeOpts = {}): {
  deps: AutosaveDeps;
  saveCalls: { count: number };
} {
  const saveCalls = { count: 0 };
  const pipeline: FakePipeline = {
    isDirty: opts.isDirty ?? true,
    yamlPath: opts.yamlPath === undefined ? '/tmp/p.yaml' : opts.yamlPath,
    saveFile: async () => {
      saveCalls.count += 1;
      return opts.saveResult ?? true;
    },
  };
  const deps: AutosaveDeps = {
    pipelineGet: () => pipeline,
    isYamlEditLocked: () => opts.yamlEditLocked ?? false,
    runGet: () => ({ active: opts.runActive ?? false, status: opts.runStatus ?? 'idle' }),
    savingRef: opts.savingRef ?? { current: false },
    lastEditAtRef: { current: opts.lastEditAt ?? null },
    getLastLocalEditAt: () => opts.lastLocalEditAt ?? null,
    now: () => opts.now ?? 1_000_000,
    quietMs: opts.quietMs ?? 2000,
  };
  return { deps, saveCalls };
}

describe('autosaveTickOnce guards', () => {
  test('skip when savingRef is true', async () => {
    const { deps, saveCalls } = makeDeps({ savingRef: { current: true } });
    expect(await autosaveTickOnce(deps)).toBe('skip-saving');
    expect(saveCalls.count).toBe(0);
  });

  test('skip when not dirty', async () => {
    const { deps, saveCalls } = makeDeps({ isDirty: false });
    expect(await autosaveTickOnce(deps)).toBe('skip-clean');
    expect(saveCalls.count).toBe(0);
  });

  test('skip when no yamlPath', async () => {
    const { deps, saveCalls } = makeDeps({ yamlPath: null });
    expect(await autosaveTickOnce(deps)).toBe('skip-no-path');
    expect(saveCalls.count).toBe(0);
  });

  test('skip when run is active', async () => {
    const { deps, saveCalls } = makeDeps({ runActive: true });
    expect(await autosaveTickOnce(deps)).toBe('skip-running');
    expect(saveCalls.count).toBe(0);
  });

  test('skip when a minimized run is still live', async () => {
    const { deps, saveCalls } = makeDeps({ runActive: false, runStatus: 'running' });
    expect(await autosaveTickOnce(deps)).toBe('skip-running');
    expect(saveCalls.count).toBe(0);
  });

  test('skip silently while YAML edit lock is active', async () => {
    const { deps, saveCalls } = makeDeps({ yamlEditLocked: true });
    expect(await autosaveTickOnce(deps)).toBe('skip-yaml-locked');
    expect(saveCalls.count).toBe(0);
  });

  test('skip during quiet period (just inside)', async () => {
    // gap = 1999 ms, quietMs = 2000 → inside the quiet window → skip
    const { deps, saveCalls } = makeDeps({ lastEditAt: 998_001, now: 1_000_000, quietMs: 2000 });
    expect(await autosaveTickOnce(deps)).toBe('skip-typing');
    expect(saveCalls.count).toBe(0);
  });

  test('skip during quiet period after a local field edit before debounce commits', async () => {
    const { deps, saveCalls } = makeDeps({
      lastEditAt: null,
      lastLocalEditAt: 999_000,
      now: 1_000_000,
      quietMs: 2000,
    });
    expect(await autosaveTickOnce(deps)).toBe('skip-typing');
    expect(saveCalls.count).toBe(0);
  });

  test('saves once quiet period elapses (just outside)', async () => {
    // gap = 2001 ms, quietMs = 2000 → outside → save proceeds
    const { deps, saveCalls } = makeDeps({ lastEditAt: 997_999, now: 1_000_000, quietMs: 2000 });
    expect(await autosaveTickOnce(deps)).toBe('saved');
    expect(saveCalls.count).toBe(1);
  });

  test('saves when guards pass', async () => {
    const { deps, saveCalls } = makeDeps({ now: 1_000_000 });
    expect(await autosaveTickOnce(deps)).toBe('saved');
    expect(saveCalls.count).toBe(1);
  });

  test('returns failed without stamping when saveFile returns false', async () => {
    const { deps, saveCalls } = makeDeps({
      now: 1_000_000,
      saveResult: false,
    });
    expect(await autosaveTickOnce(deps)).toBe('failed');
    expect(saveCalls.count).toBe(1);
  });

  test('releases savingRef even when saveFile throws', async () => {
    const savingRef = { current: false };
    const deps: AutosaveDeps = {
      pipelineGet: () => ({
        isDirty: true,
        yamlPath: '/x',
        saveFile: async () => {
          throw new Error('boom');
        },
      }),
      runGet: () => ({ active: false }),
      savingRef,
      lastEditAtRef: { current: null },
      now: () => 1,
      quietMs: 2000,
    };
    let caught: unknown;
    try {
      await autosaveTickOnce(deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(savingRef.current).toBe(false);
  });
});
