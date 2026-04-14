import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Local-state driven input field that commits changes to the server.
 *
 * Commit strategy: **debounced** (U16).
 * ----------------------------------------
 * Previous behaviour committed on blur, which created a race with Ctrl+S:
 * if the browser dispatched `save` before `blur`, the user's latest keystroke
 * was lost. We now debounce commits ~250ms after each keystroke so by the
 * time the user hits Ctrl+S there is (almost) never anything pending. The
 * returned `onBlur` still flushes synchronously as a belt-and-braces safety
 * net, and on unmount any pending debounced commit is flushed too.
 *
 * Server overwrite guard (C8).
 * ----------------------------------------
 * When `serverValue` changes externally (imports, another tab, applyState):
 *   - If the local value still matches the previously-seen committed value,
 *     the new serverValue is adopted silently.
 *   - If the user has uncommitted local edits that differ from committed,
 *     we do NOT silently overwrite. Instead we keep the local edits and set
 *     `serverChanged = true`. The component can then display a conflict
 *     banner and call:
 *       - `discardLocal()`  — adopt the incoming serverValue
 *       - `acceptLocal()`   — commit the local edits (wins over server)
 *
 * Backward compatible API
 * ----------------------------------------
 * Existing call sites destructure `const [value, onChange, onBlur] = ...`.
 * The extra conflict-resolution fields are attached to the tuple so
 * consumers that want them can do:
 *   const field = useLocalField(...);
 *   field[0]; // value
 *   field.serverChanged;
 *   field.discardLocal();
 * without breaking three-element destructuring at existing call sites.
 */

const COMMIT_DEBOUNCE_MS = 250;

// C3: Global registry of active local-field flush functions. When saveFile()
// is triggered (Ctrl+S), it calls flushAllLocalFields() to ensure every
// pending debounced commit is applied before the YAML is written to disk.
const activeFlushFns = new Set<() => void>();

/**
 * Synchronously flush all pending debounced local-field commits so the
 * server state includes the user's latest keystrokes before a save.
 */
export function flushAllLocalFields(): void {
  for (const flush of activeFlushFns) {
    flush();
  }
}

export interface LocalFieldExtras {
  /** True when serverValue changed while the user had uncommitted edits. */
  serverChanged: boolean;
  /** Adopt the incoming server value, discarding local edits. */
  discardLocal: () => void;
  /** Commit the current local value immediately (wins over server). */
  acceptLocal: () => void;
}

export type UseLocalFieldResult = [
  string,
  (value: string) => void,
  () => void,
] & LocalFieldExtras;

export function useLocalField(
  serverValue: string,
  onCommit: (value: string) => void,
): UseLocalFieldResult {
  const [local, setLocal] = useState(serverValue);
  const [serverChanged, setServerChanged] = useState(false);

  // `committedRef` tracks the last value we are in sync with the server on.
  // `pendingServerRef` holds an incoming serverValue that we declined to
  // silently adopt because of uncommitted local edits (C8).
  const committedRef = useRef(serverValue);
  const pendingServerRef = useRef<string | null>(null);
  const localRef = useRef(local);
  localRef.current = local;

  // Hold latest onCommit in a ref so debounce/blur/unmount handlers always
  // see the current closure without requiring callers to memoise it.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDebounce = useCallback(() => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, []);

  const flushCommit = useCallback(() => {
    clearDebounce();
    if (localRef.current !== committedRef.current) {
      committedRef.current = localRef.current;
      commitRef.current(localRef.current);
    }
  }, [clearDebounce]);

  // Sync from server when value changes externally (import, switch task, etc.)
  useEffect(() => {
    if (serverValue === committedRef.current) {
      // Nothing to do — we are already in sync.
      return;
    }

    const hasLocalEdits = localRef.current !== committedRef.current;
    if (!hasLocalEdits) {
      // User hasn't typed anything uncommitted; adopt silently.
      setLocal(serverValue);
      committedRef.current = serverValue;
      pendingServerRef.current = null;
      setServerChanged(false);
    } else {
      // Conflict: preserve local edits, surface flag for UI.
      pendingServerRef.current = serverValue;
      setServerChanged(true);
    }
  }, [serverValue]);

  const onChange = useCallback((value: string) => {
    setLocal(value);
    localRef.current = value;
    // Debounced commit — cancels any in-flight timer.
    clearDebounce();
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      if (localRef.current !== committedRef.current) {
        const val = localRef.current;
        committedRef.current = val;
        try { commitRef.current(val); } catch { /* commit errors surfaced by API layer */ }
      }
    }, COMMIT_DEBOUNCE_MS);
  }, [clearDebounce]);

  // onBlur still flushes synchronously for safety (e.g. the user tabs out
  // and we don't want to wait 250ms to persist).
  const onBlur = useCallback(() => {
    flushCommit();
  }, [flushCommit]);

  const discardLocal = useCallback(() => {
    clearDebounce();
    const next = pendingServerRef.current ?? committedRef.current;
    setLocal(next);
    localRef.current = next;
    committedRef.current = next;
    pendingServerRef.current = null;
    setServerChanged(false);
  }, [clearDebounce]);

  const acceptLocal = useCallback(() => {
    flushCommit();
    pendingServerRef.current = null;
    setServerChanged(false);
  }, [flushCommit]);

  // C3: Register this field's flush function globally so flushAllLocalFields()
  // can drain all pending debounced edits before a save.
  useEffect(() => {
    activeFlushFns.add(flushCommit);
    return () => {
      activeFlushFns.delete(flushCommit);
      // Flush on unmount so we don't lose a pending debounced edit.
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (localRef.current !== committedRef.current) {
        commitRef.current(localRef.current);
      }
    };
  }, [flushCommit]);

  // Build a tuple that *also* carries the extras as named properties. Existing
  // callers `const [v, set, blur] = useLocalField(...)` keep working; new
  // callers can read `result.serverChanged` etc.
  const result = [local, onChange, onBlur] as unknown as UseLocalFieldResult;
  result.serverChanged = serverChanged;
  result.discardLocal = discardLocal;
  result.acceptLocal = acceptLocal;
  return result;
}
