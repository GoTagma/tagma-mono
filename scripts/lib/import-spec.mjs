// Pure import-specifier helpers for the phantom-dependency gate.
// Extracted so the extraction regexes (which already had one
// scan-to-the-next-from bug) are unit-tested in isolation.
import { builtinModules } from 'node:module';

const BUILTINS = new Set([...builtinModules, 'bun', 'bun:test', 'bun:sqlite', 'bun:ffi']);

export function isBuiltin(spec) {
  if (spec.startsWith('node:') || spec.startsWith('bun:')) return true;
  return BUILTINS.has(spec);
}

// "@scope/n/sub" -> "@scope/n" ; "pkg/sub" -> "pkg".
export function pkgNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Non-cross-statement extractors. Anchoring `from` forms to a line
// start (m flag) and forbidding `;` between keyword and specifier
// prevents matching `export const x` forward to an unrelated `from`.
const RE_FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm;
const RE_BARE = /^\s*import\s*['"]([^'"\n]+)['"]/gm;
const RE_CALL = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

export function specifiersOf(text) {
  const specs = new Set();
  for (const re of [RE_FROM, RE_BARE, RE_CALL]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) if (m[1]) specs.add(m[1]);
  }
  return specs;
}
