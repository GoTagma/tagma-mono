import { describe, expect, test } from 'bun:test';
import { usePipelineStore } from '../src/store/pipeline-store';
import { createRunSaveController } from '../src/utils/run-save-flow';

function configureStore(options: {
  readonly yamlPath: string | null;
  readonly isDirty: boolean;
  readonly saved: boolean;
  readonly savedPath?: string;
}) {
  let saveCalls = 0;
  usePipelineStore.setState({
    yamlPath: options.yamlPath,
    isDirty: options.isDirty,
    saveFile: async () => {
      saveCalls++;
      if (!options.saved) return false;
      usePipelineStore.setState({
        yamlPath: options.savedPath ?? options.yamlPath ?? '/tmp/new-pipeline.yaml',
        isDirty: false,
      });
      return true;
    },
  });
  return () => saveCalls;
}

function requestRun(
  controller: ReturnType<typeof createRunSaveController>,
  run: () => void,
): Promise<boolean> {
  const state = usePipelineStore.getState();
  return controller.request({
    needsSave: !state.yamlPath || state.isDirty,
    save: () => usePipelineStore.getState().saveFile(),
    run,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Run save failure flow', () => {
  test('runs once after an existing dirty YAML saves successfully', async () => {
    const saveCalls = configureStore({
      yamlPath: '/tmp/existing.yaml',
      isDirty: true,
      saved: true,
    });
    const controller = createRunSaveController();
    let runs = 0;

    expect(await requestRun(controller, () => runs++)).toBe(true);
    expect(saveCalls()).toBe(1);
    expect(runs).toBe(1);
    expect(usePipelineStore.getState().isDirty).toBe(false);
  });

  test('does not run or retry when an existing dirty YAML save fails', async () => {
    const saveCalls = configureStore({
      yamlPath: '/tmp/existing.yaml',
      isDirty: true,
      saved: false,
    });
    const controller = createRunSaveController();
    let runs = 0;

    expect(await requestRun(controller, () => runs++)).toBe(false);
    usePipelineStore.setState({ isDirty: false, yamlPath: '/tmp/later.yaml' });

    expect(saveCalls()).toBe(1);
    expect(runs).toBe(0);
  });

  test('runs once after a new unsaved pipeline obtains a path and saves', async () => {
    const saveCalls = configureStore({
      yamlPath: null,
      isDirty: true,
      saved: true,
      savedPath: '/tmp/.tagma/new/new.yaml',
    });
    const controller = createRunSaveController();
    let runs = 0;

    expect(await requestRun(controller, () => runs++)).toBe(true);
    expect(saveCalls()).toBe(1);
    expect(runs).toBe(1);
    expect(usePipelineStore.getState().yamlPath).toBe('/tmp/.tagma/new/new.yaml');
  });

  test('Save As failure does not leave a Run intent behind', async () => {
    const saveCalls = configureStore({
      yamlPath: '/tmp/existing.yaml',
      isDirty: true,
      saved: false,
    });
    const controller = createRunSaveController();
    let runs = 0;

    expect(await requestRun(controller, () => runs++)).toBe(false);
    usePipelineStore.setState({ yamlPath: '/tmp/save-as.yaml', isDirty: false });

    expect(saveCalls()).toBe(1);
    expect(runs).toBe(0);
  });

  test('Save As cancellation invalidates an in-flight save before it can run', async () => {
    const pending = deferred<boolean>();
    let saveCalls = 0;
    usePipelineStore.setState({
      yamlPath: '/tmp/existing.yaml',
      isDirty: true,
      saveFile: async () => {
        saveCalls++;
        return pending.promise;
      },
    });
    const controller = createRunSaveController();
    let runs = 0;
    const runPromise = requestRun(controller, () => runs++);

    controller.cancel();
    pending.resolve(true);

    expect(await runPromise).toBe(false);
    expect(saveCalls).toBe(1);
    expect(runs).toBe(0);
  });

  test('coalesces concurrent save-before-run requests into one save and one start', async () => {
    const pending = deferred<boolean>();
    let saveCalls = 0;
    usePipelineStore.setState({
      yamlPath: '/tmp/existing.yaml',
      isDirty: true,
      saveFile: async () => {
        saveCalls++;
        const saved = await pending.promise;
        if (saved) usePipelineStore.setState({ isDirty: false });
        return saved;
      },
    });
    const controller = createRunSaveController();
    let runs = 0;
    const first = requestRun(controller, () => runs++);
    const second = requestRun(controller, () => runs++);

    pending.resolve(true);
    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(saveCalls).toBe(1);
    expect(runs).toBe(1);
  });
});
