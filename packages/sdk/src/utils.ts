import { resolve, relative } from 'path';
import { randomBytes } from 'crypto';

const DURATION_RE = /^(\d*\.?\d+)\s*(s|m|h|d)$/;

export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${input}". Expected format: <number>(s|m|h|d)`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default:  throw new Error(`Unknown duration unit: "${unit}"`);
  }
}

export function validatePath(filePath: string, projectRoot: string): string {
  const resolved = resolve(projectRoot, filePath);
  const rel = relative(projectRoot, resolved);

  if (rel.startsWith('..') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(
      `Security: path "${filePath}" escapes project root. ` +
      `All file references must be within "${projectRoot}".`
    );
  }

  return resolved;
}

export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(6).toString('hex');
  return `run_${ts}_${rand}`;
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
// Resolution order:
//   1. Env override: PIPELINE_SHELL="bash" or PIPELINE_SHELL="cmd" etc.
//   2. Windows: prefer sh (Git Bash / MSYS2) if on PATH, fall back to cmd.exe
//   3. Unix: sh
//
// Resolution is cached once on first call to avoid repeated PATH lookups.

const IS_WINDOWS = process.platform === 'win32';

type ShellKind = 'sh' | 'bash' | 'cmd' | 'powershell';
let resolvedShell: { kind: ShellKind; path: string } | null = null;

function detectShell(): { kind: ShellKind; path: string } {
  // Env override takes precedence
  const override = process.env.PIPELINE_SHELL;
  if (override) {
    const kind = override as ShellKind;
    return { kind, path: override };
  }

  if (!IS_WINDOWS) {
    return { kind: 'sh', path: 'sh' };
  }

  // Windows: probe PATH for sh (bundled with Git for Windows / MSYS2)
  const pathEnv = process.env.PATH ?? '';
  const pathExt = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';');
  const dirs = pathEnv.split(';').filter(Boolean);

  for (const dir of dirs) {
    for (const ext of ['', ...pathExt]) {
      const candidate = `${dir}\\sh${ext}`;
      try {
        if (Bun.file(candidate).size > 0) {
          return { kind: 'sh', path: candidate };
        }
      } catch { /* ignore */ }
    }
  }

  // Fallback: cmd.exe (always present on Windows)
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return { kind: 'cmd', path: `${systemRoot}\\System32\\cmd.exe` };
}

function getShell(): { kind: ShellKind; path: string } {
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
function quoteArg(arg: string): string {
  if (!/[\s"'\\<>|&;`$!^%]/.test(arg)) return arg;
  if (IS_WINDOWS) {
    // On Windows (cmd.exe), double-quote and escape embedded quotes + backslashes
    return '"' + arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  // On Unix, use single quotes to prevent $variable expansion.
  // Escape embedded single quotes via the '\'' idiom.
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert an args array to shell-wrapped args suitable for Bun.spawn.
 * Each arg is quoted as needed, then joined and passed through shellArgs.
 */
export function shellArgsFromArray(args: readonly string[]): readonly string[] {
  return shellArgs(args.map(quoteArg).join(' '));
}

// For tests: allow resetting the cached shell detection
export function _resetShellCache(): void {
  resolvedShell = null;
}
