// Raw Pipeline Config Validation
//
// Validates a RawPipelineConfig without resolving inheritance or executing
// anything  - intended for real-time feedback in a visual editor (e.g. drag
// to add a task, live error highlighting).
//
// Returns a flat list of ValidationError objects. An empty array means valid.

import type {
  CommandConfig,
  PluginSchema,
  PortType,
  RawPipelineConfig,
  RawTaskConfig,
  RawTrackConfig,
} from '@tagma/types';
import { isCommandTaskConfig, isPromptTaskConfig } from '@tagma/types';
import {
  INVALID_TASK_ID_REASON,
  isValidTaskId,
  qualifyTaskId,
  buildTaskIndex,
  resolveTaskRef,
  validatePluginConfig,
  type TaskIndex,
} from '@tagma/core';
import { extractInputReferences } from '@tagma/core';

interface QidEntry {
  readonly track: RawTrackConfig;
  readonly task: RawTaskConfig;
}

/** qid ->{track, task} lookup built once per validation pass. */
function buildQidIndex(config: RawPipelineConfig): Map<string, QidEntry> {
  const idx = new Map<string, QidEntry>();
  for (const track of config.tracks ?? []) {
    if (!track || typeof track !== 'object') continue;
    if (!isValidTaskId(track.id)) continue;
    if (!Array.isArray(track.tasks)) continue;
    for (const task of track.tasks ?? []) {
      if (!task || typeof task !== 'object') continue;
      if (!isValidTaskId(task.id)) continue;
      idx.set(qualifyTaskId(track.id, task.id), { track, task });
    }
  }
  return idx;
}

const DURATION_RE = /^(\d*\.?\d+)\s*(s|m|h|d)$/;
const MAX_TIMER_DURATION_MS = 2_147_483_647;

type DurationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'format' | 'range' };

function validateDuration(input: unknown): DurationValidation {
  if (typeof input !== 'string') return { ok: false, reason: 'format' };
  const match = DURATION_RE.exec(input.trim());
  if (!match) return { ok: false, reason: 'format' };
  const value = parseFloat(match[1]);
  const unit = match[2];
  const ms = (() => {
    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60_000;
      case 'h':
        return value * 3_600_000;
      case 'd':
        return value * 86_400_000;
      default:
        return Number.NaN;
    }
  })();
  if (!Number.isFinite(ms) || ms > MAX_TIMER_DURATION_MS) {
    return { ok: false, reason: 'range' };
  }
  return { ok: true };
}

function durationErrorMessage(
  input: unknown,
  validation: Exclude<DurationValidation, { ok: true }>,
): string {
  const label = String(input);
  if (validation.reason === 'range') {
    return `Duration "${label}" exceeds maximum supported timeout of ${MAX_TIMER_DURATION_MS}ms.`;
  }
  return `Invalid duration format "${label}". Expected e.g. "30s", "5m", "1h".`;
}

// D8: IDs may only contain letters, digits, underscores, and hyphens, and must
// start with a letter or underscore. Dots are explicitly forbidden because the
// engine uses "trackId.taskId" as the qualified separator  - a dot in either
// part creates an ambiguous qualified ID and breaks resolveRef.
// Canonical regex and helper live in ./task-ref so every resolver (dag.ts,
// engine.ts, editor) stays in lockstep with what we accept here.
const isValidId = isValidTaskId;

const VALID_ON_FAILURE = new Set(['skip_downstream', 'stop_all', 'ignore']);
const VALID_PIPELINE_MODES = new Set(['trusted', 'safe']);
const PERMISSION_FIELDS = ['read', 'write', 'execute'] as const;

// Built-in plugin types always known to the SDK core, regardless of which
// external plugin packages are installed. These MUST stay in sync with the
// types that `bootstrapBuiltins()` registers, otherwise the editor will
// emit false-positive "unknown type" warnings for stock pipelines.
const BUILTIN_TRIGGER_TYPES: ReadonlySet<string> = new Set(['manual', 'file']);
const BUILTIN_COMPLETION_TYPES: ReadonlySet<string> = new Set([
  'exit_code',
  'file_exists',
  'output_check',
]);
const BUILTIN_MIDDLEWARE_TYPES: ReadonlySet<string> = new Set(['static_context']);
const BUILTIN_DRIVER_TYPES: ReadonlySet<string> = new Set(['opencode']);

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

function validateCommandConfig(
  value: unknown,
  path: string,
  label: string,
  errors: ValidationError[],
): value is CommandConfig {
  const kind = commandConfigKind(value);
  if (kind === null) {
    errors.push({
      path,
      message: `${label} must be a non-empty shell string, { shell: string }, or { argv: string[] }`,
    });
    return false;
  }
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      errors.push({ path, message: `${label} shell string must not be empty` });
      return false;
    }
    return true;
  }
  const raw = value as { shell?: string; argv?: readonly string[] };
  if (kind === 'shell') {
    if (!raw.shell || raw.shell.trim().length === 0) {
      errors.push({ path: `${path}.shell`, message: `${label}.shell must not be empty` });
      return false;
    }
    return true;
  }
  if (!raw.argv || raw.argv.length === 0) {
    errors.push({
      path: `${path}.argv`,
      message: `${label}.argv must contain at least one argument`,
    });
    return false;
  }
  raw.argv.forEach((arg, index) => {
    if (arg.length === 0) {
      errors.push({
        path: `${path}.argv[${index}]`,
        message: `${label}.argv entries must not be empty`,
      });
    }
  });
  return true;
}

function commandInputReferences(command: CommandConfig): string[] {
  if (typeof command === 'string') return extractInputReferences(command);
  if ('shell' in command) return extractInputReferences(command.shell);
  const refs = new Set<string>();
  for (const arg of command.argv) {
    for (const ref of extractInputReferences(arg)) refs.add(ref);
  }
  return [...refs];
}

