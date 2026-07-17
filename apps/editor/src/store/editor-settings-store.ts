import { create } from 'zustand';
import { api, type EditorSettings } from '../api/client';

/**
 * Shared cache of the per-workspace `editor-settings.json`. Two surfaces need
 * these values:
 *
 *   1. `EditorSettingsPanel` (reads on open, writes on toggle change).
 *   2. `App.tsx`'s chat reconciliation, which uses the conflict policy and the
 *      optional pipeline trial-run preference outside the panel lifecycle.
 *      Keeping a persistent in-memory copy avoids round-tripping
 *      `/api/editor-settings` while a finished turn is being reconciled.
 *
 * The store is intentionally thin — `load()` re-fetches on workspace bind,
 * and `updateLocal()` lets callers (the panel's optimistic save) push the
 * server's response back in without a follow-up GET. Cleared to `null` when
 * no workspace is bound; consumers fall back to server defaults in that case.
 */
interface EditorSettingsStore {
  /** `null` means "not yet fetched for the current workspace". */
  settings: EditorSettings | null;
  /** Fetch from the server. Safe to call repeatedly; silently swallows errors
   *  so a transient failure doesn't blow up unrelated UI. */
  load: () => Promise<EditorSettings | null>;
  /** Overwrite the cache with `next` without hitting the wire. Used by the
   *  panel after a successful PATCH so App.tsx's handler sees the new value
   *  before the next `load()`. */
  updateLocal: (next: EditorSettings | null) => void;
}

export const useEditorSettingsStore = create<EditorSettingsStore>((set) => ({
  settings: null,
  async load() {
    try {
      const s = await api.getEditorSettings();
      set({ settings: s });
      return s;
    } catch {
      return null;
    }
  },
  updateLocal(next) {
    set({ settings: next });
  },
}));
