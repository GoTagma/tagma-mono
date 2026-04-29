import yaml from 'js-yaml';
import { relative } from 'path';
import type {
  CommandConfig,
  PipelineConfig,
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
  TrackConfig,
  TaskConfig,
  Permissions,
  CompletionConfig,
} from '@tagma/types';
import { isCommandTaskConfig } from '@tagma/types';
import { buildDag, DEFAULT_PERMISSIONS, truncateForName, validatePath } from '@tagma/core';
import { validateRaw, type ValidationError } from './validate-raw';

export class PipelineValidationError extends Error {
  readonly diagnostics: readonly ValidationError[];

  constructor(diagnostics: readonly ValidationError[]) {
    super(
      `Pipeline validation failed:\n${diagnostics
        .map((d) => `  - ${d.path}: ${d.message}`)
        .join('\n')}`,
    );
    this.name = 'PipelineValidationError';
    this.diagnostics = diagnostics;
  }
}

// ═══ YAML Parsing ═══

export function parseYaml(content: string): RawPipelineConfig {
  const doc = yaml.load(content) as { pipeline?: unknown };
  if (!doc?.pipeline) {
    throw new Error('YAML must contain a top-level "pipeline" key');
  }
  if (typeof doc.pipeline !== 'object' || Array.isArray(doc.pipeline)) {
    throw new Error('pipeline must be an object');
  }
  const p = doc.pipeline as RawPipelineConfig;
  if (!p.name) throw new Error('pipeline.name is required');
  if (!Array.isArray(p.tracks)) throw new Error('pipeline.tracks must be an array');
  if (p.tracks.length === 0) throw new Error('pipeline.tracks must be non-empty');

  // D14: Detect duplicate track IDs before per-track validation so the error
  // message is clear ("Duplicate track id") rather than a confusing DAG error
  // ("Duplicate task ID: track.task_x") that only surfaces at runPipeline time.
  const seenTrackIds = new Set<string>();
  for (const track of p.tracks) {
    if (track.id) {
      if (seenTrackIds.has(track.id)) {
        throw new Error(`Duplicate track id "${track.id}": each track must have a unique id.`);
      }
      seenTrackIds.add(track.id);
    }
  }

  for (const track of p.tracks) {
    validateRawTrack(track);
  }
  return p;
}

// D8: IDs must start with a letter or underscore and contain only
// alphanumerics, underscores, and hyphens. Dots are forbidden because
// the engine uses "trackId.taskId" as the qualified separator — a dot in
// either part creates an ambiguous qualified ID and breaks resolveRef.
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function assertValidId(id: string, label: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(
      `${label}: id "${id}" is invalid. IDs must match /^[A-Za-z_][A-Za-z0-9_-]*$/ ` +
        `(letters, digits, underscores, hyphens; no dots or spaces; must start with letter/underscore).`,
    );
  }
}

function validateRawTrack(track: RawTrackConfig): void {
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    throw new Error('track must be an object');
  }
  if (!track.id) throw new Error('track.id is required');
  assertValidId(track.id, `track "${track.id}"`);
  if (!track.name) throw new Error(`track "${track.id}": name is required`);
  if (!Array.isArray(track.tasks)) {
    throw new Error(`track "${track.id}": tasks must be an array`);
  }
  if (track.tasks.length === 0) {
    throw new Error(`track "${track.id}": tasks must be non-empty`);
  }
  for (const task of track.tasks) {
    validateRawTask(task, track.id);
  }
}

function commandConfigKind(value: unknown): 'shell' | 'argv' | null {
  if (typeof value === 'string') return 'shell';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const hasShell = 'shell' in raw;
  const hasArgv = 'argv' in raw;
  if (hasShell === hasArgv) return null;
  if (hasShell) return typeof raw.shell === 'string' ? 'shell' : null;
  return Array.isArray(raw.argv) && raw.argv.every((arg) => typeof arg === 'string')
    ? 'argv'
    : null;
}

