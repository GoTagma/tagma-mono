export interface RunSaveRequest {
  readonly needsSave: boolean;
  readonly save: () => Promise<boolean>;
  readonly run: () => void;
}

export interface RunSaveController {
  readonly request: (request: RunSaveRequest) => Promise<boolean>;
  readonly cancel: () => void;
}

/**
 * Coalesces concurrent save-before-run requests and invalidates the run intent
 * when the save fails or the caller cancels it. A completed save can therefore
 * never resurrect an old Run action after a later editor state change.
 */
export function createRunSaveController(): RunSaveController {
  let generation = 0;
  let inFlightSave: Promise<boolean> | null = null;

  const request = async ({ needsSave, save, run }: RunSaveRequest): Promise<boolean> => {
    const requestGeneration = ++generation;
    if (!needsSave) {
      if (requestGeneration !== generation) return false;
      run();
      return true;
    }

    const savePromise =
      inFlightSave ??
      (() => {
        const next = Promise.resolve()
          .then(save)
          .then((saved) => saved === true)
          .catch(() => false);
        inFlightSave = next;
        void next.then(() => {
          if (inFlightSave === next) inFlightSave = null;
        });
        return next;
      })();

    const saved = await savePromise;
    if (!saved || requestGeneration !== generation) return false;
    run();
    return true;
  };

  return {
    request,
    cancel: () => {
      generation++;
    },
  };
}
