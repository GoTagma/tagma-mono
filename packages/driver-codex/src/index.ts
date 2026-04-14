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
  DriverPlugin, DriverCapabilities, TaskConfig, TrackConfig,
  DriverContext, SpawnSpec, Permissions,
} from '@tagma/types';

// L5 / M2: Codex currently exposes a single public coding model
// (`gpt-5-codex`) that supports `model_reasoning_effort` for tier control.
// Older revisions of this file pinned an unreleased `gpt-5.3-codex`
// placeholder which produced a 404 the moment the user actually ran a task.
// Until the upstream CLI exposes per-tier model variants, all tiers map to
// the same model name and tier control happens via reasoning effort below.
const MODEL_MAP: Record<string, string> = {
  high: 'gpt-5-codex', medium: 'gpt-5-codex', low: 'gpt-5-codex',
};

// Codex model reasoning effort — only 'low' | 'medium' | 'high' are supported
// by the underlying model. We map our model_tier directly.
const REASONING_EFFORT_MAP: Record<string, string> = {
  high: 'high', medium: 'medium', low: 'low',
};

function resolveModel(tier: string): string {
  return MODEL_MAP[tier] ?? 'gpt-5-codex';
}

function resolveReasoningEffort(tier: string): string {
  return REASONING_EFFORT_MAP[tier] ?? 'medium';
}

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
    throw new Error(
      'codex CLI not found on PATH. Install via: npm i -g @openai/codex',
    );
  }
}

// Map permissions to Codex --sandbox policy.
// Headless execution always uses --ask-for-approval never (no TTY to prompt on).
function resolveSandbox(permissions: Permissions): string {
  if (permissions.execute) return 'danger-full-access';
  if (permissions.write) return 'workspace-write';
  return 'read-only';
}

const CodexDriver: DriverPlugin = {
  name: 'codex',

  capabilities: {
    sessionResume: false,
    systemPrompt: false,
    outputFormat: false,
  } satisfies DriverCapabilities,

  resolveModel,

  async buildCommand(
    task: TaskConfig, track: TrackConfig, ctx: DriverContext,
  ): Promise<SpawnSpec> {
    // M1: cached preflight (see ensureCodexAvailable above).
    ensureCodexAvailable();
    const tier = task.model_tier ?? track.model_tier ?? 'medium';
    const model = resolveModel(tier);
    const reasoningEffort = resolveReasoningEffort(tier);
    const sandbox = resolveSandbox(task.permissions ?? track.permissions!);

    let prompt = task.prompt!;

    // No native system prompt — prepend agent_profile
    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      prompt = `[Role]\n${profile}\n\n[Task]\n${prompt}`;
    }

    // No session resume — text-context fallback.
    // Prefer in-memory normalized text (driver-extracted); fall back to
    // raw output file content if no normalized version is available.
    if (task.continue_from) {
      let prev: string | null = null;
      if (ctx.normalizedMap.has(task.continue_from)) {
        prev = ctx.normalizedMap.get(task.continue_from)!;
      } else if (ctx.outputMap.has(task.continue_from)) {
        prev = await Bun.file(ctx.outputMap.get(task.continue_from)!).text();
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
      '-a', 'never',
      'exec',
      '--skip-git-repo-check',
      '-c', `model_reasoning_effort="${reasoningEffort}"`,
      '--model', model,
      '--sandbox', sandbox,
      '--color', 'never',
      '-',
    ];

    return { args, stdin: prompt, cwd: task.cwd ?? ctx.workDir };
  },
};

// ═══ Plugin self-description exports ═══
export const pluginCategory = 'drivers';
export const pluginType = 'codex';
export default CodexDriver;