function commandNameFallback(command: CommandConfig | undefined, fallback: string): string {
  if (typeof command === 'string') return command;
  if (command && 'shell' in command) return command.shell;
  if (command && 'argv' in command) return command.argv.join(' ') || fallback;
  return fallback;
}

function validateCommandConfig(command: unknown, label: string): void {
  const kind = commandConfigKind(command);
  if (kind === null) {
    throw new Error(`${label}: command must be a shell string, { shell: string }, or { argv: string[] }`);
  }
  if (typeof command === 'string') {
    if (command.trim().length === 0) throw new Error(`${label}: command must not be empty`);
    return;
  }
  const raw = command as { shell?: string; argv?: readonly string[] };
  if (kind === 'shell') {
    if (!raw.shell || raw.shell.trim().length === 0) {
      throw new Error(`${label}: command.shell must not be empty`);
    }
    return;
  }
  if (!raw.argv || raw.argv.length === 0 || raw.argv.some((arg) => arg.length === 0)) {
    throw new Error(`${label}: command.argv must contain non-empty string arguments`);
  }
}

function validateRawTask(task: RawTaskConfig, trackId: string): void {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`track "${trackId}": task must be an object`);
  }
  if (!task.id) throw new Error(`track "${trackId}": task.id is required`);
  assertValidId(task.id, `task "${task.id}" in track "${trackId}"`);
  if ('ports' in (task as unknown as Record<string, unknown>)) {
    throw new Error(`task "${task.id}": ports is not supported; use inputs/outputs`);
  }

  const hasPromptKey = typeof task.prompt === 'string';
  const hasCommandField = isCommandTaskConfig(task);
  const hasCommandKey = commandConfigKind(task.command) !== null;
  if (!hasPromptKey && !hasCommandField) {
    throw new Error(`task "${task.id}": must have either "prompt" or "command"`);
  }
  if (hasPromptKey && hasCommandKey) {
    throw new Error(`task "${task.id}": cannot have both "prompt" and "command"`);
  }
  if (hasCommandField) {
    validateCommandConfig(task.command, `task "${task.id}"`);
  }
  // Empty-content tasks (e.g. `prompt: ''`) are allowed at parse time and
  // flagged as hard validation errors by validate-raw.ts.
}

// ═══ Config Inheritance Resolution ═══

