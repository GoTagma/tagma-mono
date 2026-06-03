import { isAbsolute, resolve } from 'node:path';
import { validatePath } from '@tagma/core';

export function requiredPluginString(
  config: Record<string, unknown>,
  field: string,
  owner: string,
): string {
  const value = config[field];
  if (value === undefined) throw new Error(`${owner}: "${field}" is required`);
  if (typeof value !== 'string') throw new Error(`${owner}: "${field}" must be a string`);
  if (value.trim().length === 0) throw new Error(`${owner}: "${field}" is required`);
  return value;
}

export function optionalPluginString(
  config: Record<string, unknown>,
  field: string,
  owner: string,
): string | undefined {
  const value = config[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${owner}: "${field}" must be a string`);
  return value;
}

export function resolvePluginPath(
  filePath: string,
  workDir: string,
  options: { readonly allowAbsoluteOutside?: boolean } = {},
): string {
  if (options.allowAbsoluteOutside && isAbsolute(filePath)) return resolve(filePath);
  return validatePath(filePath, workDir);
}
