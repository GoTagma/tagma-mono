export interface EditorSettingsSaveQueueOptions<T extends object> {
  persist: (patch: Partial<T>) => Promise<T>;
  onValue: (value: T) => void;
  onSavingChange: (saving: boolean) => void;
  onError: (error: unknown) => void;
}

export interface EditorSettingsSaveQueue<T extends object> {
  reset: (value: T) => void;
  update: <K extends keyof T>(key: K, value: T[K]) => boolean;
  whenIdle: () => Promise<void>;
}

function hasKeys<T extends object>(value: Partial<T>): boolean {
  return Object.keys(value).length > 0;
}

/**
 * Serializes settings writes without blocking the controls that produced them.
 *
 * Changes are reflected through `onValue` immediately. While one request is in
 * flight, later edits are coalesced into the next patch. A failed request rolls
 * back only fields that the user has not edited again since that request began.
 */
export function createEditorSettingsSaveQueue<T extends object>(
  options: EditorSettingsSaveQueueOptions<T>,
): EditorSettingsSaveQueue<T> {
  let committed: T | null = null;
  let current: T | null = null;
  let pending: Partial<T> = {};
  let drainPromise: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    options.onSavingChange(true);
    try {
      while (committed && current && hasKeys(pending)) {
        const patch = pending;
        pending = {};
        const previousCommitted = committed;

        try {
          const saved = await options.persist(patch);
          committed = saved;
          current = { ...saved, ...pending };
          options.onValue(current);
        } catch (error) {
          const rolledBack = { ...current };
          for (const key of Object.keys(patch) as Array<keyof T>) {
            if (!Object.prototype.hasOwnProperty.call(pending, key)) {
              rolledBack[key] = previousCommitted[key];
            }
          }
          current = rolledBack;
          options.onValue(current);
          options.onError(error);
        }
      }
    } finally {
      options.onSavingChange(false);
    }
  };

  const startDrain = (): void => {
    if (drainPromise) return;
    drainPromise = drain().finally(() => {
      drainPromise = null;
      if (hasKeys(pending)) startDrain();
    });
  };

  return {
    reset(value) {
      if (drainPromise) {
        throw new Error('Cannot reset Editor Settings while a save is in progress');
      }
      committed = value;
      current = value;
      pending = {};
      options.onValue(value);
    },

    update(key, value) {
      if (!current) return false;
      current = { ...current, [key]: value };
      pending = { ...pending, [key]: value };
      options.onValue(current);
      startDrain();
      return true;
    },

    whenIdle() {
      return drainPromise ?? Promise.resolve();
    },
  };
}
