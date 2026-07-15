function stripJsonComments(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        output += ' ';
        index += 1;
      }
      if (index < source.length) output += source[index];
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          output += '  ';
          index += 1;
          break;
        }
        output += source[index] === '\n' || source[index] === '\r' ? source[index] : ' ';
        index += 1;
      }
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(source) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ',') {
      let nextIndex = index + 1;
      while (nextIndex < source.length && /\s/.test(source[nextIndex])) nextIndex += 1;
      if (source[nextIndex] === '}' || source[nextIndex] === ']') {
        output += ' ';
        continue;
      }
    }

    output += char;
  }

  return output;
}

function normalizeWorkspacePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function workspaceMetadata(path, value) {
  return {
    path: normalizeWorkspacePath(path),
    name: value?.name,
    version: value?.version,
  };
}

export function parseBunLockWorkspaces(source) {
  const json = stripTrailingCommas(stripJsonComments(String(source).replace(/^\uFEFF/, '')));
  const lock = JSON.parse(json);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock.workspaces)) {
    throw new TypeError('bun.lock must contain a workspaces object');
  }
  if (!lock.workspaces || typeof lock.workspaces !== 'object') {
    throw new TypeError('bun.lock must contain a workspaces object');
  }

  return Object.entries(lock.workspaces)
    .filter(([path]) => path !== '')
    .map(([path, value]) => workspaceMetadata(path, value));
}

export function findWorkspaceLockDrift(manifestWorkspaces, lockWorkspaces) {
  const expectedByPath = new Map(
    manifestWorkspaces.map(({ path, name, version }) => [
      normalizeWorkspacePath(path),
      { name, version },
    ]),
  );
  const actualByPath = new Map(
    lockWorkspaces.map(({ path, name, version }) => [
      normalizeWorkspacePath(path),
      { name, version },
    ]),
  );
  const drift = [];

  for (const [path, expected] of expectedByPath) {
    const actual = actualByPath.get(path);
    if (!actual) {
      drift.push({ kind: 'missing-workspace', path, expected });
      continue;
    }
    if (expected.name !== actual.name) {
      drift.push({
        kind: 'name-mismatch',
        path,
        expected: expected.name,
        actual: actual.name,
      });
    }
    if (expected.version !== actual.version) {
      drift.push({
        kind: 'version-mismatch',
        path,
        expected: expected.version,
        actual: actual.version,
      });
    }
  }

  for (const [path, actual] of actualByPath) {
    if (!expectedByPath.has(path)) {
      drift.push({ kind: 'unexpected-workspace', path, actual });
    }
  }

  return drift;
}