export function resolveConfig(raw: RawPipelineConfig, workDir: string): PipelineConfig {
  // Build qualified ID set for resolving bare continue_from references
  const allQualifiedIds = new Set<string>();
  for (const t of raw.tracks) {
    if (!t.id) continue;
    for (const tk of t.tasks ?? []) {
      if (tk.id) allQualifiedIds.add(`${t.id}.${tk.id}`);
    }
  }

  function qualifyContinueFrom(ref: string, trackId: string): string {
    // Already qualified
    if (allQualifiedIds.has(ref)) return ref;
    // Same-track shorthand
    const sameTrack = `${trackId}.${ref}`;
    if (allQualifiedIds.has(sameTrack)) return sameTrack;
    // Cross-track bare lookup — must be unambiguous
    let match: string | null = null;
    for (const qid of allQualifiedIds) {
      if (qid.endsWith(`.${ref}`)) {
        if (match !== null) return ref; // ambiguous — leave as-is
        match = qid;
      }
    }
    return match ?? ref; // not found — leave as-is (validated elsewhere)
  }

  const tracks: TrackConfig[] = raw.tracks.map((rawTrack) => {
    const trackDriver = rawTrack.driver ?? raw.driver;
    // validatePath enforces no .. traversal and no absolute paths escaping workDir.
    const trackCwd = rawTrack.cwd ? validatePath(rawTrack.cwd, workDir) : workDir;

    const tasks: TaskConfig[] = rawTrack.tasks.map((rawTask) => {
      const name =
        rawTask.name ??
        (rawTask.prompt
          ? truncateForName(rawTask.prompt)
          : commandNameFallback(rawTask.command, rawTask.id));

      return {
        id: rawTask.id,
        name,
        prompt: rawTask.prompt,
        command: rawTask.command,
        depends_on: rawTask.depends_on,
        trigger: rawTask.trigger,
        continue_from: rawTask.continue_from
          ? qualifyContinueFrom(rawTask.continue_from, rawTrack.id)
          : undefined,
        // Inheritance: Task > Track > Pipeline
        model: rawTask.model ?? rawTrack.model ?? raw.model,
        reasoning_effort:
          rawTask.reasoning_effort ?? rawTrack.reasoning_effort ?? raw.reasoning_effort,
        permissions:
          rawTask.permissions ?? rawTrack.permissions ?? raw.permissions ?? DEFAULT_PERMISSIONS,
        driver: rawTask.driver ?? trackDriver ?? 'opencode',
        timeout: rawTask.timeout,
        // Middleware: Task-level overrides Track (including [] to disable)
        middlewares: rawTask.middlewares !== undefined ? rawTask.middlewares : rawTrack.middlewares,
        completion: rawTask.completion,
        agent_profile: rawTask.agent_profile ?? rawTrack.agent_profile,
        cwd: rawTask.cwd ? validatePath(rawTask.cwd, workDir) : trackCwd,
        // Unified bindings have no inheritance; they describe
        // per-task data flow, not cross-task defaults.
        inputs: rawTask.inputs,
        outputs: rawTask.outputs,
      };
    });

    return {
      id: rawTrack.id,
      name: rawTrack.name,
      color: rawTrack.color,
      agent_profile: rawTrack.agent_profile,
      model: rawTrack.model ?? raw.model,
      reasoning_effort: rawTrack.reasoning_effort ?? raw.reasoning_effort,
      permissions: rawTrack.permissions ?? raw.permissions ?? DEFAULT_PERMISSIONS,
      driver: trackDriver ?? 'opencode',
      cwd: trackCwd,
      middlewares: rawTrack.middlewares,
      on_failure: rawTrack.on_failure ?? 'skip_downstream',
      tasks,
    };
  });

  return {
    name: raw.name,
    mode: raw.mode,
    driver: raw.driver,
    model: raw.model,
    reasoning_effort: raw.reasoning_effort,
    permissions: raw.permissions,
    timeout: raw.timeout,
    max_concurrency: raw.max_concurrency,
    plugins: raw.plugins,
    hooks: raw.hooks,
    tracks,
  };
}

// Field-by-field permissions comparison — avoids relying on JSON.stringify key order.
function permissionsEqual(a: Permissions | undefined, b: Permissions | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.read === b.read && a.write === b.write && a.execute === b.execute;
}

function isDefaultExitCodeCompletion(completion: CompletionConfig | undefined): boolean {
  if (!completion || completion.type !== 'exit_code') return false;
  const {
    type: _type,
    expect,
    ...rest
  } = completion as CompletionConfig & {
    expect?: unknown;
  };
  if (Object.keys(rest).length > 0) return false;
  return expect === undefined || expect === 0;
}

function stripDefaultTaskCompletion<T extends { completion?: CompletionConfig }>(task: T): T {
  if (!isDefaultExitCodeCompletion(task.completion)) return task;
  const { completion: _completion, ...rest } = task;
  return rest as T;
}

// `continue_from` is a prompt-only field — it tells AI drivers with
// session-resume capability to thread off an upstream prompt task's context.
// A command task runs as a plain shell subprocess and has no session to
// resume, so any `continue_from` on a command task is dead weight. Drop it
// at serialization time so YAML on disk never carries the stale field after
// a user toggles task mode from prompt → command. The tagma-yaml agent's
// system prompt (apps/editor/server/opencode-seed.ts) documents this
// stripping — keep them in sync.
function stripPromptOnlyFieldsFromCommandTask<
  T extends { command?: CommandConfig; continue_from?: string },
