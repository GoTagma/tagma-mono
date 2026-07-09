#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(scriptDir, '..');

export const ELECTRON_PACKAGE_DIR = resolve(electronRoot, 'node_modules', 'electron');
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export function defaultElectronExecutable(platform = process.platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function readTextIfPresent(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function readElectronPackageVersion(electronDir) {
  const raw = readTextIfPresent(join(electronDir, 'package.json'));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function describeElectronRuntimeStatus(
  electronDir = ELECTRON_PACKAGE_DIR,
  env = process.env,
  platform = process.platform,
) {
  const installScript = join(electronDir, 'install.js');
  if (!existsSync(installScript)) {
    return {
      ok: false,
      reason: 'missing-electron-package',
      electronDir,
      installScript,
      binaryPath: null,
    };
  }

  const overrideDist = env.ELECTRON_OVERRIDE_DIST_PATH?.trim();
  const pathFile = join(electronDir, 'path.txt');
  const pathFileValue = readTextIfPresent(pathFile);

  if (overrideDist) {
    const executable = pathFileValue || 'electron';
    const binaryPath = resolve(overrideDist, executable);
    return existsSync(binaryPath)
      ? { ok: true, reason: 'override-runtime-present', electronDir, installScript, binaryPath }
      : {
          ok: false,
          reason: 'missing-override-runtime',
          electronDir,
          installScript,
          binaryPath,
        };
  }

  const fallbackExecutable = defaultElectronExecutable(platform);
  const executable = pathFileValue || fallbackExecutable;
  const binaryPath = join(electronDir, 'dist', executable);

  if (!pathFileValue) {
    return {
      ok: false,
      reason: 'missing-path-file',
      electronDir,
      installScript,
      binaryPath,
    };
  }

  if (!existsSync(binaryPath)) {
    return {
      ok: false,
      reason: 'missing-runtime-binary',
      electronDir,
      installScript,
      binaryPath,
    };
  }

  const expectedVersion = readElectronPackageVersion(electronDir);
  const installedVersion = readTextIfPresent(join(electronDir, 'dist', 'version'))?.replace(/^v/, '');
  if (expectedVersion && installedVersion !== expectedVersion) {
    return {
      ok: false,
      reason: installedVersion ? 'runtime-version-mismatch' : 'missing-runtime-version',
      electronDir,
      installScript,
      binaryPath,
      expectedVersion,
      installedVersion,
    };
  }

  return { ok: true, reason: 'runtime-present', electronDir, installScript, binaryPath };
}

export function installTimeoutMs(env = process.env) {
  const raw = env.TAGMA_ELECTRON_INSTALL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_INSTALL_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_INSTALL_TIMEOUT_MS;
}

function sanitizeProxyValue(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? 'redacted' : '';
      url.password = url.password ? 'redacted' : '';
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, '//<credentials>@');
  }
}

export function proxyEnvSummary(env = process.env) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const set = keys.filter((key) => typeof env[key] === 'string' && env[key]?.trim());
  if (set.length === 0) return 'No HTTP(S) proxy environment variables are set.';
  return `Proxy environment variables are set: ${set
    .map((key) => `${key}=${sanitizeProxyValue(env[key])}`)
    .join(', ')}`;
}

export function electronInstallHint(status, env = process.env) {
  const target = status.binaryPath ? `\nExpected runtime: ${status.binaryPath}` : '';
  return [
    `Electron runtime is not ready (${status.reason}).${target}`,
    proxyEnvSummary(env),
    'Fix options:',
    '  1. If a local proxy is configured but unavailable, clear it and rerun:',
    "     $env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; bun run --filter tagma-desktop ensure:electron",
    '  2. If your network needs a proxy or mirror, set HTTPS_PROXY or ELECTRON_MIRROR, then rerun:',
    '     bun run --filter tagma-desktop ensure:electron',
    '  3. After dependency reinstall, rerun bun install --force if node_modules/electron was left half-installed.',
  ].join('\n');
}

export function ensureElectronRuntime(options = {}) {
  const electronDir = options.electronDir ?? ELECTRON_PACKAGE_DIR;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let status = describeElectronRuntimeStatus(electronDir, env, platform);
  if (status.ok) return status;

  if (!existsSync(status.installScript)) {
    throw new Error(electronInstallHint(status, env));
  }

  console.error(`[electron-runtime] ${status.reason}; running Electron install script...`);
  const timeout = options.timeoutMs ?? installTimeoutMs(env);
  const result = spawnSync(process.execPath, [status.installScript], {
    cwd: electronDir,
    env,
    stdio: options.stdio ?? 'inherit',
    timeout,
    windowsHide: true,
  });

  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    const suffix = timedOut ? `\nElectron install timed out after ${timeout}ms.` : `\n${result.error.message}`;
    throw new Error(`${electronInstallHint(status, env)}${suffix}`);
  }

  if (result.status !== 0) {
    throw new Error(`${electronInstallHint(status, env)}\nElectron install exited with code ${result.status}.`);
  }

  status = describeElectronRuntimeStatus(electronDir, env, platform);
  if (!status.ok) {
    throw new Error(`${electronInstallHint(status, env)}\nElectron install completed but the runtime is still missing.`);
  }

  return status;
}

function runElectron(args) {
  const status = ensureElectronRuntime();
  const child = spawn(status.binaryPath, args.length > 0 ? args : ['.'], {
    cwd: electronRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });

  let childClosed = false;
  child.on('close', (code, signal) => {
    childClosed = true;
    if (code === null) {
      console.error(`${status.binaryPath} exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGUSR2'];
  for (const signal of signals) {
    process.on(signal, () => {
      if (!childClosed) child.kill(signal);
    });
  }
}

function main(argv) {
  const command = argv[2] ?? 'ensure';
  if (command === 'ensure') {
    ensureElectronRuntime();
    return;
  }
  if (command === 'start') {
    runElectron(argv.slice(3));
    return;
  }
  throw new Error(`Unknown electron-runtime command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}