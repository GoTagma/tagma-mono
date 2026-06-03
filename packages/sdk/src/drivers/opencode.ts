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

// NOTE on Windows multi-line prompts: `opencode` resolves to `opencode.cmd`,
// an npm-generated batch wrapper. cmd.exe silently truncates argv elements
// at the first newline, so a multi-line prompt reaches the model as only
// its first line. The SDK's runner auto-unwraps npm .cmd shims into direct
// `node <js-entry>` invocations so newlines survive, and this driver can
// keep using the bare `opencode` name on every platform.

// tagma uses a provider-neutral reasoning_effort vocabulary (low|medium|high)
// but opencode's `--variant` is provider-specific (e.g. high|max|minimal).
// Map the tagma values to the closest opencode variant:
//   low    -> minimal  (least thinking)
//   medium -> <no flag, provider default>
//   high   -> high     (most thinking)
// Unknown values pass through unchanged so users who target a specific
// opencode variant (e.g. "max") still work.
const EFFORT_TO_VARIANT: Record<string, string | null> = {
  low: 'minimal',
  medium: null,
  high: 'high',
};

function readSessionId(json: Record<string, unknown>): string | undefined {
  const sid = json.sessionID ?? json.session_id ?? json.sessionId;
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
}

function readErrorMessage(json: Record<string, unknown>): string | null {
  const err = json.error as { message?: unknown } | string | undefined;
  if (typeof err === 'object' && err !== null && typeof err.message === 'string') {
    return err.message;
  }
  if (typeof err === 'string') return err;
  return typeof json.message === 'string' ? json.message : null;
}

export const OpenCodeDriver: DriverPlugin = {
  name: 'opencode',

  capabilities: {
    sessionResume: true, // supports --session
    systemPrompt: false, // no --system-prompt flag; prepend to prompt instead
    outputFormat: true, // supports --format json
    enforcesPermissions: false,
  } satisfies DriverCapabilities,

  resolveModel(): string {
    return DEFAULT_MODEL;
  },

  async buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec> {
    const explicitModel = task.model ?? track.model;
    const model = explicitModel ?? DEFAULT_MODEL;
    // Resolve reasoning_effort to opencode --variant. SDK schema layer already
    // resolved task -> track -> pipeline inheritance, so we only need to read
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
      const sessionDriver = ctx.sessionDriverMap.get(task.continue_from);
      sessionId =
        sessionDriver === 'opencode' ? (ctx.sessionMap.get(task.continue_from) ?? null) : null;
      if (!sessionId) {
        // no session; degrade to text context passthrough
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
    // Windows cmd.exe argv truncation on the `.cmd` wrapper is handled by the
    // SDK runner's shim unwrapping; see note at the top of this file.
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
    // opencode --format json emits NDJSON: one JSON object per line
    // (step_start / text / step_finish / ...). The previous single
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

      // Session id: opencode uses `sessionID` (camelCase with capital D).
      // Keep `session_id` / `sessionId` as fallbacks for forward/backward
      // compatibility with other shapes. Extract before the error branch:
      // error events can still carry the session id needed for diagnostics or
      // same-driver recovery under `on_failure: ignore`.
      if (!sessionId) {
        sessionId = readSessionId(json);
      }

      // M12: opencode sometimes emits {type:"error", error:{...}} with
      // exit 0 for transient API failures. Force-fail so downstream
      // skip_downstream / stop_all kicks in.
      if (json.type === 'error') {
        const msg = readErrorMessage(json);
        errorReason = msg
          ? `opencode reported error: ${msg}`
          : 'opencode emitted an error JSON payload';
        // D21: stop at the first error. Continuing meant subsequent text
        // lines got accumulated into `textParts` only to be discarded by
        // the error-return below, and a later `{type:"error"}` would
        // silently overwrite the original cause; operators then debugged
        // a downstream symptom while the root-cause line scrolled past.
        break;
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
      return { sessionId, forceFailure: true, forceFailureReason: errorReason };
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
