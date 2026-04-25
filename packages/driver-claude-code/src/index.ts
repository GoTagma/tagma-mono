import { existsSync } from 'node:fs';
import { isAbsolute, relative, dirname, join } from 'node:path';
import type {
  DriverPlugin,
  DriverCapabilities,
  DriverResultMeta,
  TaskConfig,
  TrackConfig,
  DriverContext,
  SpawnSpec,
  Permissions,
} from '@tagma/types';

// Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference

const DEFAULT_MODEL = 'sonnet';

// Tagma's canonical reasoning_effort vocabulary is low|medium|high (enforced
// by validate-raw.ts in the SDK). Claude Code CLI also exposes a "max" tier,
// but accepting it here would diverge from the SDK validator — users who set
// `reasoning_effort: max` in YAML would see an editor-side validation error
// even though the driver tolerates it. Stay in sync with the SDK instead.
const VALID_EFFORT = new Set(['low', 'medium', 'high']);

function resolveModel(): string {
  return DEFAULT_MODEL;
}

function resolveTools(permissions: Permissions): string {
  const tools = ['Grep', 'Glob'];
  if (permissions.read) tools.push('Read');
  if (permissions.write) tools.push('Edit', 'Write');
  if (permissions.execute) tools.push('Bash');
  return tools.join(',');
}

// Maps our Permissions to Claude Code's --permission-mode. In print (-p) mode
// Claude needs non-interactive permission handling:
// - `bypassPermissions` skips all checks (required for reliable Bash automation
//   under `execute: true`, matches the "full trust" semantics of that tier).
// - `dontAsk` auto-denies anything outside `--allowedTools`, which is exactly
//   what we want for read/write tiers: the allowedTools whitelist already
//   enumerates what Claude may do, and dontAsk makes violations fail fast
//   instead of hanging on a prompt no one can answer in headless mode.
// See: https://code.claude.com/docs/en/permission-modes
function resolvePermissionMode(permissions: Permissions): string {
  if (permissions.execute) return 'bypassPermissions';
  return 'dontAsk';
}

// Returns true if `sub` is inside `root` (or equal to it).
function isInside(root: string, sub: string): boolean {
  const rel = relative(root, sub);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Claude Code requires CLAUDE_CODE_GIT_BASH_PATH on Windows pointing to
// Git Bash (bin\bash.exe under a Git for Windows install). See:
//   https://code.claude.com/docs/en/troubleshooting#windows-claude-code-on-windows-requires-git-bash
// The path must use native Windows backslashes — forward slashes are rejected
// by Claude Code's path validation.
function resolveGitBashEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {};

  // Respect user-provided value if it points to an actual file. If the user
  // set it to a non-existent path, fall through to discovery rather than
  // propagating the broken config.
  const existing = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (existing && existsSync(existing)) return {};

  const discovered = discoverGitBash();
  return discovered ? { CLAUDE_CODE_GIT_BASH_PATH: discovered } : {};
}

