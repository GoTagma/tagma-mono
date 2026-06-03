import { statSync } from 'node:fs';

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM']);

function errorCode(err) {
  return typeof err?.code === 'string' ? err.code : null;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function describePublishTargetStatus(path, stat = statSync) {
  try {
    stat(path);
    return { kind: 'ok' };
  } catch (err) {
    const code = errorCode(err);
    if (code && MISSING_CODES.has(code)) return { kind: 'missing' };
    if (code && UNREADABLE_CODES.has(code)) {
      return { kind: 'unreadable', code, message: errorMessage(err) };
    }
    return {
      kind: 'unreadable',
      code: code ?? 'UNKNOWN',
      message: errorMessage(err),
    };
  }
}

export function formatPublishTargetFailure(packageName, field, rel, status) {
  if (status.kind === 'missing') {
    return `${packageName}: ${field} -> "${rel}" does not exist (run \`bun run build\` and/or fix package.json)`;
  }
  if (status.kind === 'unreadable') {
    return `${packageName}: ${field} -> "${rel}" cannot be accessed (${status.code}: ${status.message})`;
  }
  return null;
}