/**
 * Optional second argument to `validateRaw`: the set of plugin types currently
 * registered in the SDK runtime, keyed by category. Hosts (e.g. the editor
 * server) pass this so `validateRaw` can emit a soft warning when a task
 * references a type that isn't loaded  - otherwise the Task panel would show
 * no hint and the pipeline would only blow up at run time. Callers that
 * legitimately validate a config offline (before plugins are loaded) can omit
 * this argument and no plugin warnings will be produced.
 *
 * Plugin schemas (optional `schemas` field) elevate plugin config from "type
 * exists" to "type exists AND every config field matches the declared
 * schema". When a host supplies the schema for a registered trigger /
 * completion / middleware type, the same per-field checks core preflight
 * runs at engine startup (e.g. `timeout: duration` is parsed strictly,
 * `kind: enum` must be one of the declared values) fire here at edit time -
 * users see the underlying error in their editor instead of waiting for a
 * preflight failure. Hosts can collect schemas from the registry via
 * `registry.getHandler(category, type).schema`. Missing entries fall back
 * to name-only checks (no per-field validation).
 */
export interface KnownPluginTypes {
  readonly drivers?: readonly string[];
  readonly triggers?: readonly string[];
  readonly completions?: readonly string[];
  readonly middlewares?: readonly string[];
  readonly schemas?: KnownPluginSchemas;
}

export interface KnownPluginSchemas {
  readonly triggers?: Readonly<Record<string, PluginSchema | undefined>>;
  readonly completions?: Readonly<Record<string, PluginSchema | undefined>>;
  readonly middlewares?: Readonly<Record<string, PluginSchema | undefined>>;
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationError {
  /** JSONPath-style location, e.g. "tracks[0].tasks[1].prompt" */
  path: string;
  message: string;
  /**
   * H8: not all "errors" are equally fatal. The DAG runtime is happy to
   * insert implicit `continue_from ->depends_on` ordering, so the matching
   * validate-raw check is a *style* nit, not a hard failure. Severity lets
   * the editor render it as a soft warning instead of blocking save / run.
   * Existing call sites that don't read this field still treat every entry
   * as fatal  - defaulting `severity` to undefined preserves that behaviour.
   */
  severity?: ValidationSeverity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringList(
  value: unknown,
  path: string,
  label: string,
  errors: ValidationError[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: `${label} must be an array of strings` });
    return [];
  }
  const refs: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push({ path: `${path}[${i}]`, message: `${label} entries must be non-empty strings` });
      continue;
    }
    refs.push(item);
  }
  return refs;
}

function dependencyRefs(task: RawTaskConfig): readonly string[] {
  return Array.isArray(task.depends_on)
    ? task.depends_on.filter((dep): dep is string => typeof dep === 'string' && dep.length > 0)
    : [];
}

function validatePluginRef(
  value: unknown,
  path: string,
  label: string,
  errors: ValidationError[],
): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    errors.push({ path, message: `${label} must be an object with a non-empty type` });
    return null;
  }
  if (!isNonEmptyString(value.type)) {
    errors.push({ path: `${path}.type`, message: `${label}.type must be a non-empty string` });
    return null;
  }
  return value.type;
}

/**
 * Run core's `validatePluginConfig` against a trigger / completion /
 * middleware config object and lift the returned strings into the
 * validate-raw `ValidationError` shape. The schema's per-field messages
 * already carry the precise location (`<basePath>.<field>`); we keep
 * `path` at the plugin-config root so editors can highlight the whole
 * block, and put the full message in `message` so the field is named.
 *
 * No-ops when `schema` is undefined (caller didn't supply it) or when
 * `config` isn't a plain object (the structural validator has already
 * pushed an error for that earlier).
 */
function pushSchemaErrors(
  schema: PluginSchema | undefined,
  config: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (!schema) return;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  for (const message of validatePluginConfig(
    schema,
    config as Record<string, unknown>,
    basePath,
  )) {
    errors.push({ path: basePath, message });
  }
}

function validateMiddlewareList(
  value: unknown,
  path: string,
  errors: ValidationError[],
): readonly { readonly index: number; readonly type: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'middlewares must be an array of objects' });
    return [];
  }
  const types: { index: number; type: string }[] = [];
  for (let i = 0; i < value.length; i++) {
    const type = validatePluginRef(value[i], `${path}[${i}]`, 'middleware', errors);
    if (type !== null) types.push({ index: i, type });
  }
  return types;
}

const HOOK_FIELDS = [
  'pipeline_start',
  'task_start',
  'task_success',
  'task_failure',
  'pipeline_complete',
  'pipeline_error',
] as const;

function validateHooks(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push({ path: 'hooks', message: 'hooks must be an object map' });
    return;
  }
  for (const field of HOOK_FIELDS) {
    if (!(field in value)) continue;
    const command = value[field];
    if (!Array.isArray(command)) {
      validateCommandConfig(command, `hooks.${field}`, `hooks.${field}`, errors);
      continue;
    }
    if (command.length === 0) {
      errors.push({ path: `hooks.${field}`, message: `hooks.${field} must not be empty` });
      continue;
    }
    command.forEach((entry, index) => {
      validateCommandConfig(entry, `hooks.${field}[${index}]`, `hooks.${field}[${index}]`, errors);
    });
  }
}

function validateReasoningEffort(value: unknown, path: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value)) {
    errors.push({
      path,
      message: 'reasoning_effort must be a non-empty string',
    });
  }
}

