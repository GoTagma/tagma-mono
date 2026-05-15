// Minimal, dependency-free semver range evaluator.
//
// Extracted from the dependency-integrity gate so it can be unit-tested
// in isolation (`node:test`). Implements the npm semver semantics that
// this monorepo actually relies on -- caret/tilde, x-ranges / partial
// versions, space-joined AND, `||` OR, and the 0.x caret special-casing
// the published @tagma/* plugins depend on. It is intentionally NOT a
// full semver implementation; build metadata ordering and complex
// prerelease precedence are out of scope.

export function parseVersion(input) {
  const cleaned = String(input).trim().replace(/^v/, '');
  const core = cleaned.split('+')[0].split('-')[0];
  const parts = core.split('.');
  if (parts.length < 1 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const [major = 0, minor = 0, patch = 0] = parts.map(Number);
  const prerelease = cleaned.includes('-')
    ? cleaned.slice(cleaned.indexOf('-') + 1).split('+')[0]
    : '';
  return { major, minor, patch, prerelease };
}

export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease < b.prerelease ? -1 : 1;
}

// Parse a (possibly partial / wildcard) version token into numeric
// segments, returning null for any segment that is an x/X/* wildcard
// or absent. "1" -> [1], "1.2.x" -> [1,2,null], "*" -> [].
function partialSegments(token) {
  const core = token.split('+')[0].split('-')[0];
  if (core === '' || core === '*' || core === 'x' || core === 'X') return [];
  return core.split('.').map((seg) => {
    if (seg === '' || seg === '*' || seg === 'x' || seg === 'X') return null;
    return /^\d+$/.test(seg) ? Number(seg) : NaN;
  });
}

// Expand one whitespace-delimited range token into zero or more simple
// comparators, implementing npm semver semantics for caret, tilde,
// x-ranges / partial versions, and bare comparators.
export function expandRangePart(part) {
  if (/^(>=|<=|>|<|=)/.test(part)) {
    const operator = part.match(/^(>=|<=|>|<|=)/)[0];
    const segs = partialSegments(part.slice(operator.length));
    if (segs.length === 0 || segs.some((s) => s === null)) return [part];
    const [major = 0, minor = 0, patch = 0] = segs;
    return [`${operator}${major}.${minor}.${patch}`];
  }
  const prefix = part[0] === '^' || part[0] === '~' ? part[0] : '';
  const segs = partialSegments(prefix ? part.slice(1) : part);
  if (segs.some((s) => Number.isNaN(s))) return [part];

  // Bare/x-range with no caret/tilde: "*", "1", "1.x", "1.2.x", "1.2.3".
  if (!prefix) {
    if (segs.length === 0 || segs[0] === null) return ['>=0.0.0'];
    const major = segs[0];
    if (segs.length < 2 || segs[1] === null) {
      return [`>=${major}.0.0`, `<${major + 1}.0.0`];
    }
    const minor = segs[1];
    if (segs.length < 3 || segs[2] === null) {
      return [`>=${major}.${minor}.0`, `<${major}.${minor + 1}.0`];
    }
    return [`${major}.${minor}.${segs[2]}`];
  }

  const major = segs[0] ?? 0;
  const minor = segs[1] ?? 0;
  const patch = segs[2] ?? 0;
  const lower = `>=${major}.${minor}.${patch}`;
  if (prefix === '^') {
    if (major > 0) return [lower, `<${major + 1}.0.0`];
    if (minor > 0) return [lower, `<0.${minor + 1}.0`];
    // major === 0 && minor === 0: npm pins the most-specific component.
    if (segs[2] != null) return [lower, `<0.0.${patch + 1}`]; // ^0.0.3
    if (segs[1] != null) return [lower, `<0.${minor + 1}.0`]; // ^0.0  -> <0.1.0
    return [lower, `<${major + 1}.0.0`]; // ^0     -> <1.0.0
  }
  // tilde: ~1 -> >=1.0.0 <2.0.0 ; ~1.2 / ~1.2.3 -> >=… <1.(minor+1).0
  if (segs.length < 2 || segs[1] === null) return [lower, `<${major + 1}.0.0`];
  return [lower, `<${major}.${minor + 1}.0`];
}

function satisfiesComparator(version, comparator) {
  const match = comparator.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!match) return false;
  const operator = match[1] || '=';
  const target = parseVersion(match[2]);
  if (!target) return false;
  const cmp = compareVersions(version, target);
  switch (operator) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

// True when `versionString` satisfies the npm-style `range`.
// Grammar: "*"/"x"/"" (any), exact, comparator (">=a"), space-joined
// AND, "||" OR, caret, tilde, and x-ranges / partial versions.
export function satisfies(versionString, range) {
  const trimmed = String(range).trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return true;
  const version = parseVersion(versionString);
  if (!version) return false;
  return trimmed.split('||').some((clause) => {
    const comparators = clause
      .trim()
      .split(/\s+/)
      .flatMap((part) => expandRangePart(part))
      .filter(Boolean);
    if (comparators.length === 0) return true;
    return comparators.every((comparator) => satisfiesComparator(version, comparator));
  });
}
