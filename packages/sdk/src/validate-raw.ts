// ═══ Raw Pipeline Config Validation ═══
//
// Validates a RawPipelineConfig without resolving inheritance or executing
// anything — intended for real-time feedback in a visual editor (e.g. drag
// to add a task, live error highlighting).
//
// Returns a flat list of ValidationError objects. An empty array means valid.

import type {
  PortDef,
  PortType,
  RawPipelineConfig,
  RawTaskConfig,
  RawTrackConfig,
} from './types';
import {
  isValidTaskId,
  qualifyTaskId,
  buildTaskIndex,
  resolveTaskRef,
  type TaskIndex,
} from './task-ref';
import { extractInputReferences } from './ports';

interface QidEntry {
  readonly track: RawTrackConfig;
  readonly task: RawTaskConfig;
}

/** qid → {track, task} lookup built once per validation pass. */
function buildQidIndex(config: RawPipelineConfig): Map<string, QidEntry> {
  const idx = new Map<string, QidEntry>();
  for (const track of config.tracks ?? []) {
    if (!track.id) continue;
    if (!Array.isArray(track.tasks)) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      idx.set(qualifyTaskId(track.id, task.id), { track, task });
    }
  }
  return idx;
}

const DURATION_RE = /^(\d*\.?\d+)\s*(s|m|h|d)$/;
function isValidDuration(input: string): boolean {
  return DURATION_RE.test(input.trim());
}

// D8: IDs may only contain letters, digits, underscores, and hyphens, and must
// start with a letter or underscore. Dots are explicitly forbidden because the
// engine uses "trackId.taskId" as the qualified separator — a dot in either
// part creates an ambiguous qualified ID and breaks resolveRef.
// Canonical regex and helper live in ./task-ref so every resolver (dag.ts,
// engine.ts, editor) stays in lockstep with what we accept here.
const isValidId = isValidTaskId;

const VALID_ON_FAILURE = new Set(['skip_downstream', 'stop_all', 'ignore']);
const VALID_REASONING_EFFORT = new Set(['low', 'medium', 'high']);
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

/**
 * Optional second argument to `validateRaw`: the set of plugin types currently
 * registered in the SDK runtime, keyed by category. Hosts (e.g. the editor
 * server) pass this so `validateRaw` can emit a soft warning when a task
 * references a type that isn't loaded — otherwise the Task panel would show
 * no hint and the pipeline would only blow up at run time. Callers that
 * legitimately validate a config offline (before plugins are loaded) can omit
 * this argument and no plugin warnings will be produced.
 */
