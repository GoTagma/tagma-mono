import { dirname, isAbsolute, resolve, relative, parse as parsePath, sep } from 'path';
import { realpathSync, lstatSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';

const DURATION_RE = /^(\d*\.?\d+)\s*(s|m|h|d)$/;
const MAX_TIMER_DURATION_MS = 2_147_483_647;
export const RUN_ID_RE = /^run_[A-Za-z0-9_-]{1,128}$/;

export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${input}". Expected format: <number>(s|m|h|d)`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  const ms = (() => {
    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60_000;
      case 'h':
        return value * 3_600_000;
      case 'd':
        return value * 86_400_000;
      default:
        throw new Error(`Unknown duration unit: "${unit}"`);
    }
  })();
  if (!Number.isFinite(ms) || ms > MAX_TIMER_DURATION_MS) {
    throw new Error(
      `Invalid duration "${input}": exceeds maximum supported timer value of ${MAX_TIMER_DURATION_MS}ms`,
    );
  }
  return ms;
}

export function validatePath(filePath: string, projectRoot: string): string {
  const resolved = resolve(projectRoot, filePath);
  const resolvedRoot = resolve(projectRoot);

  // D2: Cross-drive check (Windows) — path.relative('C:\\root', 'D:\\x') returns
  // 'D:\\x' which does NOT start with '..', so a pure relative check would wrongly
  // allow cross-drive paths. Reject them explicitly before any further comparison.
  if (parsePath(resolvedRoot).root.toLowerCase() !== parsePath(resolved).root.toLowerCase()) {
    throw new Error(
      `Security: path "${filePath}" is on a different drive than the project root "${projectRoot}".`,
    );
  }

  const rel = relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `Security: path "${filePath}" escapes project root. ` +
        `All file references must be within "${projectRoot}".`,
    );
  }

  // D1: Resolve symlinks and re-validate so a symlink whose string path is
  // inside the project root but whose target lies outside is rejected. For
  // future output paths, resolve the nearest existing parent so a symlinked
  // parent cannot hide an escape before the final file exists.
  const realRoot = (() => {
    try {
      return realpathSync.native(resolvedRoot);
    } catch {
      return resolvedRoot;
    }
  })();
  let real = resolved;
  if (existsSync(resolved)) {
    // Reject the entry outright if it is itself a symlink — callers that want
    // to allow symlinks within the tree can pass pre-resolved paths.
    try {
      const stat = lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Security: path "${filePath}" is a symbolic link. Symbolic links are not allowed within the project root.`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // Also verify the real (fully resolved) path stays within the project root.
    try {
      real = realpathSync.native(resolved);
    } catch {
      real = resolved; // path vanished between existsSync and realpathSync — skip
    }
    if (parsePath(realRoot).root.toLowerCase() !== parsePath(real).root.toLowerCase()) {
      throw new Error(
        `Security: resolved path "${real}" is on a different drive than the project root "${realRoot}".`,
      );
    }
    const realRel = relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new Error(
        `Security: path "${filePath}" resolves via symlink to "${real}" which escapes project root "${realRoot}".`,
      );
    }
  } else {
    let existingParent = dirname(resolved);
    while (!existsSync(existingParent)) {
      const next = dirname(existingParent);
      if (next === existingParent) break;
      existingParent = next;
    }
    try {
      const realParent = realpathSync.native(existingParent);
      real = resolve(realParent, relative(existingParent, resolved));
    } catch {
      real = resolved;
    }
    if (parsePath(realRoot).root.toLowerCase() !== parsePath(real).root.toLowerCase()) {
      throw new Error(
        `Security: resolved path "${real}" is on a different drive than the project root "${realRoot}".`,
      );
    }
    const realRel = relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new Error(
        `Security: path "${filePath}" resolves via symlink to "${real}" which escapes project root "${realRoot}".`,
      );
    }
  }

  return resolved;
}

export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString('hex');
  return `run_${ts}_${rand}`;
}

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(
      `Invalid runId "${runId}". Run IDs must match ${RUN_ID_RE} and cannot contain path separators.`,
    );
  }
}

export function truncateForName(text: string, maxLen = 40): string {
  const first = text.split('\n')[0]!.trim();
  // Guard: if the first line is empty (e.g. prompt is all whitespace/newlines),
  // fall back to the raw text trimmed rather than silently producing an empty name.
  if (!first) return text.trim().slice(0, maxLen) || '...';
  return first.length > maxLen ? first.slice(0, maxLen) + '...' : first;
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ═══ Platform-aware shell ═══
//
// Platform-aware shell resolution.
// Resolution order:
//   1. Env override: PIPELINE_SHELL="bash" or "cmd" or "powershell" etc.
//   2. Windows: prefer PowerShell, fall back to cmd.exe
//   3. Unix: sh
//
// Automatic resolution is cached; env overrides are intentionally not cached.

const IS_WINDOWS = process.platform === 'win32';

type ShellKind = 'sh' | 'bash' | 'cmd' | 'powershell';
let resolvedShell: { kind: ShellKind; path: string } | null = null;

function shellKindForPath(path: string): ShellKind {
  const normalized = path.toLowerCase();
  if (normalized === 'cmd' || normalized.endsWith('\\cmd.exe') || normalized.endsWith('/cmd.exe')) {
    return 'cmd';
  }
  if (
    normalized === 'powershell' ||
    normalized === 'pwsh' ||
    normalized.endsWith('\\powershell.exe') ||
    normalized.endsWith('/powershell.exe') ||
    normalized.endsWith('\\pwsh.exe') ||
    normalized.endsWith('/pwsh.exe')
  ) {
    return 'powershell';
  }
  if (
    normalized === 'bash' ||
    normalized.endsWith('\\bash.exe') ||
    normalized.endsWith('/bash.exe')
  ) {
    return 'bash';
  }
  return 'sh';
}

function detectShell(): { kind: ShellKind; path: string } {
  if (!IS_WINDOWS) {
    return { kind: 'sh', path: 'sh' };
  }

  // Windows command tasks should use a native Windows shell by default. Git
  // Bash frequently exists on developer machines, but silently selecting it
  // makes the editor's Windows guidance ("use PowerShell/cmd syntax") false.
  // Users who intentionally want POSIX shell behavior can set PIPELINE_SHELL.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (existsSync(powershell)) return { kind: 'powershell', path: powershell };

  // Fallback: cmd.exe is always present on Windows.
  return { kind: 'cmd', path: `${systemRoot}\\System32\\cmd.exe` };
}

function getShell(): { kind: ShellKind; path: string } {
  const override = process.env.PIPELINE_SHELL;
  if (override) {
    return { kind: shellKindForPath(override), path: override };
  }
  if (!resolvedShell) resolvedShell = detectShell();
  return resolvedShell;
}

export function shellArgs(command: string): readonly string[] {
  const sh = getShell();
  if (sh.kind === 'cmd') {
    return [sh.path, '/c', command];
  }
  if (sh.kind === 'powershell') {
    return [sh.path, '-Command', command];
  }
  // sh or bash
  return [sh.path, '-c', command];
}

/** Quote a single argument for inclusion in a shell command string. */
function quoteArg(arg: string, kind: ShellKind): string {
  if (!/[\s"'\\<>|&;`$!^%]/.test(arg)) return arg;

  if (kind === 'cmd') {
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  if (kind === 'powershell') {
    return "'" + arg.replace(/'/g, "''") + "'";
  }

  // POSIX shells: single-quote to prevent expansion and preserve Windows paths.
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert an args array to shell-wrapped args suitable for Bun.spawn.
 * Each arg is quoted as needed, then joined and passed through shellArgs.
 */
export function shellArgsFromArray(args: readonly string[]): readonly string[] {
  const sh = getShell();
  const command = args.map((arg) => quoteArg(arg, sh.kind)).join(' ');
  if (sh.kind === 'cmd') {
    return [sh.path, '/c', command];
  }
  if (sh.kind === 'powershell') {
    return [sh.path, '-Command', command];
  }
  return [sh.path, '-c', command];
}

// For tests: allow resetting the cached shell detection
export function _resetShellCache(): void {
  resolvedShell = null;
}
