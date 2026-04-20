import { defaultRegistry, type PluginRegistry } from './registry';

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

/**
 * Register every built-in plugin into `target` (defaults to the process-wide
 * default registry). Multi-tenant hosts instantiate one PluginRegistry per
 * workspace and call this once per instance so each workspace sees the same
 * built-ins without sharing registration state.
 *
 * Built-in handlers are stateless module singletons — registering the same
 * handler object into N registries is cheap and safe; no cloning is needed.
 */
export function bootstrapBuiltins(target: PluginRegistry = defaultRegistry): void {
  // Drivers
  target.registerPlugin('drivers', 'opencode', OpenCodeDriver);

  // Triggers
  target.registerPlugin('triggers', 'file', FileTrigger);
  target.registerPlugin('triggers', 'manual', ManualTrigger);

  // Completions
  target.registerPlugin('completions', 'exit_code', ExitCodeCompletion);
  target.registerPlugin('completions', 'file_exists', FileExistsCompletion);
  target.registerPlugin('completions', 'output_check', OutputCheckCompletion);

  // Middlewares
  target.registerPlugin('middlewares', 'static_context', StaticContextMiddleware);
}