/**
 * Validate a raw pipeline config.
 * Checks structure, required fields, prompt/command exclusivity,
 * depends_on reference integrity, and circular dependencies.
 *
 * Plugin type checks: when `knownTypes` is provided, task/track references to
 * trigger/completion/middleware types that are neither built-in nor in the
 * supplied set produce a soft warning (severity: 'warning')  - these don't
 * block save/run but light up the Task panel so users discover the broken
 * reference in the editor instead of at run time. Omit `knownTypes` to skip
 * plugin checks entirely (offline/pre-load validation).
 */
export function validateRaw(
  config: RawPipelineConfig,
  knownTypes?: KnownPluginTypes,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const knownTriggers = knownTypes
    ? new Set<string>([...BUILTIN_TRIGGER_TYPES, ...(knownTypes.triggers ?? [])])
    : null;
  const knownDrivers = knownTypes
    ? new Set<string>([...BUILTIN_DRIVER_TYPES, ...(knownTypes.drivers ?? [])])
    : null;
  const knownCompletions = knownTypes
    ? new Set<string>([...BUILTIN_COMPLETION_TYPES, ...(knownTypes.completions ?? [])])
    : null;
  const knownMiddlewares = knownTypes
    ? new Set<string>([...BUILTIN_MIDDLEWARE_TYPES, ...(knownTypes.middlewares ?? [])])
    : null;

  //  Top level
  if (!isNonEmptyString(config.name)) {
    errors.push({ path: 'name', message: 'Pipeline name is required' });
  }
  if (config.mode && !VALID_PIPELINE_MODES.has(config.mode)) {
    errors.push({
      path: 'mode',
      message: `Invalid mode "${config.mode}". Expected "trusted" or "safe".`,
    });
  }
  validateReasoningEffort(config.reasoning_effort, 'reasoning_effort', errors);
  if (config.timeout !== undefined) {
    const validation = validateDuration(config.timeout);
    if (!validation.ok) {
      errors.push({
        path: 'timeout',
        message: durationErrorMessage(config.timeout, validation),
      });
    }
  }
  if (config.max_concurrency !== undefined) {
    if (!Number.isInteger(config.max_concurrency) || config.max_concurrency < 1) {
      errors.push({
        path: 'max_concurrency',
        message: 'max_concurrency must be a positive integer',
      });
    }
  }
  validateStringList(config.plugins, 'plugins', 'plugins', errors);
  validateHooks(config.hooks, errors);
  if (knownDrivers && config.driver && !knownDrivers.has(config.driver)) {
    errors.push({
      path: 'driver',
      message: `Unknown driver type "${config.driver}"`,
      severity: 'warning',
    });
  }
  validatePermissions(config.permissions, 'permissions', errors);

  if (!Array.isArray(config.tracks)) {
    errors.push({ path: 'tracks', message: 'pipeline.tracks must be an array' });
    return errors;
  }
  if (config.tracks.length === 0) {
    errors.push({ path: 'tracks', message: 'At least one track is required' });
    return errors; // No point going further without tracks
  }

  //  Build qualified ID sets for cross-reference checks
  // Qualified ID format: "trackId.taskId" (mirrors the engine's convention).
  // Shared with dag.ts so "ambiguous" / "not found" stay consistent  - refs
  // that buildDag later throws on will be reported here as errors first.
  const index = buildTaskIndex(config);
  // Full qid ->{track, task} index used by port-inference validation
  // to walk a Prompt task's neighbors without re-scanning the tracks.
  const qidIndex = buildQidIndex(config);

  //  Per-track validation
  const seenTrackIds = new Set<string>();
  for (let ti = 0; ti < config.tracks.length; ti++) {
    const maybeTrack = config.tracks[ti] as unknown;
    const trackPath = `tracks[${ti}]`;
    if (!maybeTrack || typeof maybeTrack !== 'object' || Array.isArray(maybeTrack)) {
      errors.push({ path: trackPath, message: `Track ${ti} must be an object` });
      continue;
    }
    const track = maybeTrack as RawTrackConfig;

    if (!isNonEmptyString(track.id)) {
      errors.push({ path: `${trackPath}.id`, message: 'Track id is required' });
    } else if (!isValidId(track.id)) {
      errors.push({
        path: `${trackPath}.id`,
        message: `Track id "${track.id}" is invalid. ${INVALID_TASK_ID_REASON}`,
      });
    } else if (seenTrackIds.has(track.id)) {
      errors.push({ path: `${trackPath}.id`, message: `Duplicate track id "${track.id}"` });
    } else {
      seenTrackIds.add(track.id);
    }
    if (!isNonEmptyString(track.name)) {
      errors.push({ path: `${trackPath}.name`, message: 'Track name is required' });
    }
    if (track.on_failure && !VALID_ON_FAILURE.has(track.on_failure)) {
      errors.push({
        path: `${trackPath}.on_failure`,
        message: `Invalid on_failure value "${track.on_failure}". Expected "skip_downstream", "stop_all", or "ignore".`,
      });
    }
    validateReasoningEffort(track.reasoning_effort, `${trackPath}.reasoning_effort`, errors);
    if (knownDrivers && track.driver && !knownDrivers.has(track.driver)) {
      errors.push({
        path: `${trackPath}.driver`,
        message: `Unknown driver type "${track.driver}"`,
        severity: 'warning',
      });
    }
    validatePermissions(track.permissions, `${trackPath}.permissions`, errors);

    // Track-level middlewares can reference a plugin that was uninstalled
    // after the YAML was written  - surface a warning so the user notices
    // before hitting Run.
    const trackMiddlewareTypes = validateMiddlewareList(
      track.middlewares,
      `${trackPath}.middlewares`,
      errors,
    );
    if (knownMiddlewares) {
      for (const { index: mi, type } of trackMiddlewareTypes) {
        if (!knownMiddlewares.has(type)) {
          errors.push({
            path: `${trackPath}.middlewares[${mi}].type`,
            message: `Middleware type "${type}" is not registered. Install the plugin (e.g. @tagma/middleware-${type}) or remove the reference  - the pipeline will fail at run time.`,
            severity: 'warning',
          });
        }
      }
    }
    if (knownTypes?.schemas?.middlewares && Array.isArray(track.middlewares)) {
      const mwSchemas = knownTypes.schemas.middlewares;
      for (const { index: mi, type } of trackMiddlewareTypes) {
        pushSchemaErrors(
          mwSchemas[type],
          track.middlewares[mi],
          `${trackPath}.middlewares[${mi}]`,
          errors,
        );
      }
    }

    if (!Array.isArray(track.tasks)) {
      errors.push({
        path: `${trackPath}.tasks`,
        message: `Track "${track.id || ti}": tasks must be an array`,
      });
      continue;
    }
    if (track.tasks.length === 0) {
      errors.push({
        path: `${trackPath}.tasks`,
        message: `Track "${track.id || ti}": must have at least one task`,
      });
      continue;
    }

    //  Per-task validation
    const seenTaskIds = new Set<string>();
    for (let ki = 0; ki < track.tasks.length; ki++) {
      const taskPath = `${trackPath}.tasks[${ki}]`;
      const maybeTask = track.tasks[ki] as unknown;
      if (!isRecord(maybeTask)) {
        errors.push({ path: taskPath, message: `Task ${ki} must be an object` });
        continue;
      }
      const task = maybeTask as unknown as RawTaskConfig;

      if (!isNonEmptyString(task.id)) {
        errors.push({ path: `${taskPath}.id`, message: 'Task id is required' });
        continue; // Can't check further without an id
      }

      if (!isValidId(task.id)) {
        errors.push({
          path: `${taskPath}.id`,
          message: `Task id "${task.id}" is invalid. ${INVALID_TASK_ID_REASON}`,
        });
      }
      if ('ports' in (maybeTask as Record<string, unknown>)) {
        errors.push({
          path: `${taskPath}.ports`,
          message: `Task "${task.id}": ports is not supported; use inputs/outputs`,
        });
      }
      if (seenTaskIds.has(task.id)) {
        errors.push({
          path: taskPath,
          message: `Duplicate task id "${task.id}" in track "${track.id}"`,
        });
      }
      seenTaskIds.add(task.id);

      const hasPromptKey = typeof task.prompt === 'string';
      const hasCommandField = isCommandTaskConfig(task);
      const hasCommandKey = commandConfigKind(task.command) !== null;
      const promptEmpty = hasPromptKey && task.prompt!.trim().length === 0;

      if (hasPromptKey && hasCommandKey) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": cannot have both "prompt" and "command"`,
        });
      } else if (!hasPromptKey && !hasCommandField) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": must have "prompt" or "command"`,
        });
      } else if (hasCommandField && !hasCommandKey) {
        validateCommandConfig(
          task.command,
          `${taskPath}.command`,
          `Task "${task.id}" command`,
          errors,
        );
      } else if (promptEmpty) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": prompt content cannot be empty`,
        });
      } else if (isCommandTaskConfig(task)) {
        validateCommandConfig(
          task.command,
          `${taskPath}.command`,
          `Task "${task.id}" command`,
          errors,
        );
      }

      //  Field-level validations
      if (task.timeout !== undefined) {
        const validation = validateDuration(task.timeout);
        if (!validation.ok) {
          errors.push({
            path: `${taskPath}.timeout`,
            message: durationErrorMessage(task.timeout, validation),
          });
        }
      }
      validateReasoningEffort(task.reasoning_effort, `${taskPath}.reasoning_effort`, errors);
      if (knownDrivers && task.driver && !knownDrivers.has(task.driver)) {
        errors.push({
          path: `${taskPath}.driver`,
          message: `Unknown driver type "${task.driver}"`,
          severity: 'warning',
        });
      }
      validatePermissions(task.permissions, `${taskPath}.permissions`, errors);

      //  Plugin type warnings (trigger / completion / middlewares)
      // Only fire when the host supplied a `knownTypes` snapshot, so offline
      // validation stays quiet. The messages deliberately name the npm
      // scope so users can copy-paste the install command.
      const triggerType = validatePluginRef(task.trigger, `${taskPath}.trigger`, 'trigger', errors);
      const completionType = validatePluginRef(
        task.completion,
        `${taskPath}.completion`,
        'completion',
        errors,
      );
      const taskMiddlewareTypes = validateMiddlewareList(
        task.middlewares,
        `${taskPath}.middlewares`,
        errors,
      );

      if (knownTriggers && triggerType !== null && !knownTriggers.has(triggerType)) {
        errors.push({
          path: `${taskPath}.trigger.type`,
          message: `Trigger type "${triggerType}" is not registered. Install the plugin (e.g. @tagma/trigger-${triggerType}) or the task will fail at run time.`,
          severity: 'warning',
        });
      }
      if (knownCompletions && completionType !== null && !knownCompletions.has(completionType)) {
        errors.push({
          path: `${taskPath}.completion.type`,
          message: `Completion type "${completionType}" is not registered. Install the plugin (e.g. @tagma/completion-${completionType}) or the task will fail at run time.`,
          severity: 'warning',
        });
      }
      if (knownMiddlewares) {
        for (const { index: mi, type } of taskMiddlewareTypes) {
          if (!knownMiddlewares.has(type)) {
            errors.push({
              path: `${taskPath}.middlewares[${mi}].type`,
              message: `Middleware type "${type}" is not registered. Install the plugin (e.g. @tagma/middleware-${type}) or remove the reference  - the pipeline will fail at run time.`,
              severity: 'warning',
            });
          }
        }
      }

      // Schema-based per-field validation. Mirrors what core preflight runs
      // at engine startup (validatePluginConfig) so the editor surfaces a
      // bad `timeout: "garbage"` or wrong-typed field at edit time instead
      // of waiting for run time. No-op when the host doesn't supply
      // schemas, or for plugin types whose schema entry is missing.
      if (triggerType !== null && knownTypes?.schemas?.triggers) {
        pushSchemaErrors(
          knownTypes.schemas.triggers[triggerType],
          task.trigger,
          `${taskPath}.trigger`,
          errors,
        );
      }
      if (completionType !== null && knownTypes?.schemas?.completions) {
        pushSchemaErrors(
          knownTypes.schemas.completions[completionType],
          task.completion,
          `${taskPath}.completion`,
          errors,
        );
      }
      if (knownTypes?.schemas?.middlewares && Array.isArray(task.middlewares)) {
        const mwSchemas = knownTypes.schemas.middlewares;
        for (const { index: mi, type } of taskMiddlewareTypes) {
          pushSchemaErrors(
            mwSchemas[type],
            task.middlewares[mi],
            `${taskPath}.middlewares[${mi}]`,
            errors,
          );
        }
      }

      //  Port declaration checks
      const deps = validateStringList(
        task.depends_on,
        `${taskPath}.depends_on`,
        'task.depends_on',
        errors,
      );

      if (task.continue_from !== undefined && !isNonEmptyString(task.continue_from)) {
        errors.push({
          path: `${taskPath}.continue_from`,
          message: 'task.continue_from must be a non-empty string',
        });
      }

      validateTaskPorts(task, track.id, taskPath, qidIndex, index, errors);

      //  depends_on reference checks
      if (deps.length > 0) {
        for (const dep of deps) {
          const resolved = resolveTaskRef(dep, track.id, index);
          if (resolved.kind === 'not_found') {
            errors.push({
              path: `${taskPath}.depends_on`,
              message: `Task "${task.id}": depends_on "${dep}"  - no such task found`,
            });
          } else if (resolved.kind === 'ambiguous') {
            errors.push({
              path: `${taskPath}.depends_on`,
              message: `Task "${task.id}": depends_on "${dep}" is ambiguous  - multiple tracks have a task with this id. Use the fully-qualified form "trackId.${dep}".`,
            });
          }
        }
      }

      //  continue_from reference check
      if (isNonEmptyString(task.continue_from)) {
        const resolved = resolveTaskRef(task.continue_from, track.id, index);
        if (resolved.kind === 'not_found') {
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}"  - no such task found`,
          });
        } else if (resolved.kind === 'ambiguous') {
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}" is ambiguous  - multiple tracks have a task with this id. Use the fully-qualified form "trackId.${task.continue_from}".`,
          });
        } else if (
          deps.length === 0 ||
          !deps.some((dep: string) => {
            const depResolved = resolveTaskRef(dep, track.id, index);
            return depResolved.kind === 'resolved' && depResolved.qid === resolved.qid;
          })
        ) {
          // H8: demote to a warning. dag.ts/buildDag inserts continue_from
          // as an implicit dependency at runtime, so the pipeline runs fine
          // without the explicit listing. Treat as a style hint rather than
          // blocking save / run, otherwise we frighten users with a red
          // "Configuration error" for code that would have run successfully.
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}" should also be listed in depends_on for clarity (the runtime will add it implicitly).`,
            severity: 'warning',
          });
        }
      }
    }
  }

  //  Cycle detection
  errors.push(...detectCycles(config, index));

  return errors;
}

