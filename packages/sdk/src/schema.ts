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
import { assertWorkDir, workDirError } from './workdir';
import { withInferredPipelineSdkRequirement } from './compatibility';

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

/**
 * Parse a YAML string into a `RawPipelineConfig`.
 *
 * parseYaml is intentionally a *structural* parser: it only refuses inputs
 * that cannot be returned as a usable RawPipelineConfig at all (top-level
 * envelope wrong, tracks not an array, etc.). Every semantic rule  -
 * required name, valid id pattern, prompt/command exclusivity, duplicate
 * task / track ids, command shape - lives in `validateRaw`, where it
 * surfaces as a structured `ValidationError` instead of a thrown string
 * and lets editors highlight the offending node.
 *
 * Callers wanting full validation should pipe `parseYaml(content)` into
 * `validateRaw(raw)` (or just call `loadPipeline`, which does both). The
 * envelope checks here exist only to prevent downstream helpers
 * (`resolveConfig`, `serializePipeline`) from crashing on a malformed
 * value before validation has a chance to produce an error list.
 */
export function parseYaml(content: string): RawPipelineConfig {
  const doc = yaml.load(content) as { pipeline?: unknown };
  if (!doc?.pipeline) {
    throw new Error('YAML must contain a top-level "pipeline" key');
  }
  if (typeof doc.pipeline !== 'object' || Array.isArray(doc.pipeline)) {
    throw new Error('pipeline must be an object');
  }
  const p = doc.pipeline as RawPipelineConfig;
  if (!Array.isArray(p.tracks)) {
    throw new Error('pipeline.tracks must be an array');
  }
  // Per-track structural sanity. Anything beyond "is this an iterable
  // shape downstream code can walk without crashing" defers to
  // validateRaw, which produces structured diagnostics rather than a
  // single thrown error.
  for (let i = 0; i < p.tracks.length; i++) {
    const track = p.tracks[i] as unknown;
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(`pipeline.tracks[${i}] must be an object`);
    }
    const id = (track as { id?: unknown }).id;
    const trackLabel = typeof id === 'string' && id.length > 0 ? id : String(i);
    const tasks = (track as { tasks?: unknown }).tasks;
    if (tasks !== undefined && !Array.isArray(tasks)) {
      throw new Error(`track "${trackLabel}": tasks must be an array`);
    }
    // Task items themselves must be objects so downstream readers (BoardCanvas,
    // resolveConfig, validateRaw) can walk `.id`/`.prompt`/etc. without
    // crashing on `tasks: [null]` or `tasks: ['foo']` slipping through.
    if (Array.isArray(tasks)) {
      for (let j = 0; j < tasks.length; j++) {
        const task = tasks[j];
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
          throw new Error(`track "${trackLabel}": tasks[${j}] must be an object`);
        }
      }
    }
  }
  return p;
}

function commandNameFallback(command: CommandConfig | undefined, fallback: string): string {
  if (typeof command === 'string') return command;
  if (command && 'shell' in command) return command.shell;
  if (command && 'argv' in command) return command.argv.join(' ') || fallback;
  return fallback;
}

// ═══ Config Inheritance Resolution ═══

