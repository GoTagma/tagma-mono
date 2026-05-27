// ─────────────────────────────────────────────────────────────────────────────
// use-disk-autosave.ts — periodic save-to-YAML for the editor.
// ─────────────────────────────────────────────────────────────────────────────
//
// Sits next to use-autosave.ts (which writes a localStorage draft for crash
// recovery). This hook writes the actual YAML file on a configurable interval
// by calling pipelineStore.saveFile() — the same path Ctrl+S uses.
//
// Guards (in tick order):
//   1. savingRef is true            → previous tick still in flight.
//   2. !isDirty                     → nothing to save.
//   3. !yamlPath                    → brand-new pipeline; saveFile would 400.
//   4. runStore.active              → engine is reading the YAML; don't write.
//   5. now - lastEditAt < quietMs   → user is mid-typing; skip this tick.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { usePipelineStore } from '../store/pipeline-store';
import { useRunStore } from '../store/run-store';
import { useEditorSettingsStore } from '../store/editor-settings-store';
import { isYamlEditLocked } from '../store/yaml-edit-lock-store';
import { getLastLocalFieldEditAt } from './use-local-field';

const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const QUIET_MS = 2000;

export interface AutosaveDeps {
  pipelineGet: () => {
    isDirty: boolean;
    yamlPath: string | null;
    saveFile: () => Promise<boolean>;
  };
  isYamlEditLocked?: () => boolean;
  runGet: () => { active: boolean; status?: string };
  savingRef: { current: boolean };
  lastEditAtRef: { current: number | null };
  getLastLocalEditAt?: () => number | null;
  now: () => number;
  quietMs: number;
}

export type AutosaveTickResult =
  | 'skip-saving'
  | 'skip-clean'
  | 'skip-no-path'
  | 'skip-running'
  | 'skip-yaml-locked'
  | 'skip-typing'
  | 'saved'
  | 'failed';

function latestEditAt(...values: Array<number | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number') continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/**
 * One tick of the autosave loop. Pure with respect to its `deps`; tests
 * call it directly to exercise every guard branch without simulating timers.
 */
export async function autosaveTickOnce(deps: AutosaveDeps): Promise<AutosaveTickResult> {
  if (deps.savingRef.current) return 'skip-saving';
  const s = deps.pipelineGet();
  if (!s.isDirty) return 'skip-clean';
  if (!s.yamlPath) return 'skip-no-path';
  const run = deps.runGet();
  if (run.active || run.status === 'starting' || run.status === 'running') return 'skip-running';
  if (deps.isYamlEditLocked?.() ?? false) return 'skip-yaml-locked';
  const now = deps.now();
  const lastEditAt = latestEditAt(deps.lastEditAtRef.current, deps.getLastLocalEditAt?.() ?? null);
  if (lastEditAt !== null && now - lastEditAt < deps.quietMs) return 'skip-typing';

  deps.savingRef.current = true;
  try {
    const ok = await s.saveFile();
    if (!ok) return 'failed';
    return 'saved';
  } finally {
    deps.savingRef.current = false;
  }
}

/**
 * React hook: while autosave is enabled in editor settings, periodically
 * invokes autosaveTickOnce. Mounts once from App.tsx.
 */
export function useDiskAutosave(): void {
  const settings = useEditorSettingsStore((s) => s.settings);
  const enabled = settings?.autoSaveEnabled ?? true;
  const intervalSec = Math.max(
    MIN_INTERVAL_SEC,
    settings?.autoSaveIntervalSec ?? DEFAULT_INTERVAL_SEC,
  );

  const savingRef = useRef(false);
  const lastEditAtRef = useRef<number | null>(null);

  // Track edits via config-reference change. Uses a single-arg subscriber
  // with a manual diff so this works under any Zustand setup.
  useEffect(() => {
    let prevConfig = usePipelineStore.getState().config;
    const unsub = usePipelineStore.subscribe((state) => {
      if (state.config !== prevConfig) {
        prevConfig = state.config;
        lastEditAtRef.current = Date.now();
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      void autosaveTickOnce({
        pipelineGet: () => {
          const s = usePipelineStore.getState();
          return { isDirty: s.isDirty, yamlPath: s.yamlPath, saveFile: s.saveFile };
        },
        runGet: () => {
          const run = useRunStore.getState();
          return { active: run.active, status: run.status };
        },
        isYamlEditLocked,
        savingRef,
        lastEditAtRef,
        getLastLocalEditAt: getLastLocalFieldEditAt,
        now: () => Date.now(),
        quietMs: QUIET_MS,
      });
    };
    const id = setInterval(tick, intervalSec * 1000);
    return () => clearInterval(id);
  }, [enabled, intervalSec]);
}
