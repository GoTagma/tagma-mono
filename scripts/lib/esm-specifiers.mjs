import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const SPECIFIER_RE =
  /\bimport\s*(?:\(\s*(['"])([^'"]+)\1\s*\)|(?:[^'";]*?\s+from\s*)?(['"])([^'"]+)\3)|\bexport\s+(?:[^'";]*?\s+from\s*)(['"])([^'"]+)\5/g;

function specifierFromMatch(match) {
  return match[2] ?? match[4] ?? match[6];
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function splitSpecifierSuffix(specifier) {
  const index = specifier.search(/[?#]/);
  if (index === -1) return { bare: specifier, suffix: '' };
  return { bare: specifier.slice(0, index), suffix: specifier.slice(index) };
}

function hasPathExtension(specifier) {
  const { bare } = splitSpecifierSuffix(specifier);
  return extname(bare) !== '';
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function collectJsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(path, out);
    } else if (entry.isFile() && path.endsWith('.js')) {
      out.push(path);
    }
  }
  return out;
}

export function resolveExtensionlessRelativeSpecifier(jsFile, specifier, exists = existsSync) {
  if (!isRelativeSpecifier(specifier) || hasPathExtension(specifier)) return null;
  const { bare, suffix } = splitSpecifierSuffix(specifier);
  const targetBase = resolve(dirname(jsFile), bare);
  if (exists(`${targetBase}.js`)) {
    return `${bare}.js${suffix}`;
  }
  const indexTarget = join(targetBase, 'index.js');
  if (exists(indexTarget)) {
    return `${bare.replace(/\/$/, '')}/index.js${suffix}`;
  }
  return null;
}

export function findExtensionlessRelativeEsmSpecifiers(jsFile, source, exists = existsSync) {
  const findings = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = specifierFromMatch(match);
    if (!specifier || !isRelativeSpecifier(specifier) || hasPathExtension(specifier)) continue;
    findings.push({
      specifier,
      replacement: resolveExtensionlessRelativeSpecifier(jsFile, specifier, exists),
      index: match.index ?? 0,
    });
  }
  return findings;
}

export function rewriteExtensionlessRelativeEsmSpecifiers(jsFile, source, exists = existsSync) {
  return source.replace(SPECIFIER_RE, (match, _q1, dyn, _q2, stat, _q3, exp) => {
    const specifier = dyn ?? stat ?? exp;
    if (!specifier || !isRelativeSpecifier(specifier) || hasPathExtension(specifier)) return match;
    const replacement = resolveExtensionlessRelativeSpecifier(jsFile, specifier, exists);
    return replacement ? match.replace(specifier, replacement) : match;
  });
}

export function rewriteDistEsmSpecifiers(distDir) {
  const failures = [];
  for (const file of collectJsFiles(distDir)) {
    const source = readFileSync(file, 'utf8');
    const findings = findExtensionlessRelativeEsmSpecifiers(file, source);
    const unresolved = findings.filter((finding) => finding.replacement === null);
    for (const finding of unresolved) {
      failures.push(`${toPosixPath(relative(distDir, file))}: cannot resolve "${finding.specifier}"`);
    }
    const rewritten = rewriteExtensionlessRelativeEsmSpecifiers(file, source);
    if (rewritten !== source) writeFileSync(file, rewritten, 'utf8');
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to rewrite extensionless relative ESM imports in ${distDir}:\n` +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }
}

export function findExtensionlessRelativeEsmSpecifiersInDir(distDir) {
  const findings = [];
  for (const file of collectJsFiles(distDir)) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const source = readFileSync(file, 'utf8');
    for (const finding of findExtensionlessRelativeEsmSpecifiers(file, source)) {
      findings.push({
        file,
        relFile: toPosixPath(relative(distDir, file)),
        ...finding,
      });
    }
  }
  return findings;
}
