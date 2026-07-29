import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  captureTrialHostWitness,
  captureTrialHostWitnessAsync,
  disposeTrialWitnessWorker,
  getTrialHostWorkspaceManifestCacheStatsForTests,
  prepareTrialHostWitnessInputs,
  safeCaptureTrialHostWitnessAsync,
  safeCaptureTrialHostWitness,
  trialWorkspaceWitnessScopeIssue,
  type PreparedTrialHostWitnessInputs,
} from '../server/chat-pipeline-trial-witness';
import { hashChatPipelineTrialTree } from '../server/chat-yaml-staging';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];
const workspaces: WorkspaceState[] = [];
const GIT_WITNESS_TEST_TIMEOUT_MS = 15_000;
setDefaultTimeout(GIT_WITNESS_TEST_TIMEOUT_MS);

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `tagma-trial-witness-${label}-`));
  roots.push(root);
  return root;
}

function makeWorkspace(): { root: string; ws: WorkspaceState } {
  const root = makeRoot('workspace');
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  workspaces.push(ws);
  return { root, ws };
}

function prepared(
  root: string,
  overrides: Partial<PreparedTrialHostWitnessInputs> = {},
): PreparedTrialHostWitnessInputs {
  return {
    logicalYamlPath: join(root, '.tagma', 'pipeline', 'pipeline.yaml'),
    binaryNames: [],
    driverNames: [],
    requiredEnvNames: [],
    secretEnv: {},
    pythonEnv: {},
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function populateLargeWitnessWorkspace(root: string): void {
  const manyFilesRoot = join(root, 'many-files');
  mkdirSync(manyFilesRoot, { recursive: true });
  for (let index = 0; index <= 4_000; index += 1) {
    writeFileSync(join(manyFilesRoot, `${String(index).padStart(4, '0')}.txt`), 'payload\n');
  }
  const oversizedPath = join(root, 'oversized.bin');
  writeFileSync(oversizedPath, '', 'utf-8');
  truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);
}

function runGit(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    disposeTrialWitnessWorker(ws);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}, 300_000);

