import { existsSync, mkdirSync } from 'node:fs';
import path, { join } from 'node:path';

function pathFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export type PythonSource =
  | 'py-list'
  | 'python-version'
  | 'python3-version'
  | 'which-python3'
  | 'brew'
  | 'linux-bin'
  | 'manual-path';

export interface PythonInterpreter {
  id: string;
  command: string;
  args: string[];
  version: string;
  source: PythonSource;
  default: boolean;
}

export interface PythonCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type PythonCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<PythonCommandResult>;

export interface PythonDetectionResult {
  platform: NodeJS.Platform;
  detected: PythonInterpreter[];
  defaultId: string | null;
  packageManager: 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | null;
  brewAvailable: boolean | null;
  errors: string[];
}

export interface PythonInstallPlan {
  label: string;
  command: string[];
  note: string;
}

export const PYTHON_AGENT_SETTINGS_RELATIVE_VENV = '.tagma/.python-agent/venv';
const DEFAULT_RECOMMENDED_PYTHON_VERSION = '3.13';
const VERSION_RE = /^3\.(?:[0-9]|[1-9][0-9])(?:\.[0-9]+)?$/;

export function parsePythonVersionText(text: string): string | null {
  const match = text.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : null;
}

export function parseWindowsPyList(stdout: string): PythonInterpreter[] {
  const entries: PythonInterpreter[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('-V:')) continue;
    const versionMatch = line.match(/^-V:(3\.\d+(?:\.\d+)?)/u);
    if (!versionMatch) continue;
    const version = versionMatch[1];
    const isDefault = /\*/u.test(line);
    entries.push({
      id: `py-${version}`,
      command: 'py',
      args: [`-${version}`],
      version,
      source: 'py-list',
      default: isDefault,
    });
  }
  return markDefault(entries);
}

