import yaml from 'js-yaml';
import { validateRaw } from './validate-raw';
import type { ValidationError, KnownPluginTypes } from './validate-raw';
import type { RawPipelineConfig } from '@tagma/types';

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

  let doc: unknown;
  try {
    doc = yaml.load(content);
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

  const envelopeErrors = validateEnvelope(doc);
  if (envelopeErrors.length > 0) {
    return buildValidationResult(timestamp, sourceName, envelopeErrors);
  }
  const config = (doc as { pipeline: RawPipelineConfig }).pipeline;

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

  return buildValidationResult(timestamp, sourceName, errors);
}

function validateEnvelope(doc: unknown): ValidationError[] {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !('pipeline' in doc)) {
    return [{ path: 'pipeline', message: 'Top-level "pipeline" key is required' }];
  }
  const pipeline = (doc as Record<string, unknown>).pipeline;
  if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) {
    return [{ path: 'pipeline', message: 'pipeline must be an object' }];
  }
  return [];
}

function buildValidationResult(
  timestamp: string,
  sourceName: string,
  diagnostics: readonly ValidationError[],
): YamlCompileResult {
  const validationErrors = diagnostics.filter(
    (e) => e.severity === 'error' || e.severity == null,
  );
  const validationWarnings = diagnostics.filter((e) => e.severity === 'warning');

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