function validatePermissions(value: unknown, basePath: string, errors: ValidationError[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: basePath,
      message: 'permissions must be an object with read/write/execute booleans',
    });
    return;
  }
  const p = value as Record<string, unknown>;
  for (const field of PERMISSION_FIELDS) {
    const path = `${basePath}.${field}`;
    if (!(field in p)) {
      errors.push({ path, message: `permissions.${field} is required` });
      continue;
    }
    if (typeof p[field] !== 'boolean') {
      errors.push({ path, message: `permissions.${field} must be a boolean` });
    }
  }
}

const VALID_PORT_TYPES: ReadonlySet<PortType> = new Set([
  'string',
  'number',
  'boolean',
  'enum',
  'json',
]);

// Identifier pattern for port names. Deliberately narrower than task IDs  -
// port names appear in `{{inputs.<name>}}` templates where hyphens would
// be parsed as subtraction, so we also forbid them here to keep the
// template grammar unambiguous.
const PORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Two distinct field-name contracts live in this module. They look similar
// but cover different surfaces, so they intentionally do not share a single
// list:
//
//  - INPUT_TASK_STREAM_FIELDS: trailing field names allowed when an `inputs`
//    binding's `from:` references an upstream task's stream (e.g.
//    `up.stdout`, `track.up.exitCode`). Used by `bindingSourceTaskRef` to
//    peel the field off when computing the upstream task ref. Includes
//    `exitCode` because a downstream task can read the upstream's exit code.
//
//  - OUTPUT_BINDING_SOURCES: full set of legal `from:` values when a task
//    publishes its OWN outputs (no task ref, just the local task's stream).
//    Used to validate `task.outputs.<name>.from` shape. Does NOT include
//    `exitCode` - a task's exitCode is implicit on success (always 0 on
//    the success path through the engine), so publishing it as an output
//    binding is degenerate.
const INPUT_TASK_STREAM_FIELDS: readonly string[] = [
  'stdout',
  'stderr',
  'normalizedOutput',
  'exitCode',
];
const OUTPUT_BINDING_SOURCES: readonly string[] = ['stdout', 'stderr', 'normalizedOutput'];
const OUTPUT_BINDING_JSON_RE = /^json\.[A-Za-z_][A-Za-z0-9_]*$/;

