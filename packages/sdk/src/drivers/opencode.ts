import type {
  DriverPlugin,
  DriverCapabilities,
  DriverResultMeta,
  TaskConfig,
  TrackConfig,
  DriverContext,
  SpawnSpec,
} from '../types';

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

// ── Auto-install + free-model picker ───────────────────────────────────────
//
// The opencode driver is SDK-built-in, but the `opencode` CLI isn't; we
// auto-install it on demand (via `bun install -g opencode-ai`) and pick a
// sensible default model from whatever the CLI reports. Both checks are
// process-cached via module-level variables so each concern runs at most
// once per SDK process.
//
// Design:
//   - User-provided `model:` wins; we only compute a default when it's empty.
//   - Failure modes never throw — they fall back to `DEFAULT_MODEL` and let
//     the subsequent `opencode run` spawn fail with its own error. Avoids
//     two confusing errors for one missing dependency.

interface OpencodeModelInfo {
  id?: string;
  providerID?: string;
  status?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
}

let opencodeReady: boolean | undefined;
let cachedDefaultModel: string | undefined;

async function runCapture(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch {
    return { code: -1, stdout: '', stderr: '' };
  }
}

async function ensureOpencodeInstalled(): Promise<boolean> {
  if (opencodeReady !== undefined) return opencodeReady;

  // Probe existing install first — users who already have it get no delay.
  const probe = await runCapture(['opencode', '--version']);
  if (probe.code === 0) {
    opencodeReady = true;
    return true;
  }

  console.error(
    '[driver:opencode] opencode CLI not found — installing via `bun install -g opencode-ai`... (this may take up to a minute)',
  );
  // Use inherit here so the user sees bun's own progress during the one-time
  // install; runCapture would swallow it.
  const install = Bun.spawn(['bun', 'install', '-g', 'opencode-ai'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const installCode = await install.exited;
  if (installCode !== 0) {
    console.error('[driver:opencode] install failed — opencode run will likely fail below.');
    opencodeReady = false;
    return false;
  }

  // Bun installs globals under `~/.bun/bin` (or `%USERPROFILE%\.bun\bin`),
  // which isn't on this process's cached PATH unless the user already has
  // bun set up. Ask bun for the directory and prepend it so bare `opencode`
  // resolves in this process without requiring a shell reload.
  const bin = await runCapture(['bun', 'pm', 'bin', '-g']);
  if (bin.code === 0) {
    const dir = bin.stdout.trim();
    const sep = process.platform === 'win32' ? ';' : ':';
    const current = process.env.PATH ?? '';
    if (dir && !current.split(sep).includes(dir)) {
      process.env.PATH = `${dir}${sep}${current}`;
    }
  }

  const verify = await runCapture(['opencode', '--version']);
  opencodeReady = verify.code === 0;
  if (!opencodeReady) {
    console.error(
      '[driver:opencode] `opencode` still not resolvable after install — check that bun global bin is on PATH.',
    );
  }
  return opencodeReady;
}

// `opencode models --verbose` emits "<provider>/<id>\n{...json...}\n" pairs.
// Walk balanced braces rather than split on newlines so we survive any
// whitespace oddities in the JSON payload.
function parseVerboseModels(stdout: string): OpencodeModelInfo[] {
  const out: OpencodeModelInfo[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stdout.length; i++) {
    const c = stdout[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(stdout.slice(start, i + 1)) as OpencodeModelInfo);
        } catch {
          /* skip malformed block */
        }
        start = -1;
      }
    }
  }
  return out;
}

function pickFreeModel(models: OpencodeModelInfo[]): string | null {
  const fullId = (m: OpencodeModelInfo): string =>
    `${m.providerID ?? 'opencode'}/${m.id ?? ''}`;
  const eligible = models.filter((m) => {
    if (!m.id || m.id === 'big-pickle') return false;
    if (m.status && m.status !== 'active') return false;
    const cost = m.cost;
    if (!cost || cost.input !== 0 || cost.output !== 0) return false;
    const ctx = m.limit?.context;
    if (typeof ctx !== 'number' || ctx <= 128000) return false;
    return true;
  });
  // Prefer models explicitly labelled "-free" by the provider — those are
  // a stronger stability signal than "cost happens to be 0 right now".
  const preferred = eligible.filter((m) => m.id?.endsWith('-free'));
  const pool = preferred.length > 0 ? preferred : eligible;
  if (pool.length === 0) return null;
  // Deterministic pick: sort by full id so upstream model-list reordering
  // doesn't flip our choice between runs.
  pool.sort((a, b) => fullId(a).localeCompare(fullId(b)));
  return fullId(pool[0]);
}

async function resolveDefaultModel(): Promise<string> {
  if (cachedDefaultModel !== undefined) return cachedDefaultModel;
  const ready = await ensureOpencodeInstalled();
  if (!ready) {
    cachedDefaultModel = DEFAULT_MODEL;
    return cachedDefaultModel;
  }
  console.error('[driver:opencode] resolving free opencode model...');
  const { code, stdout } = await runCapture(['opencode', 'models', '--verbose']);
  if (code !== 0) {
    cachedDefaultModel = DEFAULT_MODEL;
    return cachedDefaultModel;
  }
  const picked = pickFreeModel(parseVerboseModels(stdout));
  cachedDefaultModel = picked ?? DEFAULT_MODEL;
  console.error(`[driver:opencode] default model: ${cachedDefaultModel}`);
  return cachedDefaultModel;
}

export const OpenCodeDriver: DriverPlugin = {
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
    const explicitModel = task.model ?? track.model;
    // Always make sure the opencode CLI is usable before we spawn it — even
    // when the user pinned a model. If missing, ensureOpencodeInstalled
    // auto-installs it via `bun install -g opencode-ai`.
    if (explicitModel) await ensureOpencodeInstalled();
    // Otherwise resolveDefaultModel both ensures the CLI and picks a free
    // model from `opencode models --verbose` (cached per-process).
    const model = explicitModel ?? (await resolveDefaultModel());
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
    // Windows cmd.exe argv truncation on the `.cmd` wrapper is handled by the
    // SDK runner's shim unwrapping — see note at the top of this file.
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
        // D21: stop at the first error. Continuing meant subsequent text
        // lines got accumulated into `textParts` only to be discarded by
        // the error-return below, and a later `{type:"error"}` would
        // silently overwrite the original cause — operators then debugged
        // a downstream symptom while the root-cause line scrolled past.
        break;
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
