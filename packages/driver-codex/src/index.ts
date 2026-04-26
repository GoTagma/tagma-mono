// ═══ Codex Driver Plugin ═══
//
// Translates a Task into a `codex exec` invocation. Headless / non-interactive:
// uses `-a never` because there is no TTY to confirm on, and maps our
// Permissions to Codex's --sandbox policy.
//
// Codex has no native session resume or independent system-prompt flag, so
// `continue_from` and `agent_profile` are both folded into the prompt text
// (text-context fallback). This is weaker than Claude Code's --resume.
//
// Usage in pipeline.yaml:
//   plugins: ["@tagma/driver-codex"]
//   tracks:
//     - driver: codex
//       ...

import type {
  DriverPlugin,
  DriverCapabilities,
  TaskConfig,
  TrackConfig,
  DriverContext,
  SpawnSpec,
  Permissions,
  TagmaPlugin,
} from '@tagma/types';

// gpt-5-codex is the current publicly available Codex coding model. An
// earlier revision of this file pinned an unreleased `gpt-5.3-codex`
// placeholder which produced a 404 the moment the user actually ran a task.
const DEFAULT_MODEL = 'gpt-5-codex';
// Reasoning effort is inherited pipeline → track → task (resolved by the SDK
// schema layer). Defaults to 'medium' when not set anywhere in the chain.
const DEFAULT_REASONING_EFFORT = 'medium';
const VALID_REASONING_EFFORT = new Set(['low', 'medium', 'high']);

// M1: cache the `codex --version` probe at module level so a pipeline with
// 10 codex tasks doesn't pay the spawnSync tax 10 times. spawnSync blocks
// the event loop for ~50–200ms each invocation. The probe result only needs
// to be re-checked when the module is reloaded (process restart).
let codexAvailable: boolean | null = null;
function ensureCodexAvailable(): void {
  if (codexAvailable === null) {
    try {
      const r = Bun.spawnSync(['codex', '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      codexAvailable = r.exitCode === 0;
    } catch {
      codexAvailable = false;
    }
  }
  if (!codexAvailable) {
    throw new Error('codex CLI not found on PATH. Install via: npm i -g @openai/codex');
  }
}

// Map permissions to Codex --sandbox policy.
// Headless execution always uses --ask-for-approval never (no TTY to prompt on).
function resolveSandbox(permissions: Permissions): string {
  if (permissions.execute) return 'danger-full-access';
  if (permissions.write) return 'workspace-write';
  return 'read-only';
}

export const CodexDriver: DriverPlugin = {
  name: 'codex',

  capabilities: {
    sessionResume: false,
    systemPrompt: false,
    outputFormat: false,
  } satisfies DriverCapabilities,

  resolveModel(): string {
    return DEFAULT_MODEL;
  },

  async buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec> {
    // M1: cached preflight (see ensureCodexAvailable above).
    ensureCodexAvailable();
    const model = task.model ?? track.model ?? DEFAULT_MODEL;
    // The SDK already resolves task → track → pipeline inheritance, so by the
    // time we get here task.reasoning_effort holds the effective value (or
    // undefined if it was never set). Guard against unexpected values coming
    // from user config that the editor might not have validated yet.
    const rawEffort = task.reasoning_effort ?? track.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    const reasoningEffort = VALID_REASONING_EFFORT.has(rawEffort)
      ? rawEffort
      : DEFAULT_REASONING_EFFORT;
    const sandbox = resolveSandbox(task.permissions ?? track.permissions!);

    let prompt = task.prompt!;

    // No native system prompt — prepend agent_profile
    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      prompt = `[Role]\n${profile}\n\n[Task]\n${prompt}`;
    }

    // No session resume — text-context fallback via in-memory normalized text.
    if (task.continue_from) {
      let prev: string | null = null;
      if (ctx.normalizedMap.has(task.continue_from)) {
        prev = ctx.normalizedMap.get(task.continue_from)!;
      }
      if (prev !== null) {
        prompt = `[Previous Output]\n${prev}\n\n[Current Task]\n${prompt}`;
      }
    }

    // `codex exec` is the non-interactive subcommand. Positional `-` reads
    // the prompt from stdin. -a/--ask-for-approval is a top-level codex flag
    // and MUST appear before the `exec` subcommand. `never` is required for
    // headless execution since there's no TTY to confirm on.
    // --skip-git-repo-check lets Tagma workspaces that aren't git repos
    // run without the "Not inside a trusted directory" preflight error;
    // the workspace sandbox is already controlled by --sandbox below.
    // Override reasoning effort via -c to avoid user config (e.g. "xhigh")
    // values that aren't supported by the current model.
    const args: string[] = [
      'codex',
      '-a',
      'never',
      'exec',
      '--skip-git-repo-check',
      '-c',
      `model_reasoning_effort="${reasoningEffort}"`,
      '--model',
      model,
      '--sandbox',
      sandbox,
      '--color',
      'never',
      '-',
    ];

    return { args, stdin: prompt, cwd: task.cwd ?? ctx.workDir };
  },
};

export default {
  name: '@tagma/driver-codex',
  capabilities: {
    drivers: {
      codex: CodexDriver,
    },
  },
} satisfies TagmaPlugin;
