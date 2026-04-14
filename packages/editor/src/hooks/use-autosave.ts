// ─────────────────────────────────────────────────────────────────────────────
// use-autosave.ts — U4: Draft autosave + crash-recovery for unsaved edits.
// ─────────────────────────────────────────────────────────────────────────────
//
// This hook periodically snapshots the current in-memory pipeline config to
// localStorage while the store is dirty, so a page crash or accidental close
// leaves a recoverable draft behind. On next load, the hook can be queried
// via `loadDraft(yamlPath)` to check whether a more recent draft exists than
// the YAML on disk.
//
// DESIGN NOTES
// ────────────
//
// 1. Storage choice — localStorage instead of a server draft endpoint.
//    Group 5 owns the server-side file watcher. Writing drafts into
//    `<workDir>/.tagma/.draft/<basename>.json` would require adding two new
//    endpoints (`/api/draft/save`, `/api/draft/load`) that would likely
//    collide with the external-change reconciliation path. To avoid a merge
//    conflict we use the browser's localStorage. Trade-off: drafts don't
//    follow the user across machines, but crash recovery on the same machine
//    still works, which is the primary U4 use case.
//
// 2. Key shape — keyed by `yamlPath` so different pipelines have independent
//    drafts. Unsaved/new pipelines (no yamlPath yet) are stored under the
//    sentinel key `:unsaved`.
//
// 3. Activation — this module exports a React hook `useAutosave()` and a
//    plain function `loadDraft()`. The hook is invoked once from App.tsx
//    so the effect subscribes on mount. `loadDraft` is also available for
//    any caller that wants to opportunistically surface drafts on load.
//
// 4. Clearing — drafts are cleared via `clearDraft()`; callers should invoke
//    this on successful save. App.tsx can subscribe to store state changes
//    and call clearDraft when `isDirty` transitions true → false.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { usePipelineStore } from '../store/pipeline-store';
import type { RawPipelineConfig } from '../api/client';

const DRAFT_KEY_PREFIX = 'tagma:draft:';
const DRAFT_SENTINEL_UNSAVED = ':unsaved';
const DEFAULT_INTERVAL_MS = 30_000;

export interface DraftEnvelope {
  readonly yamlPath: string | null;
  readonly config: RawPipelineConfig;
  readonly savedAt: number; // epoch millis
  readonly schemaVersion: 1;
}

function keyFor(yamlPath: string | null): string {
  return `${DRAFT_KEY_PREFIX}${yamlPath ?? DRAFT_SENTINEL_UNSAVED}`;
}

/** Persist the current config as a draft to localStorage. */
export function saveDraft(yamlPath: string | null, config: RawPipelineConfig): void {
  try {
    const envelope: DraftEnvelope = {
      yamlPath,
      config,
      savedAt: Date.now(),
      schemaVersion: 1,
    };
    window.localStorage.setItem(keyFor(yamlPath), JSON.stringify(envelope));
  } catch {
    // localStorage quota exceeded or disabled — silently skip. Autosave is a
    // safety-net, not the primary persistence path.
  }
}

/**
 * Return the most recent draft for the given `yamlPath`, or `null` if none.
 * Callers should compare `envelope.savedAt` against the YAML file mtime
 * (available via `/api/state`) to decide whether to prompt for restoration.
 */
export function loadDraft(yamlPath: string | null): DraftEnvelope | null {
  try {
    const raw = window.localStorage.getItem(keyFor(yamlPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftEnvelope;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the draft — call this on successful save. */
export function clearDraft(yamlPath: string | null): void {
  try {
    window.localStorage.removeItem(keyFor(yamlPath));
  } catch {
    // ignore
  }
}

/** List every draft currently in localStorage. Useful for a recovery panel. */
export function listDrafts(): DraftEnvelope[] {
  try {
    const out: DraftEnvelope[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue;
      try {
        const env = JSON.parse(window.localStorage.getItem(key) ?? '') as DraftEnvelope;
        if (env && env.schemaVersion === 1) out.push(env);
      } catch {
        // ignore malformed entries
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * React hook: while the pipeline store is dirty, periodically snapshot the
 * config to localStorage. Clears the draft on clean transitions (dirty →
 * clean, e.g. after a successful save).
 *
 * Safe to call zero or one times; calling more than once creates redundant
 * intervals but nothing breaks.
 */
export function useAutosave(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDirtyRef = useRef<boolean>(false);

  useEffect(() => {
    // Interval tick — read latest store state without subscribing so we
    // don't re-render on every keystroke.
    const tick = () => {
      const state = usePipelineStore.getState();
      if (state.isDirty) {
        saveDraft(state.yamlPath, state.config);
      }
    };

    // Start interval
    timerRef.current = setInterval(tick, intervalMs);

    // Subscribe to dirty transitions so we can clear the draft on save.
    const unsubscribe = usePipelineStore.subscribe((state) => {
      const prev = lastDirtyRef.current;
      const now = state.isDirty;
      lastDirtyRef.current = now;
      if (prev && !now) {
        clearDraft(state.yamlPath);
      }
    });

    // Persist on page hide so we don't lose the last 0–30s of edits.
    const onBeforeUnload = () => tick();
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [intervalMs]);
}
