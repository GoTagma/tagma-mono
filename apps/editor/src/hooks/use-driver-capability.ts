// ─────────────────────────────────────────────────────────────────────────────
// use-driver-capability.ts — F2: expose DriverCapabilities to UI components
// ─────────────────────────────────────────────────────────────────────────────
//
// The plugin registry (loaded by pipeline-store on init) now includes a
// `driverCapabilities` map keyed by driver name. This hook is a thin selector
// around the store so components can conditionally gate fields such as
// sessionResume, systemPrompt, and outputFormat.
//
// Group 3 owns TaskConfigPanel; they (or a follow-up cycle) will consume this
// hook to grey out unsupported fields with an inline warning. Group 5 only
// exposes the data + hook.
//
// Usage:
//   const caps = useDriverCapability(task.driver ?? track.driver ?? pipeline.driver);
//   if (caps && !caps.systemPrompt) { ... disable / warn ... }
// ─────────────────────────────────────────────────────────────────────────────

import { usePipelineStore } from '../store/pipeline-store';
import type { DriverCapabilities } from '../api/client';

/**
 * Look up capabilities for a driver by name. Returns `undefined` when:
 *  - `driverName` is falsy (no driver selected)
 *  - the registry hasn't loaded yet
 *  - the server doesn't expose `driverCapabilities` (older server)
 *  - the named driver isn't registered
 *
 * Callers should treat `undefined` as "don't know — assume capable" to avoid
 * false negatives when the server hasn't populated the map yet.
 */
export function useDriverCapability(
  driverName: string | null | undefined,
): DriverCapabilities | undefined {
  const driverCapabilities = usePipelineStore((state) => state.registry.driverCapabilities);
  if (!driverName) return undefined;
  if (!driverCapabilities) return undefined;
  return driverCapabilities[driverName];
}

/**
 * Synchronous lookup for non-hook contexts (e.g. imperative validation
 * helpers). Reads the store once — does not subscribe. Prefer the hook
 * variant inside React components.
 */
export function getDriverCapability(
  driverName: string | null | undefined,
): DriverCapabilities | undefined {
  if (!driverName) return undefined;
  const caps = usePipelineStore.getState().registry.driverCapabilities;
  return caps?.[driverName];
}
