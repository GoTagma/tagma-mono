import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeBinary, probeEnvVar, runPreflight } from '../server/preflight-requirements';
import {
  parseRequirementsMd,
  requirementsPath,
  serializeRequirementsMd,
} from '../server/requirements-sync';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspace(): { root: string; tagmaDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-preflight-'));
  tempRoots.push(root);
  const tagmaDir = join(root, '.tagma');
  mkdirSync(tagmaDir, { recursive: true });
  return { root, tagmaDir };
}

test('probeBinary resolves a binary that exists in PATH', () => {
  // Both `node` (test runtime) and `bun` (project runtime) are guaranteed to be
  // on PATH wherever this test executes. Use whichever is reachable so the
  // assertion stays valid in both `bun test` and `node --test` runners.
  const reachable =
    probeBinary('bun') ||
    probeBinary('node') ||
    probeBinary(process.platform === 'win32' ? 'cmd' : 'sh');
  expect(reachable).toBe(true);
});

test('probeBinary returns false for a guaranteed-missing name', () => {
  expect(probeBinary('absolutely-not-a-real-cli-tool-9876543210')).toBe(false);
});

test('probeBinary rejects path-shaped names defensively', () => {
  expect(probeBinary('./foo')).toBe(false);
  expect(probeBinary('foo/bar')).toBe(false);
});

test('probeEnvVar honors process.env presence', () => {
  process.env.TAGMA_PREFLIGHT_TEST_VAR = 'present';
  expect(probeEnvVar('TAGMA_PREFLIGHT_TEST_VAR')).toBe(true);
  delete process.env.TAGMA_PREFLIGHT_TEST_VAR;
  expect(probeEnvVar('TAGMA_PREFLIGHT_TEST_VAR')).toBe(false);
});

test('runPreflight reports missing binaries and required env vars', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'pipeline.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: x',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: x',
      '          command: "absolutely-not-a-real-cli-tool-9876543210 --flag"',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Author a requirements.md by hand (skip the watcher-driven generation path).
  writeFileSync(
    requirementsPath(yamlPath),
    serializeRequirementsMd({
      frontmatter: {
        schemaVersion: 1,
        generatedFor: 'pipeline.yaml',
        generatedAt: new Date().toISOString(),
        binaries: [{ name: 'absolutely-not-a-real-cli-tool-9876543210', usedBy: ['main.x'] }],
        env: [
          { name: 'TAGMA_PREFLIGHT_DEFINITELY_UNSET', required: true, description: 'test' },
          { name: 'OPTIONAL_THING', required: false },
        ],
        services: [],
      },
      body: '# x\n',
    }),
    'utf-8',
  );

  delete process.env.TAGMA_PREFLIGHT_DEFINITELY_UNSET;
  const result = runPreflight(yamlPath);
  expect(result.skipped).toBe(false);
  expect(result.missing.binaries).toEqual(['absolutely-not-a-real-cli-tool-9876543210']);
  expect(result.missingBinaryRequirements).toEqual([
    expect.objectContaining({
      name: 'absolutely-not-a-real-cli-tool-9876543210',
      usedBy: ['main.x'],
    }),
  ]);
  expect(result.missing.envs).toEqual(['TAGMA_PREFLIGHT_DEFINITELY_UNSET']);
  expect(result.envKeys).toEqual(['TAGMA_PREFLIGHT_DEFINITELY_UNSET', 'OPTIONAL_THING']);
  expect(result.requirementsPath).toBe(requirementsPath(yamlPath));
});

test('runPreflight passes when every requirement is satisfied', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'pipeline.yaml');
  // A binary that's universally present so the probe succeeds: prefer bun
  // (project runtime), fall back to node, finally to the host shell.
  const knownBinary = probeBinary('bun')
    ? 'bun'
    : probeBinary('node')
      ? 'node'
      : process.platform === 'win32'
        ? 'cmd'
        : 'sh';
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: x',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: x',
      `          command: "${knownBinary} --version"`,
      '',
    ].join('\n'),
    'utf-8',
  );

  process.env.TAGMA_PREFLIGHT_PASSING_VAR = '1';
  writeFileSync(
    requirementsPath(yamlPath),
    serializeRequirementsMd({
      frontmatter: {
        schemaVersion: 1,
        generatedFor: 'pipeline.yaml',
        generatedAt: new Date().toISOString(),
        binaries: [{ name: knownBinary, usedBy: ['main.x'] }],
        env: [{ name: 'TAGMA_PREFLIGHT_PASSING_VAR', required: true }],
        services: [],
      },
      body: '# x\n',
    }),
    'utf-8',
  );

  const result = runPreflight(yamlPath);
  delete process.env.TAGMA_PREFLIGHT_PASSING_VAR;
  expect(result.skipped).toBe(false);
  expect(result.missing.binaries).toEqual([]);
  expect(result.missing.envs).toEqual([]);
  expect(result.envKeys).toEqual(['TAGMA_PREFLIGHT_PASSING_VAR']);
});

test('runPreflight refreshes existing stale binaries before probing', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'stale.yaml');
  const knownBinary = probeBinary('bun')
    ? 'bun'
    : probeBinary('node')
      ? 'node'
      : process.platform === 'win32'
        ? 'cmd'
        : 'sh';
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: stale',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: x',
      `          command: "${knownBinary} --version"`,
      '',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    requirementsPath(yamlPath),
    serializeRequirementsMd({
      frontmatter: {
        schemaVersion: 1,
        generatedFor: 'stale.yaml',
        generatedAt: new Date().toISOString(),
        binaries: [{ name: 'absolutely-not-a-real-cli-tool-9876543210', usedBy: ['old.x'] }],
        env: [],
        services: [],
      },
      body: '# stale\n',
    }),
    'utf-8',
  );

  const result = runPreflight(yamlPath);
  expect(result.skipped).toBe(false);
  expect(result.missing.binaries).toEqual([]);

  const parsed = parseRequirementsMd(readFileSync(requirementsPath(yamlPath), 'utf-8'));
  expect(parsed.frontmatter?.binaries.map((b) => b.name)).toEqual([knownBinary]);
});

