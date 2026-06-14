import type { PluginRegistry } from '@tagma/core';
import type { TagmaPlugin } from '@tagma/types';

// Built-in Drivers
// Only opencode is built in. Other drivers (codex, claude-code) ship as
// workspace plugins under packages/ and must be declared in pipeline.yaml
// via the `plugins` field, e.g.:
//   plugins: ["@tagma/driver-codex", "@tagma/driver-claude-code"]
import { OpenCodeDriver } from './drivers/opencode';

// Built-in Triggers
import { DirectoryTrigger } from './triggers/directory';
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
      directory: DirectoryTrigger,
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
 */
export function bootstrapBuiltins(target: PluginRegistry): void {
  target.registerTagmaPlugin(BuiltinTagmaPlugin);
}
