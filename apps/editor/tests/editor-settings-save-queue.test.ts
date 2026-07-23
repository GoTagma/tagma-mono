import { describe, expect, test } from 'bun:test';
import { createEditorSettingsSaveQueue } from '../src/components/panels/editor-settings-save-queue';

interface TestSettings {
  count: number;
  enabled: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Editor Settings save queue', () => {
  test('keeps edits responsive and coalesces changes made while a save is running', async () => {
    const firstSave = deferred<TestSettings>();
    const patches: Partial<TestSettings>[] = [];
    const rendered: TestSettings[] = [];
    const savingStates: boolean[] = [];

    const queue = createEditorSettingsSaveQueue<TestSettings>({
      persist: async (patch) => {
        patches.push(patch);
        if (patches.length === 1) return firstSave.promise;
        return { count: patch.count ?? 1, enabled: patch.enabled ?? false };
      },
      onValue: (value) => rendered.push(value),
      onSavingChange: (saving) => savingStates.push(saving),
      onError: () => {},
    });

    queue.reset({ count: 0, enabled: false });
    queue.update('count', 1);
    queue.update('count', 2);
    queue.update('enabled', true);

    expect(rendered.at(-1)).toEqual({ count: 2, enabled: true });
    expect(patches).toEqual([{ count: 1 }]);
    expect(savingStates).toEqual([true]);

    firstSave.resolve({ count: 1, enabled: false });
    await queue.whenIdle();

    expect(patches).toEqual([{ count: 1 }, { count: 2, enabled: true }]);
    expect(rendered.at(-1)).toEqual({ count: 2, enabled: true });
    expect(savingStates).toEqual([true, false]);
  });

  test('rolls back only failed values while preserving and saving newer edits', async () => {
    const firstSave = deferred<TestSettings>();
    const patches: Partial<TestSettings>[] = [];
    const rendered: TestSettings[] = [];
    const errors: unknown[] = [];

    const queue = createEditorSettingsSaveQueue<TestSettings>({
      persist: async (patch) => {
        patches.push(patch);
        if (patches.length === 1) return firstSave.promise;
        return { count: patch.count ?? 0, enabled: patch.enabled ?? false };
      },
      onValue: (value) => rendered.push(value),
      onSavingChange: () => {},
      onError: (error) => errors.push(error),
    });

    queue.reset({ count: 0, enabled: false });
    queue.update('count', 1);
    queue.update('count', 2);
    queue.update('enabled', true);
    firstSave.reject(new Error('disk busy'));

    await queue.whenIdle();

    expect(patches).toEqual([{ count: 1 }, { count: 2, enabled: true }]);
    expect(rendered.at(-1)).toEqual({ count: 2, enabled: true });
    expect(errors).toHaveLength(1);
  });

  test('restores a failed value when no newer edit supersedes it', async () => {
    const rendered: TestSettings[] = [];

    const queue = createEditorSettingsSaveQueue<TestSettings>({
      persist: async () => {
        throw new Error('read-only workspace');
      },
      onValue: (value) => rendered.push(value),
      onSavingChange: () => {},
      onError: () => {},
    });

    queue.reset({ count: 0, enabled: false });
    queue.update('count', 1);
    await queue.whenIdle();

    expect(rendered.at(-1)).toEqual({ count: 0, enabled: false });
  });
});