function commandId(command: string, args: readonly string[], version: string): string {
  const raw = [command, ...args, version].join(' ');
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

function interpreter(
  command: string,
  args: string[],
  version: string,
  source: PythonSource,
  isDefault = false,
): PythonInterpreter {
  return {
    id: commandId(command, args, version),
    command,
    args,
    version,
    source,
    default: isDefault,
  };
}

function markDefault(entries: PythonInterpreter[]): PythonInterpreter[] {
  if (entries.length === 0) return [];
  if (entries.some((entry) => entry.default)) return entries;
  return entries.map((entry, index) => ({ ...entry, default: index === 0 }));
}

function dedupe(entries: PythonInterpreter[]): PythonInterpreter[] {
  const seen = new Set<string>();
  const unique: PythonInterpreter[] = [];
  for (const entry of entries) {
    const key = `${entry.command}\0${entry.args.join('\0')}\0${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return markDefault(unique);
}

async function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<PythonCommandResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
    Promise.race([proc.exited, timeout]),
  ]);
  if (timer) clearTimeout(timer);
  return {
    exitCode: typeof code === 'number' ? code : 124,
    stdout,
    stderr,
  };
}

async function versionFromCommand(
  run: PythonCommandRunner,
  command: string,
  args: string[],
): Promise<string | null> {
  const result = await run(command, [...args, '--version']);
  if (result.exitCode !== 0) return null;
  return parsePythonVersionText(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

async function detectWindows(
  run: PythonCommandRunner,
  errors: string[],
): Promise<PythonInterpreter[]> {
  const detected: PythonInterpreter[] = [];
  const py = await run('py', ['--list']);
  if (py.exitCode === 0) {
    detected.push(...parseWindowsPyList(py.stdout ?? ''));
  } else {
    errors.push('py --list failed');
  }
  if (detected.length > 0) return detected;

  for (const command of ['python', 'python3']) {
    const version = await versionFromCommand(run, command, []);
    if (version) {
      detected.push(
        interpreter(
          command,
          [],
          version,
          command === 'python' ? 'python-version' : 'python3-version',
          detected.length === 0,
        ),
      );
    }
  }
  return detected;
}

async function detectMac(
  run: PythonCommandRunner,
  errors: string[],
): Promise<{
  entries: PythonInterpreter[];
  brewAvailable: boolean;
}> {
  const entries: PythonInterpreter[] = [];
  const brew = await run('which', ['brew']);
  const brewAvailable = brew.exitCode === 0;
  if (brewAvailable) {
    const list = await run('brew', ['list', '--versions', 'python']);
    if (list.exitCode === 0) {
      for (const line of (list.stdout ?? '').split(/\r?\n/u)) {
        const match = line.match(/python(?:@(\d+\.\d+))?\s+(\d+\.\d+(?:\.\d+)?)/i);
        if (!match) continue;
        const version = match[1] ?? match[2].split('.').slice(0, 2).join('.');
        entries.push(interpreter(`python${version}`, [], version, 'brew', entries.length === 0));
      }
    }
  } else {
    errors.push('Homebrew not detected');
  }

  const which = await run('which', ['-a', 'python3']);
  if (which.exitCode === 0) {
    for (const command of (which.stdout ?? '')
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const version = await versionFromCommand(run, command, []);
      if (version) entries.push(interpreter(command, [], version, 'which-python3'));
    }
  }
  return { entries, brewAvailable };
}

async function detectLinux(run: PythonCommandRunner): Promise<{
  entries: PythonInterpreter[];
  packageManager: 'apt' | 'dnf' | 'pacman' | null;
}> {
  let packageManager: 'apt' | 'dnf' | 'pacman' | null = null;
  for (const candidate of ['apt', 'dnf', 'pacman'] as const) {
    const found = await run('sh', ['-c', `command -v ${candidate} >/dev/null 2>&1`]);
    if (found.exitCode === 0) {
      packageManager = candidate;
      break;
    }
  }

  const entries: PythonInterpreter[] = [];
  const listed = await run('sh', ['-c', 'ls /usr/bin/python3.[0-9]* 2>/dev/null']);
  if (listed.exitCode === 0) {
    for (const command of (listed.stdout ?? '')
      .split(/\s+/u)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const version = await versionFromCommand(run, command, []);
      if (version)
        entries.push(interpreter(command, [], version, 'linux-bin', entries.length === 0));
    }
  }
  return { entries, packageManager };
}

export async function detectPython(
  options: {
    platform?: NodeJS.Platform;
    run?: PythonCommandRunner;
  } = {},
): Promise<PythonDetectionResult> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const errors: string[] = [];
  let detected: PythonInterpreter[] = [];
  let packageManager: PythonDetectionResult['packageManager'] = null;
  let brewAvailable: boolean | null = null;

  if (platform === 'win32') {
    detected = await detectWindows(run, errors);
    packageManager = 'winget';
  } else if (platform === 'darwin') {
    const mac = await detectMac(run, errors);
    detected = mac.entries;
    brewAvailable = mac.brewAvailable;
    packageManager = 'brew';
  } else if (platform === 'linux') {
    const linux = await detectLinux(run);
    detected = linux.entries;
    packageManager = linux.packageManager;
  }

  detected = dedupe(detected);
  return {
    platform,
    detected,
    defaultId: detected.find((entry) => entry.default)?.id ?? null,
    packageManager,
    brewAvailable,
    errors,
  };
}

export async function validatePythonInterpreter(options: {
  command: string;
  args?: string[];
  run?: PythonCommandRunner;
}): Promise<PythonInterpreter> {
  const command = options.command.trim();
  const args = options.args ?? [];
  if (!command) throw new Error('Python command is required');
  if (!args.every((arg) => typeof arg === 'string')) {
    throw new Error('Python command args must be strings');
  }
  const run = options.run ?? defaultRun;
  const version = await versionFromCommand(run, command, args);
  if (!version) throw new Error(`Python interpreter did not report a usable version: ${command}`);
  return interpreter(command, args, version, 'manual-path', true);
}

function normalizeInstallVersion(version: string | null | undefined): string {
  const v = (version ?? DEFAULT_RECOMMENDED_PYTHON_VERSION).trim();
  if (!VERSION_RE.test(v)) {
    throw new Error(`Unsupported Python version: ${version}`);
  }
  return v.split('.').slice(0, 2).join('.');
}

export function buildPythonInstallPlan(
  platform: NodeJS.Platform,
  version?: string,
  linuxManager?: 'apt' | 'dnf' | 'pacman' | null,
): PythonInstallPlan {
  const normalized = normalizeInstallVersion(version);
  if (platform === 'win32') {
    return {
      label: `Install Python ${normalized}`,
      command: ['winget', 'install', '--id', `Python.Python.${normalized}`, '-e'],
      note: 'Runs winget for the selected Python version.',
    };
  }
  if (platform === 'darwin') {
    return {
      label: `Install Python ${normalized}`,
      command: ['brew', 'install', `python@${normalized}`],
      note: 'Requires Homebrew. Install Homebrew first if detection did not find brew.',
    };
  }
  if (platform === 'linux') {
    const manager = linuxManager ?? 'apt';
    if (manager === 'dnf') {
      return {
        label: `Install Python ${normalized}`,
        command: ['sudo', 'dnf', 'install', '-y', `python${normalized}`],
        note: 'Runs dnf for the selected Python version.',
      };
    }
    if (manager === 'pacman') {
      return {
        label: `Install Python ${normalized}`,
        command: ['sudo', 'pacman', '-S', '--needed', 'python'],
        note: 'Arch packages Python as python; version selection is handled by pacman repositories.',
      };
    }
    return {
      label: `Install Python ${normalized}`,
      command: ['sudo', 'apt', 'install', '-y', `python${normalized}`, `python${normalized}-venv`],
      note: 'Runs apt for the selected Python version and venv support.',
    };
  }
  throw new Error(`Unsupported platform for Python install: ${platform}`);
}

export function pythonAgentVenvPath(
  workDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(workDir, PYTHON_AGENT_SETTINGS_RELATIVE_VENV);
}

export function pythonAgentVenvInterpreter(workDir: string, platform = process.platform): string {
  const p = pathFor(platform);
  return platform === 'win32'
    ? p.join(pythonAgentVenvPath(workDir, platform), 'Scripts', 'python.exe')
    : p.join(pythonAgentVenvPath(workDir, platform), 'bin', 'python');
}

export function pythonAgentVenvBinDir(workDir: string, platform = process.platform): string {
  const p = pathFor(platform);
  return platform === 'win32'
    ? p.join(pythonAgentVenvPath(workDir, platform), 'Scripts')
    : p.join(pythonAgentVenvPath(workDir, platform), 'bin');
}

export function prependPathDir(
  env: Record<string, string>,
  dir: string,
  platform = process.platform,
): Record<string, string> {
  const key = platform === 'win32' && typeof process.env.Path === 'string' ? 'Path' : 'PATH';
  const existing =
    platform === 'win32'
      ? (env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? '')
      : (env.PATH ?? process.env.PATH ?? '');
  const sep = platform === 'win32' ? ';' : ':';
  const next = { ...env };
  delete next.Path;
  delete next.PATH;
  next[key] = existing ? `${dir}${sep}${existing}` : dir;
  return next;
}

export function buildPythonAgentRunEnv(
  workDir: string,
  settings: {
    enabled: boolean;
    interpreterCommand: string | null;
    venvPath: string | null;
  },
  platform = process.platform,
): Record<string, string> {
  if (!settings.enabled || !settings.interpreterCommand || !settings.venvPath) return {};
  const venvPath = pythonAgentVenvPath(workDir, platform);
  const pythonPath = pythonAgentVenvInterpreter(workDir, platform);
  const binDir = pythonAgentVenvBinDir(workDir, platform);
  return prependPathDir(
    {
      TAGMA_PYTHON_AGENT_ENABLED: '1',
      TAGMA_PYTHON_AGENT_PYTHON: pythonPath,
      TAGMA_PYTHON_AGENT_VENV: venvPath,
      VIRTUAL_ENV: venvPath,
    },
    binDir,
    platform,
  );
}

export async function ensurePythonAgentVenv(options: {
  workDir: string;
  command: string;
  args?: string[];
  run?: PythonCommandRunner;
  platform?: NodeJS.Platform;
}): Promise<{ venvPath: string; pythonPath: string; created: boolean }> {
  const venvPath = pythonAgentVenvPath(options.workDir, options.platform);
  const pythonPath = pythonAgentVenvInterpreter(options.workDir, options.platform);
  if (existsSync(pythonPath)) {
    return { venvPath, pythonPath, created: false };
  }
  mkdirSync(join(options.workDir, '.tagma', '.python-agent'), { recursive: true });
  const run = options.run ?? defaultRun;
  const result = await run(options.command, [...(options.args ?? []), '-m', 'venv', venvPath], {
    cwd: options.workDir,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create Python virtual environment: ${
        (result.stderr ?? result.stdout ?? '').trim() || `exit ${result.exitCode}`
      }`,
    );
  }
  return { venvPath, pythonPath, created: true };
}