>(task: T): T {
  if (!isCommandTaskConfig(task) || task.continue_from === undefined) return task;
  const { continue_from: _cf, ...rest } = task;
  return rest as T;
}

function stripForSerialization<T extends PipelineConfig | RawPipelineConfig>(config: T): T {
  return {
    ...config,
    tracks: config.tracks.map((track) => ({
      ...track,
      tasks: track.tasks.map((task) =>
        stripPromptOnlyFieldsFromCommandTask(stripDefaultTaskCompletion(task)),
      ),
    })),
  } as T;
}

// ═══ YAML Serialization ═══

/**
 * Serialize a pipeline config back to YAML string.
 * Wraps the config under the top-level `pipeline` key as expected by parseYaml.
 */
export function serializePipeline(config: PipelineConfig | RawPipelineConfig): string {
  return yaml.dump({ pipeline: stripForSerialization(config) }, { lineWidth: 120, indent: 2 });
}

/**
 * Convert a resolved PipelineConfig back to a RawPipelineConfig for serialization.
 * Strips injected defaults and converts absolute cwd paths back to relative so the
 * resulting YAML is portable across machines.
 *
 * Use this when you need to save a config that was previously loaded via
 * loadPipeline(). For a pure load→edit→save cycle on raw YAML, prefer
 * parseYaml() → edit RawPipelineConfig → serializePipeline().
 */
export function deresolvePipeline(config: PipelineConfig, workDir: string): RawPipelineConfig {
  const tracks: RawTrackConfig[] = config.tracks.map((track) => {
    const trackCwdRel =
      track.cwd && track.cwd !== workDir ? relative(workDir, track.cwd) : undefined;
    const effectiveTrackDriver = track.driver ?? config.driver ?? 'opencode';
    const effectiveTrackModel = track.model ?? config.model;
    const effectiveTrackReasoning = track.reasoning_effort ?? config.reasoning_effort;

    const tasks: RawTaskConfig[] = track.tasks.map((task) => {
      const taskCwdRel =
        task.cwd && task.cwd !== track.cwd ? relative(workDir, task.cwd) : undefined;

      return {
        id: task.id,
        ...(task.name ? { name: task.name } : {}),
        ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
        ...(isCommandTaskConfig(task) ? { command: task.command } : {}),
        ...(task.depends_on?.length ? { depends_on: task.depends_on } : {}),
        ...(task.trigger ? { trigger: task.trigger } : {}),
        ...(task.continue_from ? { continue_from: task.continue_from } : {}),
        ...(taskCwdRel ? { cwd: taskCwdRel } : {}),
        ...(task.model && task.model !== effectiveTrackModel ? { model: task.model } : {}),
        ...(task.reasoning_effort && task.reasoning_effort !== effectiveTrackReasoning
          ? { reasoning_effort: task.reasoning_effort }
          : {}),
        ...(task.driver && task.driver !== effectiveTrackDriver ? { driver: task.driver } : {}),
        ...(task.timeout ? { timeout: task.timeout } : {}),
        ...(task.middlewares !== undefined ? { middlewares: task.middlewares } : {}),
        ...(task.completion && !isDefaultExitCodeCompletion(task.completion)
          ? { completion: task.completion }
          : {}),
        ...(task.agent_profile ? { agent_profile: task.agent_profile } : {}),
        ...(task.permissions && !permissionsEqual(task.permissions, track.permissions)
          ? { permissions: task.permissions }
          : {}),
        ...(task.inputs && Object.keys(task.inputs).length > 0 ? { inputs: task.inputs } : {}),
        ...(task.outputs && Object.keys(task.outputs).length > 0 ? { outputs: task.outputs } : {}),
      };
    });

    return {
      id: track.id,
      name: track.name,
      ...(track.color ? { color: track.color } : {}),
      ...(track.agent_profile ? { agent_profile: track.agent_profile } : {}),
      ...(track.model && track.model !== config.model ? { model: track.model } : {}),
      ...(track.reasoning_effort && track.reasoning_effort !== config.reasoning_effort
        ? { reasoning_effort: track.reasoning_effort }
        : {}),
      ...(track.driver && track.driver !== (config.driver ?? 'opencode')
        ? { driver: track.driver }
        : {}),
      ...(trackCwdRel ? { cwd: trackCwdRel } : {}),
      ...(track.middlewares?.length ? { middlewares: track.middlewares } : {}),
      ...(track.on_failure && track.on_failure !== 'skip_downstream'
        ? { on_failure: track.on_failure }
        : {}),
      ...(track.permissions &&
      !permissionsEqual(track.permissions, config.permissions ?? DEFAULT_PERMISSIONS)
        ? { permissions: track.permissions }
        : {}),
      tasks,
    };
  });

  return {
    name: config.name,
    ...(config.mode ? { mode: config.mode } : {}),
    ...(config.driver ? { driver: config.driver } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}),
    ...(config.permissions && !permissionsEqual(config.permissions, DEFAULT_PERMISSIONS)
      ? { permissions: config.permissions }
      : {}),
    ...(config.timeout ? { timeout: config.timeout } : {}),
    ...(config.max_concurrency !== undefined ? { max_concurrency: config.max_concurrency } : {}),
    ...(config.plugins?.length ? { plugins: config.plugins } : {}),
    ...(config.hooks ? { hooks: config.hooks } : {}),
    tracks,
  };
}

