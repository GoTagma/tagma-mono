import { create } from 'zustand';
import { api, type EditorSettings } from '../api/client';

/**
 * Shared cache of the per-workspace `editor-settings.json`. Two surfaces need
 * these values:
 *
 *   1. `EditorSettingsPanel` (reads on open, writes on toggle change).
 *   2. `App.tsx`'s chat-driven conflict resolver, which picks between silent
 *      adopt / preserve-canvas / prompt per the `chatDirtyConflictPolicy`
 *      field on every `external-conflict` SSE event. That handler runs
 *      outside the panel lifecycle, so it needs a persistent in-memory copy
 *      to avoid round-tripping `/api/editor-settings` on every event.
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
