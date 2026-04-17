import type {
  DriverPlugin, DriverCapabilities, DriverResultMeta,
  TaskConfig, TrackConfig, DriverContext, SpawnSpec,
} from '@tagma/types';

const DEFAULT_MODEL = 'opencode/big-pickle';

// tagma uses a provider-neutral reasoning_effort vocabulary (low|medium|high)
// but opencode's `--variant` is provider-specific (e.g. high|max|minimal).
// Map the tagma values to the closest opencode variant:
//   low    → minimal  (least thinking)
//   medium → <no flag, provider default>
//   high   → high     (most thinking)
// Unknown values pass through unchanged so users who target a specific
// opencode variant (e.g. "max") still work.
const EFFORT_TO_VARIANT: Record<string, string | null> = {
  low: 'minimal',
  medium: null,
  high: 'high',
};

const OpenCodeDriver: DriverPlugin = {
  name: 'opencode',

  capabilities: {
    sessionResume: true,      // supports --session
    systemPrompt: false,      // no --system-prompt flag; prepend to prompt instead
    outputFormat: true,       // supports --format json
  } satisfies DriverCapabilities,

  resolveModel(): string {
    return DEFAULT_MODEL;
  },

  async buildCommand(
    task: TaskConfig, track: TrackConfig, ctx: DriverContext,
  ): Promise<SpawnSpec> {
    const model = task.model ?? track.model ?? DEFAULT_MODEL;
    // Resolve reasoning_effort → opencode --variant. SDK schema layer already
    // resolved task → track → pipeline inheritance, so we only need to read
    // task.reasoning_effort here.
    const rawEffort = task.reasoning_effort ?? track.reasoning_effort;
    const variant = rawEffort
      ? (rawEffort in EFFORT_TO_VARIANT ? EFFORT_TO_VARIANT[rawEffort] : rawEffort)
      : null;

    let prompt = task.prompt!;

    // agent_profile has no dedicated flag; prepend to prompt
    const profile = task.agent_profile ?? track.agent_profile;
    if (profile) {
      prompt = `[Role]\n${profile}\n\n[Task]\n${prompt}`;
    }

    // continue_from: prefer session resume, fall back to text injection
    let sessionId: string | null = null;
    if (task.continue_from) {
      sessionId = ctx.sessionMap.get(task.continue_from) ?? null;
      if (!sessionId) {
        // no session — degrade to text context passthrough
        let prev: string | null = null;
        if (ctx.normalizedMap.has(task.continue_from)) {
          prev = ctx.normalizedMap.get(task.continue_from)!;
        }
        if (prev !== null) {
          prompt = `[Previous Output]\n${prev}\n\n[Current Task]\n${prompt}`;
        }
      }
    }

    // opencode run does not support stdin (no `-` placeholder like codex exec).
    // Prompt is always a positional argument. Flags must be declared before `--`;
    // the prompt follows after so that leading `--flag` content cannot be
    // misread by opencode's argument parser (flag-injection mitigation).
    // Shell-level injection is already prevented by Bun.spawn's direct argv array.
    const args: string[] = [
      'opencode',
      'run',
      '--model', model,
      '--format', 'json',       // JSON output for parseResult
    ];

    // `--variant` must precede `--` like every other flag. opencode rejects
    // unknown variant names with a clear error, so we don't pre-validate.
    if (variant) {
      args.push('--variant', variant);
    }

    // session resume (must appear before --)
    if (sessionId) {
      args.push('--session', sessionId);
    }

    // `--` (POSIX end-of-options) isolates prompt from flag parsing
    args.push('--', prompt);

    return { args, cwd: task.cwd ?? ctx.workDir };
  },

  parseResult(stdout: string): DriverResultMeta {
    try {
      const json = JSON.parse(stdout);

      if (json.type === 'error') {
        // M12: opencode emits {type:"error", error:{...}} JSON payloads with
        // exit code 0 for transient API failures. Without this branch the
        // engine treated those as success and downstream tasks ran on top
        // of the bogus output. Force a failure so the user sees a useful
        // error in the UI and skip_downstream / stop_all kick in.
        const reason = typeof json.error?.message === 'string'
          ? `opencode reported error: ${json.error.message}`
          : typeof json.error === 'string'
          ? `opencode reported error: ${json.error}`
          : 'opencode emitted an error JSON payload';
        return {
          forceFailure: true,
          forceFailureReason: reason,
        };
      }
      return {
        sessionId: json.session_id ?? json.sessionId ?? null,
        normalizedOutput: json.result ?? json.text ?? json.content ?? stdout,
      };
    } catch {
      return { normalizedOutput: stdout };
    }
  },
};

export const pluginCategory = 'drivers';
export const pluginType = 'opencode';
export default OpenCodeDriver;