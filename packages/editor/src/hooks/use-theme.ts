import { useCallback, useSyncExternalStore } from 'react';

/**
 * Theme preference: 'dark' is the product default, 'light' is opt-in.
 * Persisted globally (not per-workspace) in localStorage so the choice
 * survives workspace switches and restarts.
 *
 * The palette itself lives in index.css as CSS variables; flipping this
 * value just toggles the `.light` class on <html>, which swaps the
 * variable block Tailwind's tagma-* colors resolve against.
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'tagma.editor.theme';
const DEFAULT_THEME: Theme = 'dark';

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' ? 'light' : 'dark';
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('light', theme === 'light');
}

/**
 * Call once from main.tsx before React renders so the theme class is on
 * <html> before first paint — otherwise light-mode users see a dark flash.
 */
export function initThemeEarly(): void {
  applyTheme(readStoredTheme());
}

// Module-local pub/sub so useSyncExternalStore can rerender every consumer
// when any caller flips the theme. A CustomEvent on window would also work
// but this keeps the contract contained to this module.
const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Theme {
  return readStoredTheme();
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage quota or private mode — apply in-memory anyway */
  }
  applyTheme(theme);
  for (const cb of listeners) cb();
}

export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_THEME);
  const set = useCallback((next: Theme) => setTheme(next), []);
  return { theme, setTheme: set };
}
