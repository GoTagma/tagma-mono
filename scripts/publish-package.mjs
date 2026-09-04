#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageDir = process.cwd();
const dryRun = process.argv.slice(2).includes('--dry-run');
const unknownOption = process.argv.slice(2).find((arg) => arg !== '--dry-run');

if (unknownOption) {
  console.error(`Unknown option: ${unknownOption}`);
  process.exit(1);
}

const packageJsonPath = join(packageDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
if (typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
  console.error(`Invalid package name or version in ${packageJsonPath}`);
  process.exit(1);
}
if (packageJson.private === true) {
  console.error(`Refusing to publish private package ${packageJson.name}`);
  process.exit(1);
}

const stagingDir = resolve(mkdtempSync(join(tmpdir(), 'tagma-npm-publish-')));

function commandFailure(command, result) {
  if (result.error) return `${command} could not start: ${result.error.message}`;
  if (result.signal) return `${command} terminated by ${result.signal}`;
  return `${command} exited with code ${String(result.status)}`;
}

try {
  const packed = spawnSync(
    'bun',
    ['pm', 'pack', '--destination', stagingDir, '--quiet', '--ignore-scripts'],
    {
      cwd: packageDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  if (packed.error || packed.signal || packed.status !== 0) {
    throw new Error(commandFailure('bun pm pack', packed));
  }

  const packedOutput = packed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!packedOutput) throw new Error('bun pm pack did not report a tarball path');

  const tarballPath = resolve(stagingDir, packedOutput);
  const stagedRelativePath = relative(stagingDir, tarballPath);
  if (
    !stagedRelativePath ||
    stagedRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    stagedRelativePath === '..' ||
    isAbsolute(stagedRelativePath) ||
    !existsSync(tarballPath)
  ) {
    throw new Error(`bun pm pack returned an invalid tarball path: ${packedOutput}`);
  }

  console.log(
    `${dryRun ? 'Checking' : 'Publishing'} ${packageJson.name}@${packageJson.version} from ${tarballPath}`,
  );
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const publishArgs = [
    'publish',
    tarballPath,
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const published = spawnSync(npmCommand, publishArgs, {
    cwd: stagingDir,
    stdio: 'inherit',
  });
  if (published.error || published.signal || published.status !== 0) {
    throw new Error(commandFailure('npm publish', published));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
