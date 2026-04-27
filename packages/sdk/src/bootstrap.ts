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

// Built-in Completions
import { ExitCodeCompletion } from './completions/exit-code';
import { FileExistsCompletion } from './completions/file-exists';
import { OutputCheckCompletion } from './completions/output-check';

// Built-in Middleware
import { StaticContextMiddleware } from './middlewares/static-context';

export const BuiltinTagmaPlugin = {
  name: '@tagma/sdk/builtins',
  capabilities: {
    drivers: {
      opencode: OpenCodeDriver,
    },
    triggers: {
      file: FileTrigger,
      manual: ManualTrigger,
    },
    completions: {
      exit_code: ExitCodeCompletion,
      file_exists: FileExistsCompletion,
      output_check: OutputCheckCompletion,
    },
    middlewares: {
      static_context: StaticContextMiddleware,
    },
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
 */
export function bootstrapBuiltins(target: PluginRegistry): void {
  target.registerTagmaPlugin(BuiltinTagmaPlugin);
}