describe('chat pipeline trial host witness', () => {
  test('refuses filesystem roots before a full-filesystem witness can recurse', () => {
    for (const workspaceRoot of [
      'F:\\',
      'f:/',
      '\\\\build-server\\workspace-share\\',
      '\\\\?\\F:\\',
      '\\\\?\\UNC\\build-server\\workspace-share\\',
    ]) {
      const issue = trialWorkspaceWitnessScopeIssue(workspaceRoot);
      expect(issue).toContain(workspaceRoot);
      expect(issue).toContain('entire volume or network share');
      expect(issue).toContain('narrower project directory');
    }
  });

  test('allows ordinary filesystem workspace directories without probing their contents', () => {
    expect(trialWorkspaceWitnessScopeIssue('F:\\projects\\quick-demo')).toBeNull();
    expect(
      trialWorkspaceWitnessScopeIssue('\\\\build-server\\workspace-share\\quick-demo'),
    ).toBeNull();
    expect(trialWorkspaceWitnessScopeIssue(join(tmpdir(), 'tagma-project'))).toBeNull();
  });

  test(
    'uses source files and dependency descriptors instead of Git and dependency caches',
    () => {
      const { root, ws } = makeWorkspace();
      runGit(root, 'init', '--quiet');
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n.tagma/\nbun.lock\n', 'utf-8');
      writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n', 'utf-8');
      writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n', 'utf-8');
      writeFileSync(join(root, 'bun.lock'), 'lockfile-v1\n', 'utf-8');
      runGit(root, 'add', '.gitignore', 'source.ts', 'package.json');

      const dependencyPath = join(root, 'node_modules', 'fixture', 'index.js');
      const runtimeCachePath = join(root, '.tagma', '.opencode-runtime', 'cache.bin');
      mkdirSync(dirname(dependencyPath), { recursive: true });
      mkdirSync(dirname(runtimeCachePath), { recursive: true });
      writeFileSync(dependencyPath, 'dependency-v1\n', 'utf-8');
      writeFileSync(runtimeCachePath, 'runtime-v1\n', 'utf-8');

      const first = captureTrialHostWitness(ws, prepared(root));
      writeFileSync(join(root, '.git', 'witness-noise'), 'git metadata churn\n', 'utf-8');
      writeFileSync(dependencyPath, 'dependency-v2\n', 'utf-8');
      writeFileSync(runtimeCachePath, 'runtime-v2\n', 'utf-8');
      const cacheOnlyChanges = captureTrialHostWitness(ws, prepared(root));
      expect(cacheOnlyChanges.workspace).toEqual(first.workspace);

      writeFileSync(join(root, 'bun.lock'), 'lockfile-v2\n', 'utf-8');
      const dependencyIdentityChange = captureTrialHostWitness(ws, prepared(root));
      expect(dependencyIdentityChange.workspace.digest).not.toBe(first.workspace.digest);
    },
    GIT_WITNESS_TEST_TIMEOUT_MS,
  );

  test(
    'includes authored Tagma files while excluding generated OpenCode runtime state',
    () => {
      const { root, ws } = makeWorkspace();
      runGit(root, 'init', '--quiet');
      writeFileSync(join(root, '.gitignore'), '.tagma/\n', 'utf-8');
      writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
      runGit(root, 'add', '.gitignore', 'source.txt');

      const authoredPath = join(root, '.tagma', 'pipeline', 'pipeline.yaml');
      const runtimePath = join(root, '.tagma', '.opencode-runtime', 'cache.bin');
      mkdirSync(dirname(authoredPath), { recursive: true });
      mkdirSync(dirname(runtimePath), { recursive: true });
      writeFileSync(authoredPath, 'pipeline-v1\n', 'utf-8');
      writeFileSync(runtimePath, 'runtime-v1\n', 'utf-8');

      const first = captureTrialHostWitness(ws, prepared(root));
      writeFileSync(runtimePath, 'runtime-v2\n', 'utf-8');
      const runtimeOnlyChange = captureTrialHostWitness(ws, prepared(root));
      expect(runtimeOnlyChange.workspace).toEqual(first.workspace);

      writeFileSync(authoredPath, 'pipeline-v2\n', 'utf-8');
      const authoredChange = captureTrialHostWitness(ws, prepared(root));
      expect(authoredChange.workspace.digest).not.toBe(first.workspace.digest);
    },
    GIT_WITNESS_TEST_TIMEOUT_MS,
  );

  test(
    'fails closed while Git repository control files are locked',
    () => {
      const { root, ws } = makeWorkspace();
      runGit(root, 'init', '--quiet');
      writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
      runGit(root, 'add', 'source.txt');
      writeFileSync(join(root, '.git', 'index.lock'), 'in-progress transaction\n', 'utf-8');

      const captured = safeCaptureTrialHostWitness(ws, prepared(root));
      expect(captured.witness).toBeNull();
      expect(captured.reason).toContain('lock');
    },
    GIT_WITNESS_TEST_TIMEOUT_MS,
  );

  test(
    'fails closed while a nested Git reference is locked',
    () => {
      const { root, ws } = makeWorkspace();
      runGit(root, 'init', '--quiet');
      writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
      runGit(root, 'add', 'source.txt');
      const refLockPath = join(root, '.git', 'refs', 'heads', 'main.lock');
      mkdirSync(dirname(refLockPath), { recursive: true });
      writeFileSync(refLockPath, 'in-progress ref transaction\n', 'utf-8');

      const captured = safeCaptureTrialHostWitness(ws, prepared(root));
      expect(captured.witness).toBeNull();
      expect(captured.reason).toContain('lock');
    },
    GIT_WITNESS_TEST_TIMEOUT_MS,
  );

  test(
    'fails closed when Git is unavailable for a repository workspace',
    () => {
      const { root, ws } = makeWorkspace();
      runGit(root, 'init', '--quiet');
      writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
      runGit(root, 'add', 'source.txt');
      const emptyPathRoot = makeRoot('empty-path');
      const pathKeys = [
        ...new Set([
          ...Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH'),
          'PATH',
          'Path',
          'path',
        ]),
      ];
      const originals = pathKeys.map((key) => [key, process.env[key]] as const);
      let captured: ReturnType<typeof safeCaptureTrialHostWitness>;
      try {
        for (const key of pathKeys) process.env[key] = emptyPathRoot;
        captured = safeCaptureTrialHostWitness(ws, prepared(root));
      } finally {
        for (const [key, value] of originals) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      expect(captured!.witness).toBeNull();
      expect(captured!.reason).toContain('could not resolve git');
    },
    GIT_WITNESS_TEST_TIMEOUT_MS,
  );

  test('fails closed for an undeclared nested Git repository', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    const nestedRoot = join(root, 'nested');
    mkdirSync(nestedRoot, { recursive: true });
    runGit(nestedRoot, 'init', '--quiet');
    writeFileSync(join(nestedRoot, 'source.txt'), 'nested source\n', 'utf-8');

    const captured = safeCaptureTrialHostWitness(ws, prepared(root));
    expect(captured.witness).toBeNull();
    expect(captured.reason).toContain('nested repositories');
  });

  test('invalidates when Git skip-worktree state changes', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
    runGit(root, 'add', 'source.txt');
    const first = captureTrialHostWitness(ws, prepared(root));

    runGit(root, 'update-index', '--skip-worktree', 'source.txt');
    const sparse = captureTrialHostWitness(ws, prepared(root));
    expect(sparse.workspace.digest).not.toBe(first.workspace.digest);
  });
  test('invalidates when Git source-scope configuration changes', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
    runGit(root, 'add', 'source.txt');
    const first = captureTrialHostWitness(ws, prepared(root));

    writeFileSync(join(root, '.git', 'info', 'exclude'), 'future-only.tmp\n', 'utf-8');
    const changedScope = captureTrialHostWitness(ws, prepared(root));
    expect(changedScope.workspace.digest).not.toBe(first.workspace.digest);
  });

  test('distinguishes dirty and staged Git state for identical worktree bytes', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    writeFileSync(join(root, 'source.txt'), 'source-v1\n', 'utf-8');
    runGit(root, 'add', 'source.txt');
    writeFileSync(join(root, 'source.txt'), 'source-v2\n', 'utf-8');
    const dirty = captureTrialHostWitness(ws, prepared(root));

    runGit(root, 'add', 'source.txt');
    const staged = captureTrialHostWitness(ws, prepared(root));
    expect(staged.workspace.digest).not.toBe(dirty.workspace.digest);
    expect(staged.workspace.fileCount).toBe(dirty.workspace.fileCount);
  });

  test('prepares required binaries and environment from the staged requirements file', () => {
    const { root, ws } = makeWorkspace();
    const sourcePath = join(root, '.tagma', 'pipeline', 'pipeline.yaml');
    const stagedPath = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage',
      'agent-workspace',
      '.tagma',
      'pipeline',
      'pipeline.yaml',
    );
    mkdirSync(dirname(sourcePath), { recursive: true });
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(sourcePath, 'pipeline:\n  name: Source\n  tracks: []\n', 'utf-8');
    writeFileSync(stagedPath, 'pipeline:\n  name: Staged\n  tracks: []\n', 'utf-8');

    const envName = `TAGMA_TRIAL_WITNESS_REQUIRED_${process.pid}`;
    const binaryName = `tagma-trial-witness-binary-${process.pid}`;
    writeFileSync(
      stagedPath.replace(/\.ya?ml$/i, '.requirements.md'),
      [
        '---',
        'schemaVersion: 1',
        'generatedFor: pipeline.yaml',
        'generatedAt: 2026-07-27T00:00:00.000Z',
        'binaries:',
        `  - name: ${binaryName}`,
        '    usedBy: [main.task]',
        'env:',
        `  - name: ${envName}`,
        '    required: true',
        'services: []',
        '---',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = prepareTrialHostWitnessInputs(ws, {
      relativePath: 'pipeline/pipeline.yaml',
      sourcePath,
      stagedYamlPath: stagedPath,
    });
    expect(result.binaryNames).toEqual([binaryName]);
    expect(result.requiredEnvNames).toEqual([envName]);

    const missing = safeCaptureTrialHostWitness(ws, {
      ...result,
      binaryNames: [],
    });
    expect(missing.witness).toBeNull();
    expect(missing.reason).toContain(envName);

    const secretValue = 'required-value-that-must-not-be-serialized';
    const captured = captureTrialHostWitness(ws, {
      ...result,
      binaryNames: [],
      secretEnv: { ...result.secretEnv, [envName]: secretValue },
    });
    expect(captured.requiredEnv).toEqual([{ name: envName, sha256: sha256(secretValue) }]);
    expect(JSON.stringify(captured)).not.toContain(secretValue);
  });

  test('hashes requirements execution semantics while ignoring generated metadata', () => {
    const root = makeRoot('requirements-hash');
    const yamlPath = join(root, 'pipeline.yaml');
    const requirementsPath = join(root, 'pipeline.requirements.md');
    writeFileSync(yamlPath, 'pipeline:\n  name: Requirements Hash\n  tracks: []\n', 'utf-8');
    const requirements = (generatedAt: string, envName: string) =>
      [
        '---',
        'schemaVersion: 1',
        'generatedFor: pipeline.yaml',
        `generatedAt: ${generatedAt}`,
        'binaries: []',
        'env:',
        `  - name: ${envName}`,
        '    required: true',
        'services: []',
        '---',
        '',
        '# Runtime requirements',
        '',
      ].join('\n');

    writeFileSync(
      requirementsPath,
      requirements('2026-07-27T00:00:00.000Z', 'FIRST_REQUIRED_ENV'),
      'utf-8',
    );
    const first = hashChatPipelineTrialTree(root);
    writeFileSync(
      requirementsPath,
      requirements('2026-07-27T00:00:01.000Z', 'FIRST_REQUIRED_ENV'),
      'utf-8',
    );
    const metadataOnly = hashChatPipelineTrialTree(root);
    expect(metadataOnly).toBe(first);

    writeFileSync(
      requirementsPath,
      requirements('2026-07-27T00:00:02.000Z', 'SECOND_REQUIRED_ENV'),
      'utf-8',
    );
    const envChanged = hashChatPipelineTrialTree(root);
    expect(envChanged).not.toBe(first);

    writeFileSync(
      requirementsPath,
      [
        '---',
        'schemaVersion: 1',
        'generatedFor: pipeline.yaml',
        'generatedAt: 2026-07-27T00:00:03.000Z',
        'binaries:',
        '  - name: bun',
        '    usedBy: [main.task]',
        'env:',
        '  - name: SECOND_REQUIRED_ENV',
        '    required: true',
        'services: []',
        '---',
        '',
        '# Runtime requirements',
        '',
      ].join('\n'),
      'utf-8',
    );
    const binariesChanged = hashChatPipelineTrialTree(root);
    expect(binariesChanged).not.toBe(envChanged);

    writeFileSync(
      requirementsPath,
      [
        '---',
        'schemaVersion: 1',
        'generatedFor: pipeline.yaml',
        'generatedAt: 2026-07-27T00:00:04.000Z',
        'binaries:',
        '  - name: bun',
        '    usedBy: [main.task]',
        'env:',
        '  - name: SECOND_REQUIRED_ENV',
        '    required: true',
        'services: []',
        '---',
        '',
        '# Runtime requirements',
        '',
        'Body changed.',
      ].join('\n'),
      'utf-8',
    );
    expect(hashChatPipelineTrialTree(root)).not.toBe(binariesChanged);
  });

  test('hashes non-requirements files by raw bytes instead of UTF-8-decoded text', () => {
    const root = makeRoot('raw-bytes-hash');
    const helperPath = join(root, 'helper.bin');
    writeFileSync(helperPath, Buffer.from([0xc3, 0x28]));
    const first = hashChatPipelineTrialTree(root);
    writeFileSync(helperPath, Buffer.from([0xe2, 0x28]));
    const second = hashChatPipelineTrialTree(root);
    expect(second).not.toBe(first);
  });

  test('changes for workspace-root inputs but ignores transient Tagma runtime logs', () => {
    const { root, ws } = makeWorkspace();
    const inputPath = join(root, 'external-input.txt');
    const logPath = join(root, '.tagma', 'logs', 'trial.log');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(inputPath, 'alpha\n', 'utf-8');
    writeFileSync(logPath, 'first transient log\n', 'utf-8');

    const first = captureTrialHostWitness(ws, prepared(root));
    const originalStat = statSync(inputPath);
    writeFileSync(inputPath, 'beta\n', 'utf-8');
    utimesSync(inputPath, originalStat.atime, originalStat.mtime);
    const second = captureTrialHostWitness(ws, prepared(root));
    expect(second.workspace.digest).not.toBe(first.workspace.digest);
    expect(second.digest).not.toBe(first.digest);

    writeFileSync(logPath, 'second transient log\n', 'utf-8');
    const third = captureTrialHostWitness(ws, prepared(root));
    expect(third.workspace).toEqual(second.workspace);
    expect(third.digest).toBe(second.digest);
  });

  test('tracks add, delete, and rename operations across cached workspace manifests', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    const originalPath = join(root, 'original.txt');
    const renamedPath = join(root, 'renamed.txt');
    const addedPath = join(root, 'added.txt');
    writeFileSync(originalPath, 'original\n', 'utf-8');
    runGit(root, 'add', 'original.txt');

    const original = captureTrialHostWitness(ws, prepared(root));
    renameSync(originalPath, renamedPath);
    const renamed = captureTrialHostWitness(ws, prepared(root));
    expect(renamed.workspace.digest).not.toBe(original.workspace.digest);
    expect(renamed.workspace.fileCount).toBe(original.workspace.fileCount);

    writeFileSync(addedPath, 'added\n', 'utf-8');
    const added = captureTrialHostWitness(ws, prepared(root));
    expect(added.workspace.digest).not.toBe(renamed.workspace.digest);
    expect(added.workspace.fileCount).toBe(renamed.workspace.fileCount + 1);

    unlinkSync(addedPath);
    const deleted = captureTrialHostWitness(ws, prepared(root));
    expect(deleted.workspace).toEqual(renamed.workspace);

    renameSync(renamedPath, originalPath);
    const restored = captureTrialHostWitness(ws, prepared(root));
    expect(restored.workspace).toEqual(original.workspace);
  });

  test('witnesses internal file and directory symlinks and invalidates retargets', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    const firstTargetRoot = join(root, 'target-a');
    const secondTargetRoot = join(root, 'target-b');
    mkdirSync(firstTargetRoot, { recursive: true });
    mkdirSync(secondTargetRoot, { recursive: true });
    const firstFile = join(firstTargetRoot, 'same.txt');
    const secondFile = join(secondTargetRoot, 'same.txt');
    writeFileSync(firstFile, 'same content\n', 'utf-8');
    writeFileSync(secondFile, 'same content\n', 'utf-8');
    const fileLink = join(root, 'file-link.txt');
    const directoryLink = join(root, 'directory-link');
    symlinkSync(firstFile, fileLink, 'file');
    symlinkSync(firstTargetRoot, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');

    const first = captureTrialHostWitness(ws, prepared(root));
    unlinkSync(fileLink);
    unlinkSync(directoryLink);
    symlinkSync(secondFile, fileLink, 'file');
    symlinkSync(secondTargetRoot, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
    const second = captureTrialHostWitness(ws, prepared(root));
    expect(second.workspace.digest).not.toBe(first.workspace.digest);
  });

  test('rejects external, broken, and transient-target workspace symlinks', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    const linkPath = join(root, 'unsafe-link');
    const externalRoot = makeRoot('external-link-target');
    const externalFile = join(externalRoot, 'outside.txt');
    writeFileSync(externalFile, 'outside\n', 'utf-8');

    symlinkSync(externalFile, linkPath, 'file');
    const external = safeCaptureTrialHostWitness(ws, prepared(root));
    expect(external.witness).toBeNull();
    expect(external.reason).toContain('outside the workspace');
    unlinkSync(linkPath);

    symlinkSync(join(root, 'missing.txt'), linkPath, 'file');
    const broken = safeCaptureTrialHostWitness(ws, prepared(root));
    expect(broken.witness).toBeNull();
    expect(broken.reason).toContain('target is unavailable');
    unlinkSync(linkPath);

    const excludedTarget = join(root, '.tagma', 'logs');
    mkdirSync(excludedTarget, { recursive: true });
    writeFileSync(join(excludedTarget, 'trial.log'), 'transient\n', 'utf-8');
    symlinkSync(excludedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const excluded = safeCaptureTrialHostWitness(ws, prepared(root));
    expect(excluded.witness).toBeNull();
    expect(excluded.reason).toContain('excluded workspace path');
  });

  test('reuses unchanged workspace content hashes from the in-process manifest cache', () => {
    const { root, ws } = makeWorkspace();
    writeFileSync(join(root, 'first.txt'), 'first\n', 'utf-8');
    writeFileSync(join(root, 'second.txt'), 'second\n', 'utf-8');

    const first = captureTrialHostWitness(ws, prepared(root));
    const coldStats = getTrialHostWorkspaceManifestCacheStatsForTests(ws);
    expect(coldStats).toEqual({
      fileCount: first.workspace.fileCount,
      totalBytes: first.workspace.totalBytes,
      hashedFileCount: first.workspace.fileCount,
      hashedBytes: first.workspace.totalBytes,
      reusedFileCount: 0,
    });

    const second = captureTrialHostWitness(ws, prepared(root));
    const warmStats = getTrialHostWorkspaceManifestCacheStatsForTests(ws);
    expect(second.workspace).toEqual(first.workspace);
    expect(warmStats).toEqual({
      fileCount: second.workspace.fileCount,
      totalBytes: second.workspace.totalBytes,
      hashedFileCount: 0,
      hashedBytes: 0,
      reusedFileCount: second.workspace.fileCount,
    });
  });

  test('recomputes Git source contents for a fresh workspace state', () => {
    const { root, ws } = makeWorkspace();
    runGit(root, 'init', '--quiet');
    writeFileSync(join(root, 'source.txt'), 'source\n', 'utf-8');
    runGit(root, 'add', 'source.txt');
    const first = captureTrialHostWitness(ws, prepared(root));

    const restartedWs = new WorkspaceState(root);
    restartedWs.workDir = root;
    const restarted = captureTrialHostWitness(restartedWs, prepared(root));
    const restartedStats = getTrialHostWorkspaceManifestCacheStatsForTests(restartedWs);

    expect(restarted.workspace).toEqual(first.workspace);
    expect(restartedStats).toEqual({
      fileCount: restarted.workspace.fileCount,
      totalBytes: restarted.workspace.totalBytes,
      hashedFileCount: restarted.workspace.fileCount,
      hashedBytes: restarted.workspace.totalBytes,
      reusedFileCount: 0,
    });
  });

  test('captures large host witnesses without blocking the main event loop', async () => {
    const { root, ws } = makeWorkspace();
    populateLargeWitnessWorkspace(root);

    let settled = false;
    const capturePromise = captureTrialHostWitnessAsync(ws, prepared(root)).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBeFalse();

    const witness = await capturePromise;
    expect(witness.workspace.fileCount).toBeGreaterThan(4_000);
    expect(witness.workspace.totalBytes).toBeGreaterThan(64 * 1024 * 1024);
  }, 300_000);

  test('aborts async host witness capture and leaves no warm-cache residue', async () => {
    const { root, ws } = makeWorkspace();
    populateLargeWitnessWorkspace(root);

    const controller = new AbortController();
    const capturePromise = safeCaptureTrialHostWitnessAsync(ws, prepared(root), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const aborted = await capturePromise;
    expect(aborted.witness).toBeNull();
    expect(aborted.reason?.toLowerCase()).toContain('abort');
    expect(getTrialHostWorkspaceManifestCacheStatsForTests(ws)).toBeNull();

    const retried = await safeCaptureTrialHostWitnessAsync(ws, prepared(root));
    expect(retried.witness?.workspace.fileCount).toBeGreaterThan(4_000);
  }, 300_000);

  test('reuses unchanged workspace content hashes across async worker captures', async () => {
    const { root, ws } = makeWorkspace();
    writeFileSync(join(root, 'first.txt'), 'first\n', 'utf-8');
    writeFileSync(join(root, 'second.txt'), 'second\n', 'utf-8');

    const first = await captureTrialHostWitnessAsync(ws, prepared(root));
    const coldStats = getTrialHostWorkspaceManifestCacheStatsForTests(ws);
    expect(coldStats).toEqual({
      fileCount: first.workspace.fileCount,
      totalBytes: first.workspace.totalBytes,
      hashedFileCount: first.workspace.fileCount,
      hashedBytes: first.workspace.totalBytes,
      reusedFileCount: 0,
    });

    const second = await captureTrialHostWitnessAsync(ws, prepared(root));
    const warmStats = getTrialHostWorkspaceManifestCacheStatsForTests(ws);
    expect(second.workspace).toEqual(first.workspace);
    expect(warmStats).toEqual({
      fileCount: second.workspace.fileCount,
      totalBytes: second.workspace.totalBytes,
      hashedFileCount: 0,
      hashedBytes: 0,
      reusedFileCount: second.workspace.fileCount,
    });
  });

  test('fingerprints minimal environment values and resolved binary contents', () => {
    const { root, ws } = makeWorkspace();
    const binRoot = makeRoot('bin');
    const binaryName = `tagma-witness-tool-${process.pid}`;
    const binaryPath = join(
      binRoot,
      process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
    );
    writeFileSync(binaryPath, 'binary-v1\n', 'utf-8');

    const pathKey =
      process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
    const originalPath = process.env[pathKey];
    process.env[pathKey] = binRoot;
    try {
      const first = captureTrialHostWitness(
        ws,
        prepared(root, { binaryNames: [binaryName], secretEnv: { HOME: 'home-v1' } }),
      );
      expect(first.binaries).toHaveLength(1);
      expect(
        process.platform === 'win32'
          ? first.binaries[0]?.identity.path.toLowerCase()
          : first.binaries[0]?.identity.path,
      ).toBe(process.platform === 'win32' ? binaryPath.toLowerCase() : binaryPath);
      expect(first.minimalEnv.find((entry) => entry.name === 'HOME')).toEqual({
        name: 'HOME',
        sha256: sha256('home-v1'),
      });

      writeFileSync(binaryPath, 'binary-v2\n', 'utf-8');
      const second = captureTrialHostWitness(
        ws,
        prepared(root, { binaryNames: [binaryName], secretEnv: { HOME: 'home-v2' } }),
      );
      expect(second.binaries[0]?.identity.sha256).not.toBe(first.binaries[0]?.identity.sha256);
      expect(second.minimalEnv.find((entry) => entry.name === 'HOME')?.sha256).toBe(
        sha256('home-v2'),
      );
      expect(second.digest).not.toBe(first.digest);
    } finally {
      if (originalPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = originalPath;
    }
  });

  test('fingerprints the actual editor OpenCode driver binary in addition to PATH lookup', () => {
    const { root, ws } = makeWorkspace();
    const pathRoot = makeRoot('opencode-path');
    const bundledRoot = makeRoot('opencode-bundled');
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const pathBinary = join(pathRoot, executableName);
    const bundledBinary = join(bundledRoot, 'bin', executableName);
    mkdirSync(dirname(bundledBinary), { recursive: true });
    writeFileSync(pathBinary, 'path-opencode\n', 'utf-8');
    writeFileSync(bundledBinary, 'bundled-opencode-v1\n', 'utf-8');

    const pathKey =
      process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
    const originalPath = process.env[pathKey];
    const originalBundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
    const originalSkipUserDir = process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
    process.env[pathKey] = pathRoot;
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledRoot;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    try {
      const first = captureTrialHostWitness(
        ws,
        prepared(root, { binaryNames: ['opencode'], driverNames: ['opencode'] }),
      );
      const pathWitness = first.binaries.find((entry) => entry.name === 'opencode');
      const driverWitness = first.binaries.find((entry) => entry.name === 'driver:opencode');
      expect(pathWitness?.identity.path.toLowerCase()).toBe(pathBinary.toLowerCase());
      expect(driverWitness?.identity.path.toLowerCase()).toBe(bundledBinary.toLowerCase());

      writeFileSync(bundledBinary, 'bundled-opencode-v2\n', 'utf-8');
      const second = captureTrialHostWitness(
        ws,
        prepared(root, { binaryNames: ['opencode'], driverNames: ['opencode'] }),
      );
      expect(second.binaries.find((entry) => entry.name === 'opencode')?.identity.sha256).toBe(
        pathWitness?.identity.sha256,
      );
      expect(
        second.binaries.find((entry) => entry.name === 'driver:opencode')?.identity.sha256,
      ).not.toBe(driverWitness?.identity.sha256);
      expect(second.prerequisiteDigest).not.toBe(first.prerequisiteDigest);
    } finally {
      if (originalPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = originalPath;
      if (originalBundledDir === undefined) delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
      else process.env.TAGMA_OPENCODE_BUNDLED_DIR = originalBundledDir;
      if (originalSkipUserDir === undefined) delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
      else process.env.TAGMA_OPENCODE_SKIP_USER_DIR = originalSkipUserDir;
    }
  });
  test('fingerprints Python interpreter and virtual-environment configuration contents', () => {
    const { root, ws } = makeWorkspace();
    const venvRoot = makeRoot('venv');
    const interpreterPath = join(venvRoot, process.platform === 'win32' ? 'python.exe' : 'python');
    const configPath = join(venvRoot, 'pyvenv.cfg');
    writeFileSync(interpreterPath, 'interpreter-v1\n', 'utf-8');
    writeFileSync(configPath, 'home = python-v1\n', 'utf-8');
    const pythonEnv = {
      TAGMA_PYTHON_AGENT_VENV: venvRoot,
      TAGMA_PYTHON_AGENT_PYTHON: interpreterPath,
      VIRTUAL_ENV: venvRoot,
    };

    const first = captureTrialHostWitness(ws, prepared(root, { pythonEnv }));
    expect(first.python?.interpreter.sha256).toBe(sha256(readFileSync(interpreterPath, 'utf-8')));

    writeFileSync(configPath, 'home = python-v2\n', 'utf-8');
    const second = captureTrialHostWitness(ws, prepared(root, { pythonEnv }));
    expect(second.python?.pyvenvCfg?.sha256).not.toBe(first.python?.pyvenvCfg?.sha256);

    writeFileSync(interpreterPath, 'interpreter-v2\n', 'utf-8');
    const third = captureTrialHostWitness(ws, prepared(root, { pythonEnv }));
    expect(third.python?.interpreter.sha256).not.toBe(second.python?.interpreter.sha256);
    expect(third.digest).not.toBe(second.digest);
  });

  test('streams workspaces above the former file-count and byte limits', () => {
    const { root, ws } = makeWorkspace();
    const manyFilesRoot = join(root, 'many-files');
    mkdirSync(manyFilesRoot, { recursive: true });
    for (let index = 0; index <= 4_000; index += 1) {
      writeFileSync(join(manyFilesRoot, `${String(index).padStart(4, '0')}.txt`), '');
    }
    const oversizedPath = join(root, 'oversized.bin');
    writeFileSync(oversizedPath, '', 'utf-8');
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);

    const witness = captureTrialHostWitness(ws, prepared(root));
    expect(witness.workspace.fileCount).toBeGreaterThan(4_000);
    expect(witness.workspace.totalBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(witness.workspace.digest).toHaveLength(64);
  }, 300_000);

  test('streams binary identities above the former 64 MiB limit', () => {
    const { root, ws } = makeWorkspace();
    const binRoot = makeRoot('large-bin');
    const binaryName = `tagma-large-witness-tool-${process.pid}`;
    const binaryPath = join(
      binRoot,
      process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
    );
    writeFileSync(binaryPath, '');
    truncateSync(binaryPath, 64 * 1024 * 1024 + 1);

    const pathKey =
      process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH';
    const originalPath = process.env[pathKey];
    process.env[pathKey] = binRoot;
    try {
      const witness = captureTrialHostWitness(ws, prepared(root, { binaryNames: [binaryName] }));
      expect(witness.binaries[0]?.identity.size).toBe(64 * 1024 * 1024 + 1);
      expect(witness.binaries[0]?.identity.sha256).toHaveLength(64);
    } finally {
      if (originalPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = originalPath;
    }
  });
});