export function resolveConfig(raw: RawPipelineConfig, workDir: string): PipelineConfig {
  // Build qualified ID set for resolving bare continue_from references
  const allQualifiedIds = new Set<string>();
  for (const t of raw.tracks) {
    if (!t.id) continue;
    const tasks = Array.isArray(t.tasks) ? t.tasks : [];
    for (const tk of tasks) {
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

    const rawTasks = Array.isArray(rawTrack.tasks) ? rawTrack.tasks : [];
    const tasks: TaskConfig[] = rawTasks.map((rawTask) => {
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
        secrets: rawTask.secrets,
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
      secrets: rawTrack.secrets,
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
    requires: raw.requires,
    name: raw.name,
    secrets: raw.secrets,
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

function stripTrackForSerialization<
  T extends { readonly tasks?: readonly (TaskConfig | RawTaskConfig)[] },
>(track: T): T {
  if (!Array.isArray(track.tasks)) return track;
  return {
    ...track,
    tasks: track.tasks.map((task) =>
      stripPromptOnlyFieldsFromCommandTask(stripDefaultTaskCompletion(task)),
    ),
  } as T;
}

function stripForSerialization<T extends PipelineConfig | RawPipelineConfig>(config: T): T {
  return {
    ...config,
    tracks: config.tracks.map(stripTrackForSerialization),
  } as T;
}

// ═══ YAML Serialization ═══

/**
 * Serialize a pipeline config back to YAML string.
 * Wraps the config under the top-level `pipeline` key as expected by parseYaml.
 */
export function serializePipeline(config: PipelineConfig | RawPipelineConfig): string {
  return yaml.dump(
    { pipeline: withInferredPipelineSdkRequirement(stripForSerialization(config)) },
    { lineWidth: 120, indent: 2 },
  );
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
        task.cwd && task.cwd !== track.cwd ? relative(workDir, task.cwd) || '.' : undefined;

      return {
        id: task.id,
        ...(task.name ? { name: task.name } : {}),
        ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
        ...(isCommandTaskConfig(task) ? { command: task.command } : {}),
        ...(task.secrets?.length ? { secrets: task.secrets } : {}),
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
      ...(track.secrets?.length ? { secrets: track.secrets } : {}),
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
    ...(config.requires ? { requires: config.requires } : {}),
    name: config.name,
    ...(config.secrets?.length ? { secrets: config.secrets } : {}),
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
 *
 * Without `workDir`: only checks structural / DAG correctness. cwd path
 * safety is *not* enforced — the engine still rejects unsafe cwds at run
 * time, but you do not get an offline diagnostic for them.
 *
 * With `workDir`: also validates that every track / task `cwd` resolves
 * inside `workDir` (no `..` traversal, no absolute paths escaping the
 * root). Pass `workDir` when this is the final pre-run check; omit it
 * when the call site has no workDir (pure structural lint).
 *
 * Does not check plugin registration — use `validateRaw(config, knownTypes)`
 * for that. Returns an array of error message strings; empty means valid.
 */
export function validateConfig(config: PipelineConfig, workDir?: string): string[] {
  return validateConfigDiagnostics(config, workDir).map(formatDiagnostic);
}

export function validateConfigDiagnostics(
  config: PipelineConfig,
  workDir?: string,
): ValidationError[] {
  const errors: ValidationError[] = validateRaw(config as RawPipelineConfig).filter(
    (d) => d.severity !== 'warning',
  );

  if (workDir !== undefined) {
    const message = workDirError(workDir);
    if (message) {
      pushDiagnostic(errors, { path: 'workDir', message });
    } else {
      validateConfigCwd(config, workDir, errors);
    }
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

type CwdValidationConfig = {
  readonly tracks?: readonly unknown[];
};

function validateConfigCwd(config: unknown, workDir: string, errors: ValidationError[]): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const tracks = (config as CwdValidationConfig).tracks;
  if (!Array.isArray(tracks)) return;

  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (!track || typeof track !== 'object' || Array.isArray(track)) continue;
    const trackConfig = track as { readonly cwd?: unknown; readonly tasks?: readonly unknown[] };
    if (typeof trackConfig.cwd === 'string') {
      try {
        validatePath(trackConfig.cwd, workDir);
      } catch (err) {
        pushDiagnostic(errors, {
          path: `tracks[${ti}].cwd`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!Array.isArray(trackConfig.tasks)) continue;
    for (let ki = 0; ki < trackConfig.tasks.length; ki++) {
      const task = trackConfig.tasks[ki];
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
      const taskConfig = task as { readonly cwd?: unknown };
      if (typeof taskConfig.cwd !== 'string') continue;
      try {
        validatePath(taskConfig.cwd, workDir);
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
  assertWorkDir(workDir);
  const raw = parseYaml(yamlContent);
  const diagnostics = validateRaw(raw).filter((d) => d.severity !== 'warning');
  if (diagnostics.length === 0) {
    validateConfigCwd(raw, workDir, diagnostics);
  }
  if (diagnostics.length > 0) {
    throw new PipelineValidationError(diagnostics);
  }
  return resolveConfig(raw, workDir);
}
