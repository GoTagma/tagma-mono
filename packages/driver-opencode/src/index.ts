import type {
  DriverPlugin,
  DriverCapabilities,
  DriverResultMeta,
  TaskConfig,
  TrackConfig,
  DriverContext,
  SpawnSpec,
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
    sessionResume: true, // supports --session
    systemPrompt: false, // no --system-prompt flag; prepend to prompt instead
    outputFormat: true, // supports --format json
  } satisfies DriverCapabilities,

  resolveModel(): string {
    return DEFAULT_MODEL;
  },

  async buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec> {
    const model = task.model ?? track.model ?? DEFAULT_MODEL;
    // Resolve reasoning_effort → opencode --variant. SDK schema layer already
    // resolved task → track → pipeline inheritance, so we only need to read
    // task.reasoning_effort here.
    const rawEffort = task.reasoning_effort ?? track.reasoning_effort;
    const variant = rawEffort
      ? rawEffort in EFFORT_TO_VARIANT
        ? EFFORT_TO_VARIANT[rawEffort]
        : rawEffort
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
      '--model',
      model,
      '--format',
      'json', // JSON output for parseResult
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
    // opencode --format json emits NDJSON — one JSON object per line
    // (step_start / text / step_finish / …). The previous single
    // `JSON.parse(stdout)` always threw on this shape and fell through to
    // the catch, returning sessionId:null and losing session resume.
    // Walk line-by-line, pick up the first sessionID we see, concatenate
    // any text-type parts into normalizedOutput, and bail early on error
    // payloads.
    const lines = stdout.split(/\r?\n/);
    let sessionId: string | undefined;
    const textParts: string[] = [];
    let sawAnyJson = false;
    let errorReason: string | null = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // tolerate interleaved non-JSON noise
      }
      sawAnyJson = true;

      // M12: opencode sometimes emits {type:"error", error:{...}} with
      // exit 0 for transient API failures. Force-fail so downstream
      // skip_downstream / stop_all kicks in.
      if (json.type === 'error') {
        const err = json.error as { message?: unknown } | string | undefined;
        const msg =
          typeof err === 'object' && err !== null && typeof err.message === 'string'
            ? err.message
            : typeof err === 'string'
              ? err
              : null;
        errorReason = msg
          ? `opencode reported error: ${msg}`
          : 'opencode emitted an error JSON payload';
        continue;
      }

      // Session id — opencode uses `sessionID` (camelCase with capital D).
      // Keep `session_id` / `sessionId` as fallbacks for forward/backward
      // compatibility with other shapes.
      if (!sessionId) {
        const sid =
          (json.sessionID as string | undefined) ??
          (json.session_id as string | undefined) ??
          (json.sessionId as string | undefined) ??
          null;
        if (typeof sid === 'string' && sid.length > 0) sessionId = sid;
      }

      // Extract human-readable text from text-type parts.
      if (json.type === 'text') {
        const part = json.part as { text?: unknown } | undefined;
        if (part && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      } else if (typeof json.result === 'string') {
        textParts.push(json.result);
      } else if (typeof json.content === 'string') {
        textParts.push(json.content);
      }
    }

    if (errorReason) {
      return { forceFailure: true, forceFailureReason: errorReason };
    }

    // If nothing parsed as JSON, treat stdout as plain text.
    const normalizedOutput = !sawAnyJson
      ? stdout
      : textParts.length > 0
        ? textParts.join('\n')
        : stdout;

    return {
      sessionId,
      normalizedOutput,
    };
  },
};

export const pluginCategory = 'drivers';
export const pluginType = 'opencode';
export default OpenCodeDriver;
