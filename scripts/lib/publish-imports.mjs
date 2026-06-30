import { pathToFileURL } from 'node:url';
import { extname, join } from 'node:path';

const IMPORTABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function cleanTargetPath(rel) {
  const queryIndex = rel.search(/[?#]/);
  return queryIndex === -1 ? rel : rel.slice(0, queryIndex);
}

export function isImportablePublishTarget(field, rel) {
  if (typeof rel !== 'string' || rel.includes('*')) return false;
  if (field === 'bin' || field.startsWith('bin.')) return false;
  return IMPORTABLE_EXTENSIONS.has(extname(cleanTargetPath(rel)));
}

export async function checkPublishTargetImport(pkgName, field, dir, rel) {
  if (!isImportablePublishTarget(field, rel)) return null;
  try {
    await import(pathToFileURL(join(dir, cleanTargetPath(rel))).href);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${pkgName}: ${field} "${rel}" failed to import: ${message}`;
  }
}
