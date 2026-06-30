// ─────────────────────────────────────────────────────────────────────────────
// requirements-sync.ts — per-pipeline `*.requirements.md` sidecar maintenance.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every `.tagma/foo.yaml` has a sibling `foo.requirements.md` listing the
// external dependencies needed to run the pipeline (CLI tools the user must
// install, environment variables they must export). The file is split across
// two owners:
//
//   - frontmatter `binaries:` is **server-owned**. This module recomputes it
//     from the YAML on every YAML write and rewrites the file in place,
//     preserving everything else.
//   - frontmatter `env:` / `services:` plus the entire markdown body is
//     **agent-owned**. The Tagma YAML chat agent maintains those (see the
//     "Companion `.requirements.md` file" rules in opencode-seed.ts).
//
// The runtime preflight (preflight-requirements.ts → routes/run.ts) reads the
// frontmatter to verify the host before launching a pipeline; the editor UI
// renders the body to show install instructions for missing dependencies.

import { dirname, basename, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './path-utils.js';

// ── Public schema types ─────────────────────────────────────────────────────

export interface RequirementsBinary {
  /** Bare command name as it should appear on PATH (e.g. "git", "bun", "claude"). */
  readonly name: string;
  /** Probe command the preflight uses. Defaults to `<name> --version`. */
  readonly probe?: string;
  /** Qualified task ids / hook keys that reference this binary. */
  readonly usedBy: readonly string[];
  /** Tagma driver name, when this binary entry was derived from a prompt task's driver. */
  readonly fromDriver?: string;
}

export interface RequirementsEnvVar {
  readonly name: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface RequirementsFrontmatter {
  readonly schemaVersion: 1;
  readonly generatedFor: string;
  readonly generatedAt: string;
  readonly binaries: readonly RequirementsBinary[];
  readonly env: readonly RequirementsEnvVar[];
  readonly services: readonly unknown[];
}

export interface ParsedRequirements {
  readonly frontmatter: RequirementsFrontmatter | null;
  readonly body: string;
}

/**
 * Maps a Tagma driver name to the binary the runtime spawns. `null` means
 * "no preflight needed" for drivers that do not shell out to a host binary.
 * Unknown drivers fall back to the driver name itself.
 */
export const DRIVER_BINARIES: Readonly<Record<string, string | null>> = {
  opencode: 'opencode',
  'claude-code': 'claude',
  codex: 'codex',
};

// ── Path helpers ────────────────────────────────────────────────────────────

/** Sibling `*.requirements.md` next to a given pipeline YAML. */
export function requirementsPath(yamlPath: string): string {
  const dir = dirname(yamlPath);
  const stem = basename(yamlPath).replace(/\.ya?ml$/i, '');
  return join(dir, `${stem}.requirements.md`);
}

// ── First-token extraction from a CommandConfig ─────────────────────────────

/**
 * Pull the binary name out of a Tagma `CommandConfig` (string | argv | shell).
 * Returns `null` when the command references a local path / script instead of
 * a PATH-resolved CLI — those don't belong in a requirements file because
 * they're shipped with the pipeline, not installed by the user.
 *
 * Multi-line strings (typed in YAML as `|` literal or `>` folded scalars with
 * blank lines) are treated as opaque script blocks and bypass token extraction
 * entirely: the shell-ish scanner cannot tell PowerShell cmdlets, keywords, or
 * `@{ k = v; ... }` hashtable keys apart from real PATH binaries, so any
 * extraction would fabricate bogus entries. Multi-line dependencies are
 * agent-owned and live in the requirements markdown body instead.
 */
function extractBinariesFromCommand(cmd: unknown): string[] {
  if (typeof cmd === 'string') {
    if (isMultilineScript(cmd)) return [];
    return shellCommandTokens(cmd);
  }
  if (cmd && typeof cmd === 'object') {
    const obj = cmd as { argv?: unknown; shell?: unknown };
    if (Array.isArray(obj.argv) && obj.argv.length > 0 && typeof obj.argv[0] === 'string') {
      const bin = commandBaseName(obj.argv[0]);
      return bin ? [bin] : [];
    }
    if (typeof obj.shell === 'string') {
      if (isMultilineScript(obj.shell)) return [];
      return shellCommandTokens(obj.shell);
    }
  }
  return [];
}

function isMultilineScript(s: string): boolean {
  return /\r?\n/.test(s.trim());
}

/**
 * Split a shell-style string on whitespace, respecting matched single / double
 * quotes. Backslash escapes and `$()` / backtick subshells are NOT honored —
 * Tagma never substitutes inside `command:` values, so the literal first token
 * is what the OS shell will pass to execve / CreateProcess.
 */
function splitShellTokens(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else if (ch === ';' || ch === '|') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      if (ch === '|' && s[i + 1] === '|') {
        out.push('||');
        i++;
      } else {
        out.push(ch);
      }
    } else if (ch === '&' && s[i + 1] === '&') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push('&&');
      i++;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const COMMAND_SEPARATORS = new Set([';', '&&', '||', '|']);
const GROUP_OPENERS = new Set(['(', '{']);
const CONTROL_WORDS = new Set([
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'if',
  'in',
  'then',
  'until',
  'while',
]);
const SHELL_BUILTINS = new Set([
  '.',
  '[',
  ']',
  'alias',
  'bg',
  'break',
  'builtin',
  'case',
  'cd',
  'chdir',
  'clear',
  'command',
  'continue',
  'copy',
  'cp',
  'del',
  'dir',
  'dirs',
  'echo',
  'erase',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fg',
  'for',
  'function',
  'get-childitem',
  'hash',
  'history',
  'jobs',
  'let',
  'local',
  'ls',
  'md',
  'mkdir',
  'move',
  'mv',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'rd',
  'read',
  'readonly',
  'return',
  'rmdir',
  'rm',
  'set',
  'set-item',
  'shift',
  'source',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unset',
  'wait',
  'write-host',
]);
const WRAPPER_COMMANDS = new Set(['env', 'nohup', 'sudo', 'time']);

function isEnvAssignmentToken(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || /^\$env:[A-Za-z_][A-Za-z0-9_]*=/i.test(tok);
}

function isRedirectionToken(tok: string): boolean {
  return /^(\d*)>>?/.test(tok) || /^(\d*)<<?/.test(tok) || tok === '2>&1';
}

function shellCommandTokens(s: string): string[] {
  const bins: string[] = [];
  let expectingCommand = true;
  let inEnvWrapper = false;

  for (const rawTok of splitShellTokens(s.trim())) {
    const tok = rawTok.trim();
    if (!tok) continue;
    if (COMMAND_SEPARATORS.has(tok)) {
      expectingCommand = true;
      inEnvWrapper = false;
      continue;
    }
    if (!expectingCommand) continue;

    const lower = tok.toLowerCase();
    if (GROUP_OPENERS.has(tok) || CONTROL_WORDS.has(lower) || isRedirectionToken(tok)) {
      continue;
    }
    if (isEnvAssignmentToken(tok)) {
      continue;
    }
    if (inEnvWrapper && tok.startsWith('-')) {
      continue;
    }
    if (WRAPPER_COMMANDS.has(lower)) {
      inEnvWrapper = lower === 'env';
      continue;
    }
    if (SHELL_BUILTINS.has(lower)) {
      expectingCommand = false;
      inEnvWrapper = false;
      continue;
    }

    const bin = commandBaseName(tok);
    if (bin && !bins.includes(bin)) bins.push(bin);
    expectingCommand = false;
    inEnvWrapper = false;
  }

  return bins;
}

/**
 * Reduce an argv[0] / first-token string to a bare PATH-resolvable command
 * name, or `null` if it's a local script / absolute path (which the user
 * doesn't need to install). Strips trailing extensions like `.exe` / `.cmd`
 * so `bun.exe` and `bun` collapse to one entry.
 */
function commandBaseName(arg: string): string | null {
  if (!arg) return null;
  if (arg.startsWith('$')) return null;
  if (arg.includes('/') || arg.includes('\\') || arg.startsWith('.')) return null;
  return arg.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

// ── YAML walking ────────────────────────────────────────────────────────────

interface MutableBinary {
  name: string;
  probe: string;
  usedBy: string[];
  fromDriver?: string;
}

function addBinary(
  binaries: Map<string, MutableBinary>,
  name: string,
  usedBy: string,
  fromDriver?: string,
): void {
  let entry = binaries.get(name);
  if (!entry) {
    entry = {
      name,
      probe: `${name} --version`,
      usedBy: [],
      ...(fromDriver !== undefined ? { fromDriver } : {}),
    };
    binaries.set(name, entry);
  }
  if (!entry.usedBy.includes(usedBy)) entry.usedBy.push(usedBy);
}

interface PartialPipeline {
  driver?: string;
  tracks?: PartialTrack[];
  hooks?: Record<string, unknown>;
}
interface PartialTrack {
  id?: string;
  driver?: string;
  tasks?: PartialTask[];
}
interface PartialTask {
  id?: string;
  prompt?: unknown;
  command?: unknown;
  driver?: string;
  completion?: unknown;
}

/**
 * Parse the YAML at `yamlPath` and walk it to enumerate every external binary
 * the pipeline depends on. Returns `null` when the YAML fails to parse (the
 * caller should skip rewriting the sidecar — we don't want a transient syntax
 * error to wipe a previously-good binaries list).
 */
export function extractBinariesFromYaml(yamlPath: string): RequirementsBinary[] | null {
  let parsed: unknown;
  try {
    const content = readFileSync(yamlPath, 'utf-8');
    parsed = yaml.load(content);
  } catch {
    return null;
  }
  const pipeline = (parsed as { pipeline?: PartialPipeline } | null)?.pipeline;
  if (!pipeline || typeof pipeline !== 'object') return [];

  const binaries = new Map<string, MutableBinary>();
  const pipelineDriver = pipeline.driver;
  const tracks = Array.isArray(pipeline.tracks) ? pipeline.tracks : [];

  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue;
    const trackId = typeof track.id === 'string' ? track.id : '?';
    const tasks = Array.isArray(track.tasks) ? track.tasks : [];
    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      const taskId = typeof task.id === 'string' ? task.id : '?';
      const ref = `${trackId}.${taskId}`;

      if (task.command !== undefined) {
        for (const bin of extractBinariesFromCommand(task.command)) {
          addBinary(binaries, bin, ref);
        }
      }
      if (task.command === undefined && task.prompt !== undefined) {
        const driver = task.driver ?? track.driver ?? pipelineDriver ?? 'opencode';
        const mapped = driver in DRIVER_BINARIES ? DRIVER_BINARIES[driver] : driver;
        if (mapped) addBinary(binaries, mapped, ref, driver);
      }

      const completion = task.completion as { type?: unknown; check?: unknown } | null;
      if (completion && typeof completion === 'object' && completion.type === 'output_check') {
        for (const bin of extractBinariesFromCommand(completion.check)) {
          addBinary(binaries, bin, `${ref}.completion.output_check`);
        }
      }
    }
  }

  if (pipeline.hooks && typeof pipeline.hooks === 'object') {
    for (const [key, value] of Object.entries(pipeline.hooks)) {
      const cmds = Array.isArray(value) ? value : [value];
      for (const cmd of cmds) {
        for (const bin of extractBinariesFromCommand(cmd)) {
          addBinary(binaries, bin, `hooks.${key}`);
        }
      }
    }
  }

  return [...binaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Markdown + YAML frontmatter parse / serialize ──────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseRequirementsMd(content: string): ParsedRequirements {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { frontmatter: null, body: content };
  let frontmatter: RequirementsFrontmatter | null = null;
  try {
    const loaded = yaml.load(match[1]!);
    if (loaded && typeof loaded === 'object') {
      frontmatter = loaded as RequirementsFrontmatter;
    }
  } catch {
    // Invalid YAML in the frontmatter — caller will replace it on next sync.
  }
  return { frontmatter, body: match[2] ?? '' };
}

export function serializeRequirementsMd(parsed: ParsedRequirements): string {
  const fm = yaml.dump(parsed.frontmatter ?? {}, {
    lineWidth: 120,
  });
  const body = parsed.body.replace(/^\n+/, '');
  return `---\n${fm.trimEnd()}\n---\n\n${body}`;
}

// ── Initial body template (used when the file doesn't exist yet) ───────────

function buildInitialBody(yamlBasename: string, binaries: readonly RequirementsBinary[]): string {
  const cliSection =
    binaries.length === 0
      ? '<!-- No CLI tools required yet. -->'
      : binaries.map(buildBinaryBodySection).join('\n\n');

  return `# Requirements for \`${yamlBasename}\`

> External dependencies required to run this pipeline. Tagma checks this file
> before launching the pipeline and refuses to start when a binary or required
> env var is missing on this machine.
>
> The \`binaries:\` list in the YAML frontmatter is auto-generated from
> \`${yamlBasename}\` and will be overwritten on every save — do not edit it
> by hand. Everything else (\`env\`, \`services\`, the install instructions
> below) is yours / the chat agent's to maintain.

## CLI tools

${cliSection}

## Environment

<!-- List required environment variables here. Match each entry's
     \`name\` to an \`env:\` row in the frontmatter so the runtime preflight
     can check it. -->
`;
}

function buildBinaryBodySection(binary: RequirementsBinary): string {
  const usedBy = binary.usedBy.map((u) => `\`${u}\``).join(', ');
  const probe = binary.probe ?? `${binary.name} --version`;
  return `### \`${binary.name}\`

Used in: ${usedBy}

<!-- TODO: install instructions for \`${binary.name}\` (macOS / Linux / Windows). -->

Verify: \`${probe}\``;
}

function hasBinaryBodySection(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^###\\s+\`${escaped}\`\\s*$`, 'm').test(body);
}

function ensureBinaryBodySections(body: string, binaries: readonly RequirementsBinary[]): string {
  const missing = binaries.filter((binary) => !hasBinaryBodySection(body, binary.name));
  if (missing.length === 0) return body;

  const additions = missing.map(buildBinaryBodySection).join('\n\n');
  const next = body.replace(/\n?<!-- No CLI tools required yet\. -->\n?/g, '\n');
  const environmentHeader = /^## Environment\s*$/m.exec(next);
  if (environmentHeader) {
    const before = next.slice(0, environmentHeader.index).replace(/\s+$/g, '');
    const after = next.slice(environmentHeader.index).replace(/^\s+/g, '');
    return `${before}\n\n${additions}\n\n${after}`;
  }
  return `${next.replace(/\s+$/g, '')}\n\n${additions}\n`;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Reconcile the sibling `*.requirements.md` for the given YAML. Read-modify-
 * write: the frontmatter `binaries:` list is recomputed from the YAML,
 * everything else (frontmatter `env` / `services`, the entire markdown body)
 * is preserved verbatim. Safe to call repeatedly.
 *
 * Errors are logged and swallowed — same contract as runCompileAndWriteLog.
 * A transient parse failure should never wipe a user-maintained body.
 */
export function runRequirementsSync(yamlPath: string): void {
  const binaries = extractBinariesFromYaml(yamlPath);
  if (binaries === null) {
    console.warn(`[requirements-sync] yaml parse failed, skipping sync for ${yamlPath}`);
    return;
  }

  const targetPath = requirementsPath(yamlPath);
  const yamlBasename = basename(yamlPath);

  let existing: ParsedRequirements | null = null;
  if (existsSync(targetPath)) {
    try {
      existing = parseRequirementsMd(readFileSync(targetPath, 'utf-8'));
    } catch (err) {
      console.warn(`[requirements-sync] failed to read existing ${targetPath}:`, err);
    }
  }

  const nextFrontmatter: RequirementsFrontmatter = {
    schemaVersion: 1,
    generatedFor: yamlBasename,
    generatedAt: new Date().toISOString(),
    binaries,
    env: existing?.frontmatter?.env ?? [],
    services: existing?.frontmatter?.services ?? [],
  };

  const body =
    existing?.body !== undefined
      ? ensureBinaryBodySections(existing.body, binaries)
      : buildInitialBody(yamlBasename, binaries);

  try {
    atomicWriteFileSync(
      targetPath,
      serializeRequirementsMd({ frontmatter: nextFrontmatter, body }),
    );
  } catch (err) {
    console.warn(`[requirements-sync] failed to write ${targetPath}:`, err);
  }
}
