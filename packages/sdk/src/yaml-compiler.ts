import { parseYaml } from './schema';
import { validateRaw } from './validate-raw';
import type { ValidationError, KnownPluginTypes } from './validate-raw';
import type { RawPipelineConfig } from './types';

export interface YamlCompileResult {
  readonly timestamp: string;
  readonly sourceName: string;
  readonly success: boolean;
  readonly parseOk: boolean;
  readonly validation: {
    readonly errors: ReadonlyArray<Pick<ValidationError, 'path' | 'message'>>;
    readonly warnings: ReadonlyArray<Pick<ValidationError, 'path' | 'message'>>;
  };
  readonly summary: string;
}

export interface CompileYamlOptions {
  readonly sourceName?: string;
  readonly knownTypes?: KnownPluginTypes;
}

export function compileYamlContent(
  content: string,
  opts: CompileYamlOptions = {},
): YamlCompileResult {
  const timestamp = new Date().toISOString();
  const sourceName = opts.sourceName ?? 'untitled';

  let config: RawPipelineConfig;
  try {
    config = parseYaml(content);
  } catch (err) {
    return {
      timestamp,
      sourceName,
      success: false,
      parseOk: false,
      validation: { errors: [], warnings: [] },
      summary: `YAML parse error: ${errorMessage(err)}`,
    };
  }

  let errors: ValidationError[];
  try {
    errors = validateRaw(config, opts.knownTypes);
  } catch (err) {
    return {
      timestamp,
      sourceName,
      success: false,
      parseOk: true,
      validation: { errors: [], warnings: [] },
      summary: `Validation crashed: ${errorMessage(err)}`,
    };
  }

  const validationErrors = errors.filter((e) => e.severity === 'error' || e.severity == null);
  const validationWarnings = errors.filter((e) => e.severity === 'warning');

  return {
    timestamp,
    sourceName,
    success: validationErrors.length === 0,
    parseOk: true,
    validation: {
      errors: validationErrors.map((e) => ({ path: e.path, message: e.message })),
      warnings: validationWarnings.map((e) => ({ path: e.path, message: e.message })),
    },
    summary:
      validationErrors.length === 0
        ? validationWarnings.length === 0
          ? 'Valid pipeline configuration'
          : `Valid with ${validationWarnings.length} warning(s)`
        : `Invalid: ${validationErrors.length} error(s), ${validationWarnings.length} warning(s)`,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
