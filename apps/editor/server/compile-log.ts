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

  const result = compileYamlContent(content, {
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

  writeCompileLog(compileLogPath(yamlPath), result);
  return result;
}

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