export interface KnownPluginTypes {
  readonly drivers?: readonly string[];
  readonly triggers?: readonly string[];
  readonly completions?: readonly string[];
  readonly middlewares?: readonly string[];
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationError {
  /** JSONPath-style location, e.g. "tracks[0].tasks[1].prompt" */
  path: string;
  message: string;
  /**
   * H8: not all "errors" are equally fatal. The DAG runtime is happy to
   * insert implicit `continue_from → depends_on` ordering, so the matching
   * validate-raw check is a *style* nit, not a hard failure. Severity lets
   * the editor render it as a soft warning instead of blocking save / run.
   * Existing call sites that don't read this field still treat every entry
   * as fatal — defaulting `severity` to undefined preserves that behaviour.
   */
  severity?: ValidationSeverity;
}

/**
 * Validate a raw pipeline config.
 * Checks structure, required fields, prompt/command exclusivity,
 * depends_on reference integrity, and circular dependencies.
 *
 * Plugin type checks: when `knownTypes` is provided, task/track references to
 * trigger/completion/middleware types that are neither built-in nor in the
 * supplied set produce a soft warning (severity: 'warning') — these don't
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

  // ── Top level ──
  if (!config.name?.trim()) {
    errors.push({ path: 'name', message: 'Pipeline name is required' });
  }
  if (config.reasoning_effort && !VALID_REASONING_EFFORT.has(config.reasoning_effort)) {
    errors.push({
      path: 'reasoning_effort',
      message: `Invalid reasoning_effort "${config.reasoning_effort}". Expected "low", "medium", or "high".`,
    });
  }
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

  // ── Build qualified ID sets for cross-reference checks ──
  // Qualified ID format: "trackId.taskId" (mirrors the engine's convention).
  // Shared with dag.ts so "ambiguous" / "not found" stay consistent — refs
  // that buildDag later throws on will be reported here as errors first.
  const index = buildTaskIndex(config);
  // Full qid → {track, task} index used by port-inference validation
  // to walk a Prompt task's neighbors without re-scanning the tracks.
  const qidIndex = buildQidIndex(config);

  // ── Per-track validation ──
  const seenTrackIds = new Set<string>();
  for (let ti = 0; ti < config.tracks.length; ti++) {
    const maybeTrack = config.tracks[ti] as unknown;
    const trackPath = `tracks[${ti}]`;
    if (!maybeTrack || typeof maybeTrack !== 'object' || Array.isArray(maybeTrack)) {
      errors.push({ path: trackPath, message: `Track ${ti} must be an object` });
      continue;
    }
    const track = maybeTrack as RawTrackConfig;

    if (!track.id?.trim()) {
      errors.push({ path: `${trackPath}.id`, message: 'Track id is required' });
    } else if (!isValidId(track.id)) {
      errors.push({
        path: `${trackPath}.id`,
        message: `Track id "${track.id}" contains invalid characters. IDs must match /^[A-Za-z_][A-Za-z0-9_-]*$/ (no dots, spaces, or special chars).`,
      });
    } else if (seenTrackIds.has(track.id)) {
      errors.push({ path: `${trackPath}.id`, message: `Duplicate track id "${track.id}"` });
    } else {
      seenTrackIds.add(track.id);
    }
    if (!track.name?.trim()) {
      errors.push({ path: `${trackPath}.name`, message: 'Track name is required' });
    }
    if (track.on_failure && !VALID_ON_FAILURE.has(track.on_failure)) {
      errors.push({
        path: `${trackPath}.on_failure`,
        message: `Invalid on_failure value "${track.on_failure}". Expected "skip_downstream", "stop_all", or "ignore".`,
      });
    }
    if (track.reasoning_effort && !VALID_REASONING_EFFORT.has(track.reasoning_effort)) {
      errors.push({
        path: `${trackPath}.reasoning_effort`,
        message: `Invalid reasoning_effort "${track.reasoning_effort}". Expected "low", "medium", or "high".`,
      });
    }
    if (knownDrivers && track.driver && !knownDrivers.has(track.driver)) {
      errors.push({
        path: `${trackPath}.driver`,
        message: `Unknown driver type "${track.driver}"`,
        severity: 'warning',
      });
    }
    validatePermissions(track.permissions, `${trackPath}.permissions`, errors);

    // Track-level middlewares can reference a plugin that was uninstalled
    // after the YAML was written — surface a warning so the user notices
    // before hitting Run.
    if (knownMiddlewares && track.middlewares) {
      for (let mi = 0; mi < track.middlewares.length; mi++) {
        const mw = track.middlewares[mi];
        if (mw?.type && !knownMiddlewares.has(mw.type)) {
          errors.push({
            path: `${trackPath}.middlewares[${mi}].type`,
            message: `Middleware type "${mw.type}" is not registered. Install the plugin (e.g. @tagma/middleware-${mw.type}) or remove the reference — the pipeline will fail at run time.`,
            severity: 'warning',
          });
        }
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

    // ── Per-task validation ──
    const seenTaskIds = new Set<string>();
    for (let ki = 0; ki < track.tasks.length; ki++) {
      const task = track.tasks[ki];
      const taskPath = `${trackPath}.tasks[${ki}]`;

      if (!task.id?.trim()) {
        errors.push({ path: `${taskPath}.id`, message: 'Task id is required' });
        continue; // Can't check further without an id
      }

      if (!isValidId(task.id)) {
        errors.push({
          path: `${taskPath}.id`,
          message: `Task id "${task.id}" contains invalid characters. IDs must match /^[A-Za-z_][A-Za-z0-9_-]*$/ (no dots, spaces, or special chars).`,
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
      const hasCommandKey = typeof task.command === 'string';
      const promptEmpty = hasPromptKey && task.prompt!.trim().length === 0;
      const commandEmpty = hasCommandKey && task.command!.trim().length === 0;

      if (hasPromptKey && hasCommandKey) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": cannot have both "prompt" and "command"`,
        });
      } else if (!hasPromptKey && !hasCommandKey) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": must have "prompt" or "command"`,
        });
      } else if (promptEmpty) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": prompt content cannot be empty`,
        });
      } else if (commandEmpty) {
        errors.push({
          path: taskPath,
          message: `Task "${task.id}": command content cannot be empty`,
        });
      }

      // ── Field-level validations ──
      if (task.timeout && !isValidDuration(task.timeout)) {
        errors.push({
          path: `${taskPath}.timeout`,
          message: `Invalid duration format "${task.timeout}". Expected e.g. "30s", "5m", "1h".`,
        });
      }
      if (task.reasoning_effort && !VALID_REASONING_EFFORT.has(task.reasoning_effort)) {
        errors.push({
          path: `${taskPath}.reasoning_effort`,
          message: `Invalid reasoning_effort "${task.reasoning_effort}". Expected "low", "medium", or "high".`,
        });
      }
      if (knownDrivers && task.driver && !knownDrivers.has(task.driver)) {
        errors.push({
          path: `${taskPath}.driver`,
          message: `Unknown driver type "${task.driver}"`,
          severity: 'warning',
        });
      }
      validatePermissions(task.permissions, `${taskPath}.permissions`, errors);

      // ── Plugin type warnings (trigger / completion / middlewares) ──
      // Only fire when the host supplied a `knownTypes` snapshot, so offline
      // validation stays quiet. The messages deliberately name the npm
      // scope so users can copy-paste the install command.
      if (knownTriggers && task.trigger?.type && !knownTriggers.has(task.trigger.type)) {
        errors.push({
          path: `${taskPath}.trigger.type`,
          message: `Trigger type "${task.trigger.type}" is not registered. Install the plugin (e.g. @tagma/trigger-${task.trigger.type}) or the task will fail at run time.`,
          severity: 'warning',
        });
      }
      if (
        knownCompletions &&
        task.completion?.type &&
        !knownCompletions.has(task.completion.type)
      ) {
        errors.push({
          path: `${taskPath}.completion.type`,
          message: `Completion type "${task.completion.type}" is not registered. Install the plugin (e.g. @tagma/completion-${task.completion.type}) or the task will fail at run time.`,
          severity: 'warning',
        });
      }
      if (knownMiddlewares && task.middlewares) {
        for (let mi = 0; mi < task.middlewares.length; mi++) {
          const mw = task.middlewares[mi];
          if (mw?.type && !knownMiddlewares.has(mw.type)) {
            errors.push({
              path: `${taskPath}.middlewares[${mi}].type`,
              message: `Middleware type "${mw.type}" is not registered. Install the plugin (e.g. @tagma/middleware-${mw.type}) or remove the reference — the pipeline will fail at run time.`,
              severity: 'warning',
            });
          }
        }
      }

      // ── Port declaration checks ──
      validateTaskPorts(task, track.id, taskPath, qidIndex, index, errors);

      // ── depends_on reference checks ──
      if (task.depends_on && task.depends_on.length > 0) {
        for (const dep of task.depends_on) {
          const resolved = resolveTaskRef(dep, track.id, index);
          if (resolved.kind === 'not_found') {
            errors.push({
              path: `${taskPath}.depends_on`,
              message: `Task "${task.id}": depends_on "${dep}" — no such task found`,
            });
          } else if (resolved.kind === 'ambiguous') {
            errors.push({
              path: `${taskPath}.depends_on`,
              message: `Task "${task.id}": depends_on "${dep}" is ambiguous — multiple tracks have a task with this id. Use the fully-qualified form "trackId.${dep}".`,
            });
          }
        }
      }

      // ── continue_from reference check ──
      if (task.continue_from) {
        const resolved = resolveTaskRef(task.continue_from, track.id, index);
        if (resolved.kind === 'not_found') {
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}" — no such task found`,
          });
        } else if (resolved.kind === 'ambiguous') {
          errors.push({
            path: `${taskPath}.continue_from`,
            message: `Task "${task.id}": continue_from "${task.continue_from}" is ambiguous — multiple tracks have a task with this id. Use the fully-qualified form "trackId.${task.continue_from}".`,
          });
        } else if (
          !task.depends_on ||
          !task.depends_on.some((dep: string) => {
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

  // ── Cycle detection ──
  errors.push(...detectCycles(config, index));

  return errors;
}

function validatePermissions(
  value: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
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

// Identifier pattern for port names. Deliberately narrower than task IDs —
// port names appear in `{{inputs.<name>}}` templates where hyphens would
// be parsed as subtraction, so we also forbid them here to keep the
// template grammar unambiguous.
const PORT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validatePortList(
  list: readonly PortDef[] | undefined,
  basePath: string,
  kind: 'inputs' | 'outputs',
  errors: ValidationError[],
): void {
  if (!list) return;
  if (!Array.isArray(list)) {
    errors.push({
      path: basePath,
      message: `ports.${kind} must be an array`,
    });
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const port = list[i];
    const path = `${basePath}[${i}]`;
    if (!port || typeof port !== 'object') {
      errors.push({ path, message: `ports.${kind}[${i}] must be an object` });
      continue;
    }
    if (typeof port.name !== 'string' || !port.name.trim()) {
      errors.push({ path: `${path}.name`, message: 'port.name is required' });
      continue;
    }
    if (!PORT_NAME_RE.test(port.name)) {
      errors.push({
        path: `${path}.name`,
        message: `port name "${port.name}" is invalid. Must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscores; starts with letter/underscore).`,
      });
    }
    if (seen.has(port.name)) {
      errors.push({
        path,
        message: `Duplicate ports.${kind} name "${port.name}"`,
      });
    }
    seen.add(port.name);
    if (!VALID_PORT_TYPES.has(port.type)) {
      errors.push({
        path: `${path}.type`,
        message: `port "${port.name}": type must be one of ${[...VALID_PORT_TYPES].join(', ')} (got ${JSON.stringify(port.type)})`,
      });
    }
    if (port.type === 'enum') {
      if (!Array.isArray(port.enum) || port.enum.length === 0) {
        errors.push({
          path: `${path}.enum`,
          message: `port "${port.name}": enum type requires a non-empty "enum" array`,
        });
      } else if (port.enum.some((v: unknown) => typeof v !== 'string')) {
        errors.push({
          path: `${path}.enum`,
          message: `port "${port.name}": enum values must all be strings`,
        });
      }
    }
    if (kind === 'outputs' && (port.required === true || port.from !== undefined)) {
      // `required` / `from` are input-only concepts — outputs are
      // always "produced when the task succeeds". Warn softly so the
      // YAML doesn't silently accept meaningless fields.
      errors.push({
        path,
        severity: 'warning',
        message: `port "${port.name}": "required" and "from" are input-only; ignored on outputs`,
      });
    }
    if (port.from !== undefined && typeof port.from !== 'string') {
      errors.push({
        path: `${path}.from`,
        message: `port "${port.name}": "from" must be a string (got ${typeof port.from})`,
      });
    }
  }
}

function validateTaskPorts(
  task: RawTaskConfig,
  trackId: string,
  taskPath: string,
  qidIndex: Map<string, QidEntry>,
  index: TaskIndex,
  errors: ValidationError[],
): void {
  const ports = task.ports;
  const isPromptTask = typeof task.prompt === 'string' && typeof task.command !== 'string';
  const isCommandTask = typeof task.command === 'string' && typeof task.prompt !== 'string';

  // ─── Prompt tasks do not declare ports ──
  //
  // A Prompt Task's I/O contract is inferred from direct-neighbor
  // Command Tasks at runtime (see `inferPromptPorts` in ports.ts).
  // Declaring `ports` on a Prompt Task is always a configuration
  // mistake: the declared shape would be silently ignored in favour of
  // the inferred one, and the two drifting out of sync is the exact bug
  // the inference design eliminates.
  if (isPromptTask && ports !== undefined) {
    errors.push({
      path: `${taskPath}.ports`,
      message:
        `Task "${task.id}": prompt tasks do not declare ports — their I/O is ` +
        `inferred from direct-neighbor Command tasks. Remove the "ports" field ` +
        `and declare the corresponding inputs/outputs on the upstream/downstream ` +
        `Command tasks instead.`,
    });
  }

  // ─── Collect placeholder references ──
  // `{{inputs.X}}` is valid in both prompt and command text. The set of
  // names a task may legally reference differs by task kind:
  //   - Command Task: its own declared `ports.inputs`
  //   - Prompt Task:  the union of direct-upstream Command outputs
  const referenced = new Set<string>();
  if (typeof task.prompt === 'string') {
    for (const n of extractInputReferences(task.prompt)) referenced.add(n);
  }
  if (typeof task.command === 'string') {
    for (const n of extractInputReferences(task.command)) referenced.add(n);
  }

  let availableInputs: Set<string>;
  if (isPromptTask) {
    availableInputs = collectUpstreamCommandOutputNames(task, trackId, qidIndex, index);
  } else {
    // Command Task (or the pathological both-keys case, which is caught
    // earlier as a separate error — tolerate it here).
    availableInputs = new Set<string>(
      ports && Array.isArray(ports.inputs)
        ? ports.inputs.filter((p): p is PortDef => !!p && typeof p === 'object').map((p) => p.name)
        : [],
    );
  }

  for (const name of referenced) {
    if (!availableInputs.has(name)) {
      const hint = isPromptTask
        ? `no upstream Command task exports an output port named "${name}"`
        : `no such input port is declared`;
      errors.push({
        path: taskPath,
        message: `Task "${task.id}": references "{{inputs.${name}}}" but ${hint}`,
      });
    }
  }

  // ─── Structural port validation — Command Tasks only ──
  //
  // Prompt tasks already errored above if they tried to declare ports;
  // running the per-port structural validator on the ignored object
  // would just produce duplicate noise.
  if (isCommandTask && ports) {
    validatePortList(ports.inputs, `${taskPath}.ports.inputs`, 'inputs', errors);
    validatePortList(ports.outputs, `${taskPath}.ports.outputs`, 'outputs', errors);

    // Warn on declared-but-unused inputs. Not fatal — a user may want
    // to surface an input as a data-flow hint for the editor even when
    // the command doesn't template it explicitly.
    if (typeof task.command === 'string' && Array.isArray(ports.inputs)) {
      for (const port of ports.inputs) {
        if (!port || typeof port !== 'object') continue;
        if (!referenced.has(port.name)) {
          errors.push({
            path: `${taskPath}.ports.inputs`,
            severity: 'warning',
            message: `Task "${task.id}": command does not reference {{inputs.${port.name}}} — declared input is unused`,
          });
        }
      }
    }

    // Validate that fully-qualified `from` references point to direct
    // dependencies. The runtime's findUpstreamValue only scans dependsOn,
    // so a from that skips the dependency list will always miss at run
    // time and block the task with a cryptic "missing required input".
    if (Array.isArray(ports.inputs)) {
      for (const port of ports.inputs) {
        if (!port || typeof port !== 'object' || typeof port.from !== 'string' || !port.from.includes('.')) {
          continue;
        }
        const dot = port.from.lastIndexOf('.');
        const upstreamId = port.from.slice(0, dot);
        const deps = task.depends_on ?? [];
        const isDirectDep = deps.some((dep) => {
          const resolved = resolveTaskRef(dep, trackId, index);
          return resolved.kind === 'resolved' && resolved.qid === upstreamId;
        });
        if (!isDirectDep) {
          errors.push({
            path: `${taskPath}.ports.inputs`,
            message: `Task "${task.id}": port "${port.name}" from "${port.from}" references task "${upstreamId}" which is not a direct dependency (must be listed in depends_on)`,
          });
        }
      }
    }
  }

  // ─── Prompt-task inferred-port conflict checks ──
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
 * output port name they export. Prompt upstreams contribute nothing —
 * they pass free text via continue_from, not structured ports — so we
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
  for (const dep of task.depends_on ?? []) {
    const r = resolveTaskRef(dep, trackId, index);
    if (r.kind !== 'resolved') continue;
    const entry = qidIndex.get(r.qid);
    if (!entry) continue;
    // Only Command tasks contribute — Prompt upstreams pass free text.
    if (typeof entry.task.command !== 'string') continue;
    const outputs = entry.task.ports?.outputs;
    if (!Array.isArray(outputs)) continue;
    for (const port of outputs) {
      if (port && typeof port === 'object' && typeof port.name === 'string') {
        names.add(port.name);
      }
    }
  }
  return names;
}

/**
 * Detect the two kinds of collision that would block a Prompt Task at
 * runtime — report them at validate-time so the editor lights them up
 * before a run is attempted.
 *
 * 1. Input collision: two direct-upstream Commands both export an
 *    output with the same name. Command→Command would let the
 *    downstream disambiguate with `from:`; Prompt tasks have no port
 *    declarations and therefore no escape hatch.
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
  // ─── Input collision ──
  const producersByName = new Map<string, string[]>();
  for (const dep of task.depends_on ?? []) {
    const r = resolveTaskRef(dep, trackId, index);
    if (r.kind !== 'resolved') continue;
    const entry = qidIndex.get(r.qid);
    if (!entry || typeof entry.task.command !== 'string') continue;
    const outputs = entry.task.ports?.outputs;
    if (!Array.isArray(outputs)) continue;
    for (const port of outputs) {
      if (!port || typeof port !== 'object' || typeof port.name !== 'string') continue;
      const list = producersByName.get(port.name) ?? [];
      list.push(r.qid);
      producersByName.set(port.name, list);
    }
  }
  for (const [name, producers] of producersByName) {
    if (producers.length > 1) {
      errors.push({
        path: taskPath,
        message:
          `Task "${task.id}": upstream Commands ${producers.join(', ')} all export ` +
          `"${name}" — prompt tasks cannot disambiguate (no "from:" binding available). ` +
          `Rename the output on one of the upstream Commands.`,
      });
    }
  }

  // ─── Output collision ──
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
    if (typeof entry.task.command !== 'string') continue; // only downstream Commands contribute
    const deps = entry.task.depends_on ?? [];
    let dependsOnUs = false;
    for (const d of deps) {
      const r = resolveTaskRef(d, entry.track.id, index);
      if (r.kind === 'resolved' && r.qid === taskQid) {
        dependsOnUs = true;
        break;
      }
    }
    if (!dependsOnUs) continue;
    const inputs = entry.task.ports?.inputs;
    if (!Array.isArray(inputs)) continue;
    for (const port of inputs) {
      if (!port || typeof port !== 'object' || typeof port.name !== 'string') continue;
      const shape = portShapeKey(port);
      const prior = consumerShapeByName.get(port.name);
      if (!prior) {
        consumerShapeByName.set(port.name, { shape, firstConsumer: downstreamQid });
        continue;
      }
      if (prior.shape !== shape && !reported.has(port.name)) {
        reported.add(port.name);
        errors.push({
          path: taskPath,
          message:
            `Task "${task.id}": downstream Commands ${prior.firstConsumer} and ` +
            `${downstreamQid} disagree on the shape of inferred output "${port.name}" — ` +
            `a single LLM emission cannot satisfy both. Rename on one side.`,
        });
      }
    }
  }
}

/** Minimal shape fingerprint for conflict detection: type + enum set. */
function portShapeKey(port: PortDef): string {
  if (port.type !== 'enum') return String(port.type);
  const enums = Array.isArray(port.enum) ? [...port.enum].sort().join('|') : '';
  return `enum:${enums}`;
}

function detectCycles(config: RawPipelineConfig, index: TaskIndex): ValidationError[] {
  // Build adjacency: qualifiedId → [resolved dep qualifiedIds]
  const adj = new Map<string, string[]>();

  for (const track of config.tracks) {
    if (!track.id) continue;
    if (!Array.isArray(track.tasks)) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      const qid = qualifyTaskId(track.id, task.id);
      const deps: string[] = [];
      for (const dep of task.depends_on ?? []) {
        const resolved = resolveTaskRef(dep, track.id, index);
        if (resolved.kind === 'resolved') deps.push(resolved.qid);
      }
      if (task.continue_from) {
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
  // Canonical key = sorted node list joined — order-independent fingerprint.
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
          message: `Circular dependency detected: ${display.join(' → ')}`,
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