function discoverGitBash(): string | null {
  // Strategy 1: find git.exe in PATH (equivalent to `where.exe git`) and
  // walk up looking for bin\bash.exe under a Git install root. Git for
  // Windows may expose multiple git.exe locations (cmd\git.exe,
  // mingw64\bin\git.exe, mingw64\libexec\git-core\git.exe), so we walk up
  // several levels rather than assuming a fixed depth.
  const gitExe = findExeInPath('git.exe');
  if (gitExe) {
    let dir = dirname(gitExe);
    for (let depth = 0; depth < 5; depth++) {
      const candidate = join(dir, 'bin', 'bash.exe');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Strategy 2: check common Git for Windows install locations.
  // Uses %ProgramFiles%/%LOCALAPPDATA%/%USERPROFILE% env vars so it works on
  // systems where those aren't mapped to C:\ (e.g. localized Windows).
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'];
  const userProfile = process.env['USERPROFILE'];

  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    // Git for Windows user-level install
    localAppData && join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    // Scoop
    userProfile && join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    // Chocolatey default
    'C:\\tools\\git\\bin\\bash.exe',
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Strategy 3: scan PATH for any entry containing "git" (e.g. Git's
  // mingw64/bin or usr/bin already in PATH), walk up to find bash.exe.
  // Catches custom install locations.
  const pathEntries = (process.env.PATH ?? '').split(';');
  for (const entry of pathEntries) {
    if (!/git/i.test(entry)) continue;
    const normalized = entry.replace(/\//g, '\\').replace(/\\+$/, '');
    const parts = normalized.split('\\');
    for (let depth = 1; depth <= 4; depth++) {
      const root = parts.slice(0, parts.length - depth).join('\\');
      if (!root) continue;
      const candidate = root + '\\bin\\bash.exe';
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function findExeInPath(exe: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(';');
  for (const dir of pathDirs) {
    if (!dir) continue;
    const full = join(dir, exe);
    if (existsSync(full)) return full;
  }
  return null;
}

const ClaudeCodeDriver: DriverPlugin = {
  name: 'claude-code',

  capabilities: {
    sessionResume: true,
    systemPrompt: true,
    outputFormat: true,
  } satisfies DriverCapabilities,

  resolveModel,
  resolveTools,

  async buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec> {
    const permissions = task.permissions ?? track.permissions!;
    const model = task.model ?? track.model ?? DEFAULT_MODEL;
    // SDK schema layer already resolved task → track → pipeline inheritance.
    // Drop unknown effort values so a typo can't break `claude -p` startup;
    // validateRaw / the UI should prevent this from reaching us in practice.
    const rawEffort = task.reasoning_effort ?? track.reasoning_effort;
    const effort = rawEffort && VALID_EFFORT.has(rawEffort) ? rawEffort : null;
    const tools = resolveTools(permissions);
    const permissionMode = resolvePermissionMode(permissions);

    // Pass the prompt via stdin instead of as a -p argument value. On Windows,
    // multi-line strings in CLI arguments break cmd.exe argument parsing when
    // the executable is a .cmd wrapper — newlines cause all subsequent flags
    // (--output-format, --model, etc.) to be silently dropped.
    const stdin = task.prompt!;

    const args: string[] = [
      'claude',
      '-p', // no value — prompt is piped via stdin
      '--model',
      model,
      '--allowedTools',
      tools,
      '--permission-mode',
      permissionMode,
      '--output-format',
      'json',
      // NOTE: do NOT use --verbose here. It changes stdout from a single JSON
      // result object to a JSON event-stream array, breaking parseResult's
      // session_id extraction (needed for continue_from) and normalizedOutput.
      // The engine already captures stdout/stderr for pipeline logs.
      // Pin to project+local settings only; don't inherit arbitrary user-level
      // config (hooks, MCP servers, etc.) into pipeline automation.
      '--setting-sources',
      'project,local',
    ];

    if (effort) {
      args.push('--effort', effort);
    }

    // If the task runs in a subdirectory of the project, grant read/edit
    // access to the project root via --add-dir so Claude can still see
    // shared files (configs, types, etc.) outside task.cwd.
    const effectiveCwd = task.cwd ?? ctx.workDir;
    if (effectiveCwd !== ctx.workDir && isInside(ctx.workDir, effectiveCwd)) {
      args.push('--add-dir', ctx.workDir);
    }

    // Native session resume
    if (task.continue_from) {
      const sessionId = ctx.sessionMap.get(task.continue_from);
      if (sessionId) {
        args.push('--resume', sessionId);
      }
    }

    // --append-system-prompt MUST be last: its value may contain newlines,
    // and on Windows cmd.exe can silently drop any flags that follow a
    // newline-containing argument.
    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      args.push('--append-system-prompt', profile);
    }

    return { args, cwd: effectiveCwd, env: resolveGitBashEnv(), stdin };
  },

  parseResult(stdout: string): DriverResultMeta {
    try {
      let json = JSON.parse(stdout);

      // --verbose produces a JSON array of events; extract the final "result"
      // event so session_id and normalizedOutput are correctly populated.
      if (Array.isArray(json)) {
        const resultEvent = json.findLast((e: Record<string, unknown>) => e.type === 'result');
        if (!resultEvent) return { normalizedOutput: stdout };
        json = resultEvent;
      }

      // Extract canonical text: strip JSON envelope so downstream drivers
      // get the actual AI response, not metadata
      const normalizedOutput = json.result ?? json.text ?? json.content ?? stdout;
      return {
        sessionId: json.session_id,
        normalizedOutput:
          typeof normalizedOutput === 'string'
            ? normalizedOutput
            : JSON.stringify(normalizedOutput),
      };
    } catch {
      return { normalizedOutput: stdout };
    }
  },
};

export const pluginCategory = 'drivers';
export const pluginType = 'claude-code';
export default ClaudeCodeDriver;
