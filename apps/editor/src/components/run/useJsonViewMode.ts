/**
 * Shared, persisted preference for how JSON-shaped task output is shown in
 * the run panel: `formatted` (pretty + highlighted) or `raw` (original
 * bytes). One global preference — every `JsonOutputView` instance reads and
 * writes the same `localStorage` key and stays in sync, including across
 * sibling instances in the same document (the native `storage` event only
 * fires in *other* documents, so we add an in-tab event too).
 *
 * SSR/test-safe: the initial read guards `localStorage`, and listeners are
 * only attached inside `useEffect` (never runs under `renderToStaticMarkup`).
 */
import { useCallback, useEffect, useState } from 'react';

export type JsonViewMode = 'formatted' | 'raw';

export const JSON_VIEW_MODE_KEY = 'tagma.panel.jsonView';

/** In-document sync event — fired alongside the localStorage write. */
const JSON_VIEW_MODE_EVENT = 'tagma:jsonViewMode';

/** Default to `formatted`; anything that isn't an explicit `raw` is treated as formatted. */
export function normalizeJsonViewMode(raw: string | null | undefined): JsonViewMode {
  return raw === 'raw' ? 'raw' : 'formatted';
}

function readMode(): JsonViewMode {
  try {
    if (typeof localStorage === 'undefined') return 'formatted';
    return normalizeJsonViewMode(localStorage.getItem(JSON_VIEW_MODE_KEY));
  } catch {
    return 'formatted';
  }
}

export function useJsonViewMode(): [JsonViewMode, (mode: JsonViewMode) => void] {
  const [mode, setModeState] = useState<JsonViewMode>(readMode);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== JSON_VIEW_MODE_KEY) return;
      setModeState(normalizeJsonViewMode(e.newValue));
    };
    const onLocal = () => setModeState(readMode());
    window.addEventListener('storage', onStorage);
    window.addEventListener(JSON_VIEW_MODE_EVENT, onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(JSON_VIEW_MODE_EVENT, onLocal);
    };
  }, []);

  const setMode = useCallback((next: JsonViewMode) => {
    setModeState(next);
    try {
      localStorage.setItem(JSON_VIEW_MODE_KEY, next);
      window.dispatchEvent(new Event(JSON_VIEW_MODE_EVENT));
    } catch {
      /* storage unavailable (private mode / quota) — in-memory state still updates */
    }
  }, []);

  return [mode, setMode];
}