function validateBindingMap(
  value: unknown,
  basePath: string,
  kind: 'inputs' | 'outputs',
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: basePath, message: `task.${kind} must be an object map` });
    return;
  }

  const map = value as Record<string, unknown>;
  for (const [name, rawBinding] of Object.entries(map)) {
    const path = `${basePath}.${name}`;
    if (!PORT_NAME_RE.test(name)) {
      errors.push({
        path,
        message: `binding name "${name}" is invalid. Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
      });
    }
    if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
      errors.push({ path, message: `task.${kind}.${name} must be an object` });
      continue;
    }
    const binding = rawBinding as Record<string, unknown>;
    if ('from' in binding && typeof binding.from !== 'string') {
      errors.push({ path: `${path}.from`, message: `task.${kind}.${name}.from must be a string` });
    }
    if (kind === 'inputs' && 'required' in binding && typeof binding.required !== 'boolean') {
      errors.push({
        path: `${path}.required`,
        message: `task.inputs.${name}.required must be a boolean`,
      });
    }
    if (
      'type' in binding &&
      binding.type !== undefined &&
      !VALID_PORT_TYPES.has(binding.type as PortType)
    ) {
      errors.push({
        path: `${path}.type`,
        message: `task.${kind}.${name}.type must be one of ${[...VALID_PORT_TYPES].join(', ')}`,
      });
    }
    if (binding.type === 'enum') {
      if (!Array.isArray(binding.enum) || binding.enum.length === 0) {
        errors.push({
          path: `${path}.enum`,
          message: `task.${kind}.${name}.enum must be a non-empty string array when type is enum`,
        });
      } else if (!binding.enum.every((v: unknown) => typeof v === 'string')) {
        errors.push({
          path: `${path}.enum`,
          message: `task.${kind}.${name}.enum values must all be strings`,
        });
      }
    }
    if (kind === 'outputs' && typeof binding.from === 'string') {
      const source = binding.from;
      const ok =
        OUTPUT_BINDING_SOURCES.includes(source) || OUTPUT_BINDING_JSON_RE.test(source);
      if (!ok) {
        errors.push({
          path: `${path}.from`,
          message: `task.outputs.${name}.from must be ${OUTPUT_BINDING_SOURCES.join(', ')}, or json.<key>`,
        });
      }
    }
  }
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

function validateInputBindingSources(
  task: RawTaskConfig,
  trackId: string,
  taskPath: string,
  index: TaskIndex,
  errors: ValidationError[],
): void {
  if (!task.inputs || typeof task.inputs !== 'object' || Array.isArray(task.inputs)) return;
  for (const [name, rawBinding] of Object.entries(task.inputs)) {
    if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) continue;
    const source = (rawBinding as Record<string, unknown>).from;
    if (typeof source !== 'string') continue;
    const upstreamRef = bindingSourceTaskRef(source);
    if (!upstreamRef) continue;
    const sourceResolution = resolveTaskRef(upstreamRef, trackId, index);

    // Surface "no such task" / "ambiguous" before the direct-dep check.
    // Falling through to the not-a-direct-dep branch with an unresolved
    // ref produces a misleading "references task <literal-string> which
    // is not a direct dependency" message — the underlying problem is
    // that the ref does not resolve at all.
    if (sourceResolution.kind === 'not_found') {
      errors.push({
        path: `${taskPath}.inputs.${name}.from`,
        message: `Task "${task.id}": input binding "${name}" from "${source}"  - no such task "${upstreamRef}"`,
      });
      continue;
    }
    if (sourceResolution.kind === 'ambiguous') {
      errors.push({
        path: `${taskPath}.inputs.${name}.from`,
        message: `Task "${task.id}": input binding "${name}" from "${source}" is ambiguous  - multiple tracks have a task with id "${upstreamRef}". Use the fully-qualified form "trackId.${upstreamRef}".`,
      });
      continue;
    }

    const upstreamId = sourceResolution.qid;
    const deps = dependencyRefs(task);
    const isDirectDep = deps.some((dep) => {
      const resolved = resolveTaskRef(dep, trackId, index);
      return resolved.kind === 'resolved' && resolved.qid === upstreamId;
    });
    if (!isDirectDep) {
      errors.push({
        path: `${taskPath}.inputs.${name}.from`,
        message: `Task "${task.id}": input binding "${name}" from "${source}" references task "${upstreamId}" which is not a direct dependency (must be listed in depends_on)`,
      });
    }
  }
}

function bindingSourceTaskRef(source: string): string | null {
  if (source.startsWith('outputs.')) return null;
  const outputMarker = '.outputs.';
  const outputIdx = source.lastIndexOf(outputMarker);
  if (outputIdx > 0) return source.slice(0, outputIdx);
  for (const field of INPUT_TASK_STREAM_FIELDS) {
    const suffix = `.${field}`;
    if (source.endsWith(suffix) && source.length > suffix.length) {
      return source.slice(0, -suffix.length);
    }
  }
  const dot = source.lastIndexOf('.');
  if (dot > 0) return source.slice(0, dot);
  return null;
}

function validateTaskPorts(
  task: RawTaskConfig,
  trackId: string,
  taskPath: string,
  qidIndex: Map<string, QidEntry>,
  index: TaskIndex,
  errors: ValidationError[],
): void {
  const isPromptTask = isPromptTaskConfig(task);

  validateBindingMap(task.inputs, `${taskPath}.inputs`, 'inputs', errors);
  validateBindingMap(task.outputs, `${taskPath}.outputs`, 'outputs', errors);
  validateInputBindingSources(task, trackId, taskPath, index, errors);

  // Collect placeholder references
  // `{{inputs.X}}` is valid in both prompt and command text. The set of
  // names a task may legally reference differs by task kind:
  //   - Command Task: its own declared `inputs`
  //   - Prompt Task:  the union of direct-upstream Command outputs
  const referenced = new Set<string>();
  if (typeof task.prompt === 'string') {
    for (const n of extractInputReferences(task.prompt)) referenced.add(n);
  }
  if (commandConfigKind(task.command) !== null) {
    for (const n of commandInputReferences(task.command as CommandConfig)) referenced.add(n);
  }

  let availableInputs: Set<string>;
  if (isPromptTask) {
    availableInputs = collectUpstreamCommandOutputNames(task, trackId, qidIndex, index);
    for (const name of objectKeys(task.inputs)) availableInputs.add(name);
  } else {
    // Command Task (or the pathological both-keys case, which is caught
    // earlier as a separate error  - tolerate it here).
    availableInputs = new Set<string>();
    for (const name of objectKeys(task.inputs)) availableInputs.add(name);
  }

  for (const name of referenced) {
    if (!availableInputs.has(name)) {
      const hint = isPromptTask
        ? `no upstream Command task exports an output named "${name}"`
        : `no such input is declared`;
      errors.push({
        path: taskPath,
        message: `Task "${task.id}": references "{{inputs.${name}}}" but ${hint}`,
      });
    }
  }

  // Prompt-task inferred-port conflict checks
  //
  // Static counterparts to the runtime checks `inferPromptPorts` runs.
  // These surface problems at author-time in the editor so the user
  // fixes them before a run, rather than hitting a "blocked" task.
  if (isPromptTask) {
    validateInferredPromptPortConflicts(task, trackId, taskPath, qidIndex, index, errors);
  }
}

/**
 * Walk the direct-upstream Commands of a Prompt Task and collect every
 * output port name they export. Prompt upstreams contribute nothing  -
 * they pass free text via continue_from, not structured ports  - so we
 * skip them. This mirrors exactly what the engine does at runtime in
 * `inferPromptPorts`, keeping the editor and runtime views aligned.
 */
function collectUpstreamCommandOutputNames(
  task: RawTaskConfig,
  trackId: string,
  qidIndex: Map<string, QidEntry>,
  index: TaskIndex,
): Set<string> {
  const names = new Set<string>();
  for (const dep of dependencyRefs(task)) {
    const r = resolveTaskRef(dep, trackId, index);
    if (r.kind !== 'resolved') continue;
    const entry = qidIndex.get(r.qid);
    if (!entry) continue;
    // Only Command tasks contribute  - Prompt upstreams pass free text.
    if (!isCommandTaskConfig(entry.task)) continue;
    const outputs = entry.task.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) continue;
    for (const name of Object.keys(outputs)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Detect the two kinds of collision that would block a Prompt Task at
 * runtime  - report them at validate-time so the editor lights them up
 * before a run is attempted.
 *
 * 1. Input collision: two direct-upstream Commands both export an
 *    output with the same name. Prompt tasks can resolve this by declaring
 *    explicit `inputs` aliases with `from:` for every producer; otherwise
 *    validation reports the unresolved ambiguity.
 * 2. Output collision: two direct-downstream Commands declare inputs
 *    with the same name but incompatible shapes (different type, or
 *    different enum sets). A single LLM emission cannot satisfy both.
 */
function validateInferredPromptPortConflicts(
  task: RawTaskConfig,
  trackId: string,
  taskPath: string,
  qidIndex: Map<string, QidEntry>,
  index: TaskIndex,
  errors: ValidationError[],
): void {
  //  Input collision
  const producersByName = new Map<string, string[]>();
  for (const dep of dependencyRefs(task)) {
    const r = resolveTaskRef(dep, trackId, index);
    if (r.kind !== 'resolved') continue;
    const entry = qidIndex.get(r.qid);
    if (!entry || !isCommandTaskConfig(entry.task)) continue;
    const outputs = entry.task.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) continue;
    for (const name of Object.keys(outputs)) {
      const list = producersByName.get(name) ?? [];
      list.push(r.qid);
      producersByName.set(name, list);
    }
  }
  for (const [name, producers] of producersByName) {
    if (producers.length > 1) {
      if (explicitInputsDisambiguateConflict(task, name, producers)) continue;
      errors.push({
        path: taskPath,
        message:
          `Task "${task.id}": upstream Commands ${producers.join(', ')} all export ` +
          `"${name}" - declare explicit input aliases with "from" bindings ` +
          `on the Prompt task, or rename one of the upstream outputs.`,
      });
    }
  }

  //  Output collision
  //
  // Walk every task in the pipeline once and check whether it depends on
  // us. We reuse the shared qidIndex + TaskIndex for the lookup; small
  // pipelines stay O(tasks), which is fine for validate-raw (it already
  // O(tasks) elsewhere).
  const taskQid = qualifyTaskId(trackId, task.id);
  const consumerShapeByName = new Map<
    string,
    { readonly shape: string; readonly firstConsumer: string }
  >();
  const reported = new Set<string>();
  for (const [downstreamQid, entry] of qidIndex) {
    if (downstreamQid === taskQid) continue;
    if (!isCommandTaskConfig(entry.task)) continue; // only downstream Commands contribute
    const deps = dependencyRefs(entry.task);
    let dependsOnUs = false;
    for (const d of deps) {
      const r = resolveTaskRef(d, entry.track.id, index);
      if (r.kind === 'resolved' && r.qid === taskQid) {
        dependsOnUs = true;
        break;
      }
    }
    if (!dependsOnUs) continue;
    const inputs = entry.task.inputs;
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) continue;
    for (const [inputName, binding] of Object.entries(inputs)) {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
      const outputName = inferredPromptOutputName(
        inputName,
        binding as { readonly from?: unknown },
        taskQid,
      );
      if (outputName === null) continue;
      const shape = bindingShapeKey(binding as { type?: PortType; enum?: readonly string[] });
      const prior = consumerShapeByName.get(outputName);
      if (!prior) {
        consumerShapeByName.set(outputName, { shape, firstConsumer: downstreamQid });
        continue;
      }
      if (prior.shape !== shape && !reported.has(outputName)) {
        reported.add(outputName);
        errors.push({
          path: taskPath,
          message:
            `Task "${task.id}": downstream Commands ${prior.firstConsumer} and ` +
            `${downstreamQid} disagree on the shape of inferred output "${outputName}"  - ` +
            `a single LLM emission cannot satisfy both. Rename on one side.`,
        });
      }
    }
  }
}

function explicitInputsDisambiguateConflict(
  task: RawTaskConfig,
  outputName: string,
  producers: readonly string[],
): boolean {
  if (!task.inputs || typeof task.inputs !== 'object' || Array.isArray(task.inputs)) return false;
  const bindings = Object.values(task.inputs);
  return producers.every((producer) =>
    bindings.some((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
      const source = (binding as { readonly from?: unknown }).from;
      return typeof source === 'string' && sourceReferencesOutput(source, producer, outputName);
    }),
  );
}

function sourceReferencesOutput(source: string, upstreamId: string, outputName: string): boolean {
  if (source === `${upstreamId}.outputs.${outputName}`) return true;
  const upstreamTaskId = bareTaskId(upstreamId);
  return (
    source === `${upstreamTaskId}.outputs.${outputName}` ||
    source === `${upstreamId}.${outputName}` ||
    source === `${upstreamTaskId}.${outputName}`
  );
}

function inferredPromptOutputName(
  inputName: string,
  binding: { readonly from?: unknown },
  promptTaskId: string,
): string | null {
  if (typeof binding.from !== 'string' || binding.from.length === 0) return inputName;
  const source = binding.from;
  if (source.startsWith('outputs.')) return source.slice('outputs.'.length);

  const outputMarker = '.outputs.';
  const outputIdx = source.lastIndexOf(outputMarker);
  if (outputIdx > 0) {
    const sourceTaskId = source.slice(0, outputIdx);
    if (!sourceRefMatchesTaskId(sourceTaskId, promptTaskId)) return null;
    return source.slice(outputIdx + outputMarker.length);
  }

  const dot = source.lastIndexOf('.');
  if (dot > 0) {
    const sourceTaskId = source.slice(0, dot);
    if (!sourceRefMatchesTaskId(sourceTaskId, promptTaskId)) return null;
    return source.slice(dot + 1);
  }

  return source;
}

function sourceRefMatchesTaskId(sourceTaskId: string, taskId: string): boolean {
  if (sourceTaskId === taskId) return true;
  return !sourceTaskId.includes('.') && bareTaskId(taskId) === sourceTaskId;
}

function bareTaskId(qid: string): string {
  const dot = qid.lastIndexOf('.');
  return dot >= 0 ? qid.slice(dot + 1) : qid;
}

function bindingShapeKey(port: { type?: PortType; enum?: readonly string[] }): string {
  if ((port.type ?? 'json') !== 'enum') return String(port.type ?? 'json');
  const enums = Array.isArray(port.enum) ? [...port.enum].sort().join('|') : '';
  return `enum:${enums}`;
}

function detectCycles(config: RawPipelineConfig, index: TaskIndex): ValidationError[] {
  // Build adjacency: qualifiedId ->[resolved dep qualifiedIds]
  const adj = new Map<string, string[]>();

  for (const track of config.tracks) {
    if (!track || typeof track !== 'object' || !isValidTaskId(track.id)) continue;
    if (!Array.isArray(track.tasks)) continue;
    for (const task of track.tasks ?? []) {
      if (!task || typeof task !== 'object' || !isValidTaskId(task.id)) continue;
      const qid = qualifyTaskId(track.id, task.id);
      const deps: string[] = [];
      for (const dep of dependencyRefs(task)) {
        const resolved = resolveTaskRef(dep, track.id, index);
        if (resolved.kind === 'resolved') deps.push(resolved.qid);
      }
      if (isNonEmptyString(task.continue_from)) {
        const resolved = resolveTaskRef(task.continue_from, track.id, index);
        if (resolved.kind === 'resolved' && !deps.includes(resolved.qid)) deps.push(resolved.qid);
      }
      adj.set(qid, deps);
    }
  }

  const errors: ValidationError[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  // Deduplicate cycles: the same cycle can be discovered from multiple entry points.
  // Canonical key = sorted node list joined  - order-independent fingerprint.
  const seenCycles = new Set<string>();

  // Use a mutable path array instead of copying at each level (O(n) vs O(n^2)).
  const pathStack: string[] = [];

  function dfs(id: string): void {
    if (inStack.has(id)) {
      const cycleStart = pathStack.indexOf(id);
      // Unique nodes in the cycle (without repeating the start node) for dedup.
      // Previously the duplicate start node caused different sorted keys when
      // the same cycle was discovered from different entry points.
      const uniqueNodes = pathStack.slice(cycleStart);
      const key = [...uniqueNodes].sort().join(',');
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        const display = [...uniqueNodes, id]; // include start for readable display
        errors.push({
          path: 'tracks',
          message: `Circular dependency detected: ${display.join(' ->')}`,
        });
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    pathStack.push(id);
    for (const dep of adj.get(id) ?? []) {
      dfs(dep);
    }
    pathStack.pop();
    inStack.delete(id);
  }

  for (const id of adj.keys()) {
    if (!visited.has(id)) dfs(id);
  }

  return errors;
}
