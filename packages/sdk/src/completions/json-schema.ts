import { readFile } from 'node:fs/promises';
import Ajv, { type AnySchema } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  CompletionCheckResult,
  CompletionContext,
  CompletionPlugin,
  TaskResult,
} from '@tagma/types';
import { requiredPluginString, resolvePluginPath } from '../plugin-config';

function failed(feedback: string): CompletionCheckResult {
  return { passed: false, feedback: `json_schema completion: ${feedback}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonFinitePaths(value: unknown): string[] {
  const paths: string[] = [];
  const pending = [{ value, path: '' }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) {
      paths.push(item.path || '/');
    } else if (item.value !== null && typeof item.value === 'object') {
      for (const [key, child] of Object.entries(item.value)) {
        const token = key.replace(/~/g, '~0').replace(/\//g, '~1');
        pending.push({ value: child, path: `${item.path}/${token}` });
      }
    }
  }
  return paths;
}

async function readJson(
  path: string,
  label: 'schema' | 'data',
  signal: AbortSignal | undefined,
): Promise<{ value: unknown } | CompletionCheckResult> {
  signal?.throwIfAborted();
  let bytes: Buffer;
  try {
    bytes = await readFile(path, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failed(`${label} file is missing: ${path}`);
    }
    throw error;
  }
  signal?.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    return failed(`${label} file is not a complete UTF-8 JSON document: ${errorMessage(error)}`);
  }
  const nonFinite = nonFinitePaths(value);
  if (nonFinite.length > 0) {
    return failed(`${label} contains non-finite JSON numbers at ${JSON.stringify(nonFinite)}`);
  }
  return { value };
}

/**
 * An explicit file contract executed by the Host's built-in registry. It neither
 * interprets prose nor changes the payload: requiredness, extra properties and
 * formats come from the author's local Draft 7 schema. Cross-file relationships
 * and factual entailment remain separate authored checks.
 */
export const JsonSchemaCompletion: CompletionPlugin = {
  name: 'json_schema',
  trial: {
    protocolVersion: 1,
    interaction: 'none',
    unattended: 'fixture',
    filesystem: 'workspace-read',
    network: 'none',
    secrets: 'none',
    runtime: 'bounded',
  },
  schema: {
    description:
      'Validate a complete JSON file against an explicit local Draft 7 JSON Schema. No coercion, defaults, property removal, async validation or remote reference fetching. Cross-file identity, order and coverage checks remain authored separately.',
    fields: {
      path: {
        type: 'path',
        required: true,
        description: 'JSON payload file, relative to effective task cwd or absolute within it.',
      },
      schema_path: {
        type: 'path',
        required: true,
        description: 'Local Draft 7 schema file, resolved from the same effective task cwd.',
      },
    },
  },

  async check(
    config: Record<string, unknown>,
    _result: TaskResult,
    ctx: CompletionContext,
  ): Promise<boolean | CompletionCheckResult> {
    const path = resolvePluginPath(
      requiredPluginString(config, 'path', 'json_schema completion'),
      ctx.workDir,
    );
    const schemaPath = resolvePluginPath(
      requiredPluginString(config, 'schema_path', 'json_schema completion'),
      ctx.workDir,
    );
    const schema = await readJson(schemaPath, 'schema', ctx.signal);
    if ('passed' in schema) return schema;
    if (
      typeof schema.value !== 'boolean' &&
      (schema.value === null || typeof schema.value !== 'object' || Array.isArray(schema.value))
    ) {
      return failed('schema must be a Draft 7 object or boolean');
    }

    const ajv = new Ajv({
      allErrors: true,
      strictSchema: true,
      strictNumbers: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      useDefaults: false,
      coerceTypes: false,
      removeAdditional: false,
      $data: false,
      addUsedSchema: false,
    });
    addFormats(ajv);
    let validate;
    try {
      // compile is synchronous. No loadSchema/compileAsync or custom keywords
      // exist here; unresolved external $refs fail instead of fetching them.
      validate = ajv.compile(schema.value as AnySchema);
    } catch (error) {
      return failed(`schema is invalid or unsupported: ${errorMessage(error)}`);
    }
    if ('$async' in validate && validate.$async === true) {
      return failed('async schemas are not supported');
    }
    ctx.signal?.throwIfAborted();
    const data = await readJson(path, 'data', ctx.signal);
    if ('passed' in data) return data;
    ctx.signal?.throwIfAborted();
    if (validate(data.value) === true) return true;
    // Preserve every returned diagnostic. Core bounds the UI projection while
    // retaining the complete suffix for canonical repair evidence.
    return failed(`validation failed\n${JSON.stringify(validate.errors, null, 2)}`);
  },
};
