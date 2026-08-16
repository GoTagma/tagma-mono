import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { compileYamlContent, type YamlCompileResult } from '@tagma/sdk/yaml';
import type {
  CompletionPlugin,
  MiddlewarePlugin,
  PluginCategory,
  PluginRegistry,
  PluginSchema,
  TriggerPlugin,
} from '@tagma/sdk/plugins';
import { atomicWriteFileSync } from './path-utils.js';

type SchemaCarryingCategory = 'triggers' | 'completions' | 'middlewares';
type SchemaCarryingHandler = TriggerPlugin | CompletionPlugin | MiddlewarePlugin;

export interface CompileLogDiagnostic {
  readonly path: string;
  readonly message: string;
  readonly severity?: 'error' | 'warning';
}

export interface RunCompileAndWriteLogOptions {
  /**
   * Context-aware checks owned by a specific authoring surface. The callback
   * receives the exact content snapshot compiled above, so its diagnostics
   * cannot race a second file read.
   */
  readonly additionalValidation?: (content: string) => readonly CompileLogDiagnostic[];
}

function collectSchemas(
  registry: PluginRegistry,
  category: SchemaCarryingCategory,
): Record<string, PluginSchema | undefined> {
  const out: Record<string, PluginSchema | undefined> = {};
  for (const type of registry.listRegistered(category as PluginCategory)) {
    // getHandler is generic; the runtime check is "handler exists with this name".
    // SchemaCarryingHandler covers all three categories that declare `schema?`.
    const handler = registry.getHandler<SchemaCarryingHandler>(category as PluginCategory, type);
    out[type] = handler.schema;
  }
  return out;
}

export function compileLogPath(yamlPath: string): string {
  const dir = dirname(yamlPath);
  const base = basename(yamlPath);
  const stem = base.replace(/\.ya?ml$/i, '');
  return join(dir, `${stem}.compile.log`);
}

export function runCompileAndWriteLog(
  yamlPath: string,
  registry?: PluginRegistry,
  options: RunCompileAndWriteLogOptions = {},
): YamlCompileResult {
  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    const result: YamlCompileResult = {
      timestamp: new Date().toISOString(),
      sourceName: yamlPath,
      success: false,
      parseOk: false,
      validation: { errors: [], warnings: [] },
      summary: `Failed to read file: ${errorMessage(err)}`,
    };
    writeCompileLog(compileLogPath(yamlPath), result);
    return result;
  }

  let result = compileYamlContent(content, {
    sourceName: yamlPath,
    knownTypes: registry
      ? {
          drivers: registry.listRegistered('drivers'),
          triggers: registry.listRegistered('triggers'),
          completions: registry.listRegistered('completions'),
          middlewares: registry.listRegistered('middlewares'),
          // Forward plugin schemas so validate-raw can run the same per-field
          // checks core preflight does at engine startup. Users see bad
          // `timeout: "garbage"` etc. in the editor instead of at run time.
          schemas: {
            triggers: collectSchemas(registry, 'triggers'),
            completions: collectSchemas(registry, 'completions'),
            middlewares: collectSchemas(registry, 'middlewares'),
          },
        }
      : undefined,
  });

  if (result.parseOk && options.additionalValidation) {
    let additionalDiagnostics: readonly CompileLogDiagnostic[];
    try {
      additionalDiagnostics = options.additionalValidation(content);
    } catch (err) {
      additionalDiagnostics = [
        {
          path: 'pipeline',
          message: `Additional compile validation failed: ${errorMessage(err)}`,
          severity: 'error',
        },
      ];
    }
    result = mergeCompileDiagnostics(result, additionalDiagnostics);
  }

  writeCompileLog(compileLogPath(yamlPath), result);
  return result;
}

function mergeCompileDiagnostics(
  result: YamlCompileResult,
  diagnostics: readonly CompileLogDiagnostic[],
): YamlCompileResult {
  if (diagnostics.length === 0) return result;

  const errors = [...result.validation.errors];
  const warnings = [...result.validation.warnings];
  const seen = new Set([
    ...errors.map((diagnostic) => `error\u0000${diagnostic.path}\u0000${diagnostic.message}`),
    ...warnings.map((diagnostic) => `warning\u0000${diagnostic.path}\u0000${diagnostic.message}`),
  ]);
  for (const diagnostic of diagnostics) {
    const severity = diagnostic.severity === 'warning' ? 'warning' : 'error';
    const identity = `${severity}\u0000${diagnostic.path}\u0000${diagnostic.message}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const target = severity === 'warning' ? warnings : errors;
    target.push({ path: diagnostic.path, message: diagnostic.message });
  }

  const baseFailureHasNoValidationError = !result.success && result.validation.errors.length === 0;
  return {
    ...result,
    success: result.success && errors.length === 0,
    validation: { errors, warnings },
    // A compiler crash is represented in `summary`, not in validation.errors.
    // Preserve that authoritative failure text instead of replacing it with a
    // count derived only from the additional authoring diagnostics.
    summary: baseFailureHasNoValidationError
      ? result.summary
      : errors.length > 0
        ? `Invalid: ${errors.length} error(s), ${warnings.length} warning(s)`
        : warnings.length > 0
          ? `Valid with ${warnings.length} warning(s)`
          : 'Valid pipeline configuration',
  };
}

export const __compileLogTestHooks = { mergeCompileDiagnostics };

function writeCompileLog(path: string, result: YamlCompileResult): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    console.error(`[compile-log] failed to write ${path}:`, err);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