test('runPreflight resolves the built-in opencode driver through the managed runtime outside PATH', () => {
  const { root, tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'managed-opencode.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: Managed OpenCode',
      '  tracks:',
      '    - id: review',
      '      name: Review',
      '      tasks:',
      '        - id: check',
      '          prompt: "Check the supplied text"',
      '          driver: opencode',
      '',
    ].join('\n'),
    'utf-8',
  );

  const bundledDir = join(root, 'bundled-opencode');
  const bundledBinDir = join(bundledDir, 'bin');
  mkdirSync(bundledBinDir, { recursive: true });
  writeFileSync(
    join(bundledBinDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
    'managed runtime fixture',
    'utf-8',
  );
  const emptyPathDir = join(root, 'empty-path');
  mkdirSync(emptyPathDir);

  const previousBundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  const previousSkipUserDir = process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
  const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
  const previousPath = process.env[pathKey];
  try {
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env[pathKey] = emptyPathDir;

    const result = runPreflight(yamlPath);

    expect(result.skipped).toBe(false);
    expect(result.missing.binaries).toEqual([]);
    const parsed = parseRequirementsMd(readFileSync(requirementsPath(yamlPath), 'utf-8'));
    expect(parsed.frontmatter?.binaries).toEqual([
      expect.objectContaining({
        name: 'opencode',
        fromDriver: 'opencode',
        usedBy: ['review.check'],
      }),
    ]);
  } finally {
    if (previousBundledDir === undefined) delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
    else process.env.TAGMA_OPENCODE_BUNDLED_DIR = previousBundledDir;
    if (previousSkipUserDir === undefined) delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
    else process.env.TAGMA_OPENCODE_SKIP_USER_DIR = previousSkipUserDir;
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
  }
});

test('runPreflight keeps PATH commands separate from the managed opencode driver', () => {
  const { root, tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'mixed-opencode.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: Mixed OpenCode',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: cli',
      '          command: "opencode --version"',
      '        - id: prompt',
      '          prompt: "Check the supplied text"',
      '          driver: opencode',
      '',
    ].join('\n'),
    'utf-8',
  );

  const bundledDir = join(root, 'bundled-opencode');
  const bundledBinDir = join(bundledDir, 'bin');
  mkdirSync(bundledBinDir, { recursive: true });
  writeFileSync(
    join(bundledBinDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
    'managed runtime fixture',
    'utf-8',
  );
  const emptyPathDir = join(root, 'empty-path');
  mkdirSync(emptyPathDir);

  const previousBundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  const previousSkipUserDir = process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
  const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
  const previousPath = process.env[pathKey];
  try {
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env[pathKey] = emptyPathDir;

    const result = runPreflight(yamlPath);

    expect(result.missing.binaries).toEqual(['opencode']);
    expect(result.missingBinaryRequirements).toEqual([
      expect.objectContaining({
        name: 'opencode',
        usedBy: ['main.cli'],
      }),
    ]);
    expect(result.missingBinaryRequirements[0]).not.toHaveProperty('fromDriver');
    const parsed = parseRequirementsMd(readFileSync(requirementsPath(yamlPath), 'utf-8'));
    expect(parsed.frontmatter?.binaries).toEqual([
      expect.objectContaining({ name: 'opencode', usedBy: ['main.cli'] }),
      expect.objectContaining({
        name: 'opencode',
        fromDriver: 'opencode',
        usedBy: ['main.prompt'],
      }),
    ]);
    expect(parsed.body.match(/^### `opencode`$/gm)).toHaveLength(1);
  } finally {
    if (previousBundledDir === undefined) delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
    else process.env.TAGMA_OPENCODE_BUNDLED_DIR = previousBundledDir;
    if (previousSkipUserDir === undefined) delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
    else process.env.TAGMA_OPENCODE_SKIP_USER_DIR = previousSkipUserDir;
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
  }
});

test('runPreflight does not require PowerShell cmdlets used by output_check', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'select-string.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: Select-String completion',
      '  tracks:',
      '    - id: factcheck',
      '      name: Fact Check',
      '      tasks:',
      '        - id: fact_check',
      '          prompt: "Check the supplied claims"',
      '          completion:',
      '            type: output_check',
      '            check: \'$m = $input | Select-String -Pattern "verdict" -Quiet; if ($m) { exit 0 } else { exit 1 }\'',
      '',
    ].join('\n'),
    'utf-8',
  );

  const result = runPreflight(yamlPath);
  expect(result.missing.binaries).not.toContain('Select-String');

  const parsed = parseRequirementsMd(readFileSync(requirementsPath(yamlPath), 'utf-8'));
  expect(parsed.frontmatter?.binaries.map((binary) => binary.name)).toEqual(['opencode']);
});

test('runPreflight auto-generates the file when missing, then probes', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = join(tagmaDir, 'auto.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: auto',
      '  tracks:',
      '    - id: t',
      '      name: T',
      '      tasks:',
      '        - id: a',
      '          command: "absolutely-not-a-real-cli-tool-9876543210 --flag"',
      '',
    ].join('\n'),
    'utf-8',
  );

  // No requirements.md yet — runPreflight should create one inline, then
  // report the binary missing from PATH.
  const result = runPreflight(yamlPath);
  expect(result.skipped).toBe(false);
  expect(result.missing.binaries).toContain('absolutely-not-a-real-cli-tool-9876543210');
});
