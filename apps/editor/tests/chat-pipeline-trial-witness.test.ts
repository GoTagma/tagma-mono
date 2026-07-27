import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  captureTrialHostWitness,
  prepareTrialHostWitnessInputs,
  safeCaptureTrialHostWitness,
  type PreparedTrialHostWitnessInputs,
} from '../server/chat-pipeline-trial-witness';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `tagma-trial-witness-${label}-`));
  roots.push(root);
  return root;
}

function makeWorkspace(): { root: string; ws: WorkspaceState } {
  const root = makeRoot('workspace');
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  return { root, ws };
}

function prepared(
  root: string,
  overrides: Partial<PreparedTrialHostWitnessInputs> = {},
): PreparedTrialHostWitnessInputs {
  return {
    logicalYamlPath: join(root, '.tagma', 'pipeline', 'pipeline.yaml'),
    binaryNames: [],
    requiredEnvNames: [],
    secretEnv: {},
    pythonEnv: {},
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat pipeline trial host witness', () => {
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

  test('changes for workspace-root inputs but ignores transient Tagma runtime logs', () => {
    const { root, ws } = makeWorkspace();
    const inputPath = join(root, 'external-input.txt');
    const logPath = join(root, '.tagma', 'logs', 'trial.log');
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(inputPath, 'alpha\n', 'utf-8');
    writeFileSync(logPath, 'first transient log\n', 'utf-8');

    const first = captureTrialHostWitness(ws, prepared(root));
    writeFileSync(inputPath, 'beta\n', 'utf-8');
    const second = captureTrialHostWitness(ws, prepared(root));
    expect(second.workspace.digest).not.toBe(first.workspace.digest);
    expect(second.digest).not.toBe(first.digest);

    writeFileSync(logPath, 'second transient log\n', 'utf-8');
    const third = captureTrialHostWitness(ws, prepared(root));
    expect(third.workspace).toEqual(second.workspace);
    expect(third.digest).toBe(second.digest);
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

  test('fails closed when the bounded workspace witness exceeds its byte limit', () => {
    const { root, ws } = makeWorkspace();
    const oversizedPath = join(root, 'oversized.bin');
    writeFileSync(oversizedPath, '', 'utf-8');
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1);

    const result = safeCaptureTrialHostWitness(ws, prepared(root));
    expect(result.witness).toBeNull();
    expect(result.reason).toContain('Workspace witness exceeds 67108864 bytes');
  });
});
