// ─────────────────────────────────────────────────────────────────────────────
// preflight-requirements.ts — pre-run host check against `*.requirements.md`.
// ─────────────────────────────────────────────────────────────────────────────
//
// Runs once before /api/run/start launches the engine. Reads the sibling
// `*.requirements.md` for the workspace's pipeline YAML, parses its
// frontmatter, then probes every declared binary against PATH and every
// declared `required: true` env var against process.env. Returns the union of
// what's missing so the editor can surface it (and the install snippets from
// the requirements body) before tasks start failing with cryptic ENOENTs.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseRequirementsMd,
  requirementsPath,
  runRequirementsSync,
  type RequirementsBinary,
  type RequirementsEnvVar,
} from './requirements-sync.js';

export interface PreflightMissing {
  readonly binaries: readonly string[];
  readonly envs: readonly string[];
}

export interface PreflightResult {
  readonly missing: PreflightMissing;
  readonly requirementsPath: string | null;
  /** Env var names declared by requirements.md; callers can pass them through envPolicy. */
  readonly envKeys: readonly string[];
  /** True when there was no requirements file we could read (no preflight performed). */
  readonly skipped: boolean;
}

export interface PreflightOptions {
  readonly extraPathDirs?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function preflightPathKey(): 'Path' | 'PATH' {
  return process.platform === 'win32' && typeof process.env.Path === 'string' ? 'Path' : 'PATH';
}

function withExtraPreflightEnv(options: PreflightOptions): NodeJS.ProcessEnv {
  const env = { ...process.env, ...(options.extraEnv ?? {}) };
  if (!options.extraPathDirs || options.extraPathDirs.length === 0) return env;
  const key = preflightPathKey();
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  delete env.Path;
  delete env.PATH;
  env[key] = [...options.extraPathDirs, current].filter(Boolean).join(sep);
  return env;
}

/**
 * Probe whether `name` resolves through PATH on the host. Uses the host shell's
 * own resolution (`where` on Windows, `command -v` on POSIX) so PATH
 * augmentations like PATHEXT, shell builtins, and `~/.local/bin` exports are
 * all honored exactly as the runtime spawn would see them.
 */
export function probeBinary(name: string, options: PreflightOptions = {}): boolean {
  if (!name) return false;
  // Reject anything that looks path-shaped — those aren't PATH-resolvable, and
  // requirements.md should never declare them. Defensive: the extractor in
  // requirements-sync.ts already filters them out.
  if (name.includes('/') || name.includes('\\')) return false;
  try {
    const env = withExtraPreflightEnv(options);
    if (process.platform === 'win32') {
      const res = spawnSync('where', [name], { stdio: 'ignore', windowsHide: true, env });
      return res.status === 0;
    }
    // `command -v` is a shell builtin — must run via the shell, not as an exec.
    const res = spawnSync('sh', ['-c', `command -v ${shellQuote(name)} >/dev/null 2>&1`], {
      stdio: 'ignore',
      env,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Conservative single-quote escape for use inside `sh -c`. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function probeEnvVar(name: string): boolean {
  return typeof process.env[name] === 'string' && process.env[name]!.length > 0;
}

/**
 * Read the sibling `*.requirements.md` for `yamlPath`, probe everything it
 * declares, and report what's missing. Auto-generates the file via
 * runRequirementsSync when it doesn't exist yet so first-time runs still get a
 * preflight (the file would've been written by the chat-compile-watcher
 * eventually, but we don't want to race against the debounce window).
 */
export function runPreflight(yamlPath: string, options: PreflightOptions = {}): PreflightResult {
  const target = requirementsPath(yamlPath);
  try {
    runRequirementsSync(yamlPath);
  } catch (err) {
    console.warn('[preflight] inline sync failed:', err);
  }
  if (!existsSync(target)) {
    return {
      missing: { binaries: [], envs: [] },
      requirementsPath: null,
      envKeys: [],
      skipped: true,
    };
  }
  let frontmatter;
  try {
    const parsed = parseRequirementsMd(readFileSync(target, 'utf-8'));
    frontmatter = parsed.frontmatter;
  } catch (err) {
    console.warn(`[preflight] failed to parse ${target}:`, err);
    return {
      missing: { binaries: [], envs: [] },
      requirementsPath: target,
      envKeys: [],
      skipped: true,
    };
  }
  if (!frontmatter) {
    return {
      missing: { binaries: [], envs: [] },
      requirementsPath: target,
      envKeys: [],
      skipped: true,
    };
  }

  const binaries: readonly RequirementsBinary[] = Array.isArray(frontmatter.binaries)
    ? frontmatter.binaries
    : [];
  const envs: readonly RequirementsEnvVar[] = Array.isArray(frontmatter.env) ? frontmatter.env : [];

  const missingBinaries: string[] = [];
  for (const b of binaries) {
    if (!b || typeof b.name !== 'string') continue;
    if (!probeBinary(b.name, options)) missingBinaries.push(b.name);
  }
  const missingEnvs: string[] = [];
  const envKeys: string[] = [];
  for (const e of envs) {
    if (!e || typeof e.name !== 'string') continue;
    if (!envKeys.includes(e.name)) envKeys.push(e.name);
    if (e.required !== true) continue;
    if (!probeEnvVar(e.name) && !(options.extraEnv && options.extraEnv[e.name])) {
      missingEnvs.push(e.name);
    }
  }

  return {
    missing: { binaries: missingBinaries, envs: missingEnvs },
    requirementsPath: target,
    envKeys,
    skipped: false,
  };
}
