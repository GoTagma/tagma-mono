import type { PluginRegistry } from '@tagma/core';
import type { TagmaPlugin } from '@tagma/types';

// Built-in Drivers
// Only opencode is built in. Other drivers (codex, claude-code) ship as
// workspace plugins under packages/ and must be declared in pipeline.yaml
// via the `plugins` field, e.g.:
//   plugins: ["@tagma/driver-codex", "@tagma/driver-claude-code"]
import { OpenCodeDriver } from './drivers/opencode';

// Built-in Triggers
import { FileTrigger } from './triggers/file';
import { ManualTrigger } from './triggers/manual';
import { DirectoryTrigger } from './triggers/directory';

// Built-in Completions
import { ExitCodeCompletion } from './completions/exit-code';
import { FileExistsCompletion } from './completions/file-exists';
import { OutputCheckCompletion } from './completions/output-check';

// Built-in Middleware
import { StaticContextMiddleware } from './middlewares/static-context';

/**
 * Safe-mode built-ins: plugins that do not execute arbitrary code or shell
 * commands. These are registered with `{ safeMode: true }` and are available
 * under `mode: 'safe'` pipelines without explicit allowlist entries.
 */
export const SafeBuiltinTagmaPlugin = {
  name: '@tagma/sdk/builtins-safe',
  capabilities: {
    drivers: {
      opencode: OpenCodeDriver,
    },
    triggers: {
      directory: DirectoryTrigger,
      file: FileTrigger,
      manual: ManualTrigger,
    },
    completions: {
      exit_code: ExitCodeCompletion,
      file_exists: FileExistsCompletion,
    },
    middlewares: {
      static_context: StaticContextMiddleware,
    },
  },
} satisfies TagmaPlugin;

/**
 * Unsafe built-ins: plugins that execute arbitrary shell commands and must
 * NOT be in the safe-mode allowlist. These require explicit caller opt-in
 * via `safeModeAllowlist` or `mode: 'trusted'`.
 *
 * `output_check` pipes task output into a user-specified shell command,
 * which is a direct command-execution vector. Including it in safe mode
 * would bypass the safe-mode intent that blocks command execution.
 */
export const UnsafeBuiltinTagmaPlugin = {
  name: '@tagma/sdk/builtins-unsafe',
  capabilities: {
    completions: {
      output_check: OutputCheckCompletion,
    },
  },
} satisfies TagmaPlugin;

/**
 * Combined built-in plugin bundle for backward compatibility. Includes both
 * safe and unsafe plugins. Use `bootstrapBuiltins()` to register with
 * proper safe-mode scoping.
 */
export const BuiltinTagmaPlugin = {
  name: '@tagma/sdk/builtins',
  capabilities: {
    drivers: SafeBuiltinTagmaPlugin.capabilities.drivers,
    triggers: SafeBuiltinTagmaPlugin.capabilities.triggers,
    completions: {
      ...SafeBuiltinTagmaPlugin.capabilities.completions,
      ...UnsafeBuiltinTagmaPlugin.capabilities.completions,
    },
    middlewares: SafeBuiltinTagmaPlugin.capabilities.middlewares,
  },
} satisfies TagmaPlugin;

/**
 * Register every built-in plugin into `target`. Hosts instantiate one
 * PluginRegistry per workspace or SDK instance and call this once per
 * instance so each workspace sees the same built-ins without sharing
 * registration state.
 *
 * Built-in handlers are stateless module singletons — registering the same
 * handler object into N registries is cheap and safe; no cloning is needed.
 *
 * Safe built-ins register with `{ safeMode: true }` so they are automatically
 * available under `mode: 'safe'` pipelines without explicit allowlist entries.
 * Unsafe built-ins (output_check, which executes arbitrary shell commands)
 * register WITHOUT safeMode, requiring explicit caller opt-in.
 *
 * The registry's `getSafeModeDefaults()` surfaces these to the engine's 3-way
 * safe-mode merge (hardcoded defaults ∪ registry-declared ∪ caller-supplied).
 */
export function bootstrapBuiltins(target: PluginRegistry): void {
  target.registerTagmaPlugin(SafeBuiltinTagmaPlugin, { safeMode: true });
  target.registerTagmaPlugin(UnsafeBuiltinTagmaPlugin, { safeMode: false });
}
