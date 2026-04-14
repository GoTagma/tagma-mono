import { registerPlugin } from './registry';

// Built-in Drivers
// Only claude-code is built in. Other drivers (codex, opencode) ship as
// workspace plugins under plugins/ and must be declared in pipeline.yaml
// via the `plugins` field, e.g.:
//   plugins: ["@tagma/driver-codex", "@tagma/driver-opencode"]
import { ClaudeCodeDriver } from './drivers/claude-code';

// Built-in Triggers
import { FileTrigger } from './triggers/file';
import { ManualTrigger } from './triggers/manual';

// Built-in Completions
import { ExitCodeCompletion } from './completions/exit-code';
import { FileExistsCompletion } from './completions/file-exists';
import { OutputCheckCompletion } from './completions/output-check';

// Built-in Middleware
import { StaticContextMiddleware } from './middlewares/static-context';

export function bootstrapBuiltins(): void {
  // Drivers
  registerPlugin('drivers', 'claude-code', ClaudeCodeDriver);

  // Triggers
  registerPlugin('triggers', 'file', FileTrigger);
  registerPlugin('triggers', 'manual', ManualTrigger);

  // Completions
  registerPlugin('completions', 'exit_code', ExitCodeCompletion);
  registerPlugin('completions', 'file_exists', FileExistsCompletion);
  registerPlugin('completions', 'output_check', OutputCheckCompletion);

  // Middlewares
  registerPlugin('middlewares', 'static_context', StaticContextMiddleware);
}