// ═══ Offline Validation ═══

/**
 * Validate a pipeline config without executing it.
 * Only checks structural/DAG correctness — does not check plugin registration.
 * Returns an array of error messages (empty = valid).
 */
export function validateConfig(config: PipelineConfig): string[] {
  return validateConfigDiagnostics(config).map(formatDiagnostic);
}

export function validateConfigDiagnostics(
  config: PipelineConfig,
  workDir?: string,
): ValidationError[] {
  const errors: ValidationError[] = validateRaw(config as RawPipelineConfig).filter(
    (d) => d.severity !== 'warning',
  );

  if (workDir !== undefined) {
    validateConfigCwd(config, workDir, errors);
  }

  if (errors.length === 0) {
    try {
      buildDag(config);
    } catch (err) {
      pushDiagnostic(errors, {
        path: 'tracks',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return errors;
}

function validateConfigCwd(
  config: PipelineConfig,
  workDir: string,
  errors: ValidationError[],
): void {
  for (let ti = 0; ti < config.tracks.length; ti++) {
    const track = config.tracks[ti]!;
    if (track.cwd !== undefined) {
      try {
        validatePath(track.cwd, workDir);
      } catch (err) {
        pushDiagnostic(errors, {
          path: `tracks[${ti}].cwd`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (let ki = 0; ki < track.tasks.length; ki++) {
      const task = track.tasks[ki]!;
      if (task.cwd === undefined) continue;
      try {
        validatePath(task.cwd, workDir);
      } catch (err) {
        pushDiagnostic(errors, {
          path: `tracks[${ti}].tasks[${ki}].cwd`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function pushDiagnostic(errors: ValidationError[], diagnostic: ValidationError): void {
  if (
    errors.some(
      (existing) => existing.path === diagnostic.path && existing.message === diagnostic.message,
    )
  ) {
    return;
  }
  errors.push(diagnostic);
}

function formatDiagnostic(diagnostic: ValidationError): string {
  return `${diagnostic.path}: ${diagnostic.message}`;
}

// ═══ Full Parse Pipeline ═══

export async function loadPipeline(yamlContent: string, workDir: string): Promise<PipelineConfig> {
  const raw = parseYaml(yamlContent);
  const diagnostics = validateRaw(raw).filter((d) => d.severity !== 'warning');
  if (diagnostics.length > 0) {
    throw new PipelineValidationError(diagnostics);
  }
  return resolveConfig(raw, workDir);
}
