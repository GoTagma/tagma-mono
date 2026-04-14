import yaml from 'js-yaml';
import { resolve, relative } from 'path';
import type {
  PipelineConfig, RawPipelineConfig, RawTrackConfig, RawTaskConfig,
  TrackConfig, TaskConfig, Permissions, MiddlewareConfig,
  TemplateConfig, TemplateParamDef,
} from './types';
import { truncateForName, validatePathParam, validatePath } from './utils';
import { DEFAULT_PERMISSIONS } from './types';
import { buildDag } from './dag';

// ═══ YAML Parsing ═══

export function parseYaml(content: string): RawPipelineConfig {
  const doc = yaml.load(content) as { pipeline?: RawPipelineConfig };
  if (!doc?.pipeline) {
    throw new Error('YAML must contain a top-level "pipeline" key');
  }
  const p = doc.pipeline;
  if (!p.name) throw new Error('pipeline.name is required');
  if (!p.tracks || p.tracks.length === 0) throw new Error('pipeline.tracks must be non-empty');

  for (const track of p.tracks) {
    validateRawTrack(track);
  }
  return p;
}

function validateRawTrack(track: RawTrackConfig): void {
  if (!track.id) throw new Error('track.id is required');
  if (!track.name) throw new Error(`track "${track.id}": name is required`);
  if (!track.tasks || track.tasks.length === 0) {
    throw new Error(`track "${track.id}": tasks must be non-empty`);
  }
  for (const task of track.tasks) {
    validateRawTask(task, track.id);
  }
}

function validateRawTask(task: RawTaskConfig, trackId: string): void {
  if (!task.id) throw new Error(`track "${trackId}": task.id is required`);
  if (task.use) return; // template usage, validated later

  const hasPromptKey = typeof task.prompt === 'string';
  const hasCommandKey = typeof task.command === 'string';
  if (!hasPromptKey && !hasCommandKey) {
    throw new Error(`task "${task.id}": must have either "prompt" or "command"`);
  }
  if (hasPromptKey && hasCommandKey) {
    throw new Error(`task "${task.id}": cannot have both "prompt" and "command"`);
  }
  // Empty-content tasks (e.g. `prompt: ''`) are allowed at parse time and
  // flagged as non-fatal validation errors by validate-raw.ts.
}

// ═══ Template Expansion ═══

export async function expandTemplates(
  tasks: readonly RawTaskConfig[],
  instancePrefix: string,
): Promise<RawTaskConfig[]> {
  const result: RawTaskConfig[] = [];

  for (const task of tasks) {
    if (!task.use) {
      result.push(task);
      continue;
    }

    const template = await loadTemplate(task.use);
    const params = resolveTemplateParams(template, task.with ?? {}, task.id);
    const expanded = expandTemplateTask(template, params, task.id, instancePrefix);
    result.push(...expanded);
  }

  return result;
}

function validateTemplateRef(ref: string): void {
  const stripped = ref.replace(/@v\d+$/, '');
  // Reject path traversal and absolute paths before they reach import().
  if (stripped.includes('..') || stripped.startsWith('/') || /^[a-zA-Z]:/.test(stripped)) {
    throw new Error(
      `Invalid template ref "${ref}": path traversal and absolute paths are not allowed. ` +
      `Use a scoped package name, e.g. "@tagma/template-review".`
    );
  }
  // Whitelist: only @tagma/template-* packages are allowed.
  if (!stripped.startsWith('@tagma/template-')) {
    throw new Error(
      `Invalid template ref "${ref}": only "@tagma/template-*" packages are allowed as templates. ` +
      `Example: "@tagma/template-review".`
    );
  }
}

async function loadTemplate(ref: string): Promise<TemplateConfig> {
  validateTemplateRef(ref);
  // Strip version suffix for import
  const moduleName = ref.replace(/@v\d+$/, '');
  try {
    const mod = await import(moduleName);
    // Expect the module to export a template.yaml content or parsed object
    if (mod.template) return mod.template as TemplateConfig;

    // Try loading template.yaml from the package.
    // NOTE: require.resolve is a CommonJS API. Bun supports it natively, but
    // this would need import.meta.resolve() for pure ESM runtimes (e.g. Deno).
    const pkgPath = require.resolve(`${moduleName}/template.yaml`);
    const content = await Bun.file(pkgPath).text();
    const doc = yaml.load(content) as { template: TemplateConfig };
    return doc.template;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Invalid template ref')) throw err;
    throw new Error(`Failed to load template: "${ref}". Is the package installed?`);
  }
}

function resolveTemplateParams(
  template: TemplateConfig,
  provided: Record<string, unknown>,
  instanceId: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const defs = template.params ?? {};

  for (const [key, def] of Object.entries(defs)) {
    const value = provided[key] ?? def.default;
    if (value === undefined) {
      throw new Error(`Template "${template.name}" instance "${instanceId}": missing required param "${key}"`);
    }
    validateParamType(key, value, def, template.name, instanceId);
    params[key] = value;
  }

  // Warn about unknown params
  for (const key of Object.keys(provided)) {
    if (!(key in defs)) {
      console.warn(`Template "${template.name}" instance "${instanceId}": unknown param "${key}"`);
    }
  }

  return params;
}

function validateParamType(
  key: string, value: unknown, def: TemplateParamDef,
  templateName: string, instanceId: string,
): void {
  const ctx = `Template "${templateName}" instance "${instanceId}" param "${key}"`;
  const ptype = def.type ?? 'string';

  switch (ptype) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`${ctx}: expected string, got ${typeof value}`);
      break;
    case 'path':
      if (typeof value !== 'string') throw new Error(`${ctx}: expected path string, got ${typeof value}`);
      validatePathParam(value);
      break;
    case 'enum':
      if (!def.enum?.includes(value as string)) {
        throw new Error(`${ctx}: value "${value}" not in allowed values [${def.enum?.join(', ')}]`);
      }
      break;
    case 'number':
      if (typeof value !== 'number') throw new Error(`${ctx}: expected number, got ${typeof value}`);
      if (def.min !== undefined && value < def.min) throw new Error(`${ctx}: ${value} < min ${def.min}`);
      if (def.max !== undefined && value > def.max) throw new Error(`${ctx}: ${value} > max ${def.max}`);
      break;
  }
}

function expandTemplateTask(
  template: TemplateConfig,
  params: Record<string, unknown>,
  instanceId: string,
  instancePrefix: string,
): RawTaskConfig[] {
  return template.tasks.map(task => {
    const prefixedId = `${instanceId}.${task.id}`;

    // Replace ${{ params.xxx }} in string fields
    const interpolate = (s: string): string =>
      s.replace(/\$\{\{\s*params\.(\w+)\s*\}\}/g, (_, key) => String(params[key] ?? ''));

    const newTask: Record<string, unknown> = { ...task, id: prefixedId };

    // Interpolate string fields
    if (task.prompt) newTask.prompt = interpolate(task.prompt);
    if (task.command) newTask.command = interpolate(task.command);

    // Namespace depends_on
    if (task.depends_on) {
      newTask.depends_on = task.depends_on.map(dep => `${instanceId}.${dep}`);
    }

    // Namespace continue_from
    if (task.continue_from) {
      newTask.continue_from = `${instanceId}.${task.continue_from}`;
    }

    // Rewrite output path to instance namespace so parallel template
    // instances don't collide on the same file. Handles any relative path
    // (e.g. ./tmp/foo, ./output/bar, ./build/result.json) by injecting
    // the instanceId as the first directory component after `./`.
    if (task.output) {
      const original = interpolate(task.output);
      newTask.output = original.startsWith('./')
        ? `./${instanceId}/${original.slice(2)}`
        : `${instanceId}/${original}`;
    }

    return newTask as unknown as RawTaskConfig;
  });
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

  const tracks: TrackConfig[] = raw.tracks.map(rawTrack => {
    const trackDriver = rawTrack.driver ?? raw.driver;
    // validatePath enforces no .. traversal and no absolute paths escaping workDir.
    const trackCwd = rawTrack.cwd ? validatePath(rawTrack.cwd, workDir) : workDir;

    const tasks: TaskConfig[] = rawTrack.tasks.map(rawTask => {
      const name = rawTask.name
        ?? (rawTask.prompt ? truncateForName(rawTask.prompt) : rawTask.command ?? rawTask.id);

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
        output: rawTask.output,
        // Inheritance: Task > Track
        model_tier: rawTask.model_tier ?? rawTrack.model_tier ?? 'medium',
        permissions: rawTask.permissions ?? rawTrack.permissions ?? DEFAULT_PERMISSIONS,
        driver: rawTask.driver ?? trackDriver ?? 'claude-code',
        timeout: rawTask.timeout,
        // Middleware: Task-level overrides Track (including [] to disable)
        middlewares: rawTask.middlewares !== undefined ? rawTask.middlewares : rawTrack.middlewares,
        completion: rawTask.completion,
        agent_profile: rawTask.agent_profile ?? rawTrack.agent_profile,
        cwd: rawTask.cwd ? validatePath(rawTask.cwd, workDir) : trackCwd,
      };
    });

    return {
      id: rawTrack.id,
      name: rawTrack.name,
      color: rawTrack.color,
      agent_profile: rawTrack.agent_profile,
      model_tier: rawTrack.model_tier ?? 'medium',
      permissions: rawTrack.permissions ?? DEFAULT_PERMISSIONS,
      driver: trackDriver ?? 'claude-code',
      cwd: trackCwd,
      middlewares: rawTrack.middlewares,
      on_failure: rawTrack.on_failure ?? 'skip_downstream',
      tasks,
    };
  });

  return {
    name: raw.name,
    driver: raw.driver,
    timeout: raw.timeout,
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

// ═══ YAML Serialization ═══

/**
 * Serialize a pipeline config back to YAML string.
 * Wraps the config under the top-level `pipeline` key as expected by parseYaml.
 */
export function serializePipeline(config: PipelineConfig | RawPipelineConfig): string {
  return yaml.dump({ pipeline: config }, { lineWidth: 120, indent: 2 });
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
  const tracks: RawTrackConfig[] = config.tracks.map(track => {
    const trackCwdRel = track.cwd && track.cwd !== workDir
      ? relative(workDir, track.cwd)
      : undefined;
    const effectiveTrackDriver = track.driver ?? config.driver ?? 'claude-code';

    const tasks: RawTaskConfig[] = track.tasks.map(task => {
      const taskCwdRel = task.cwd && task.cwd !== track.cwd
        ? relative(workDir, task.cwd)
        : undefined;

      return {
        id: task.id,
        ...(task.name ? { name: task.name } : {}),
        ...(task.prompt !== undefined ? { prompt: task.prompt } : {}),
        ...(task.command !== undefined ? { command: task.command } : {}),
        ...(task.depends_on?.length ? { depends_on: task.depends_on } : {}),
        ...(task.trigger ? { trigger: task.trigger } : {}),
        ...(task.continue_from ? { continue_from: task.continue_from } : {}),
        ...(task.output ? { output: task.output } : {}),
        ...(taskCwdRel ? { cwd: taskCwdRel } : {}),
        ...(task.model_tier && task.model_tier !== 'medium' ? { model_tier: task.model_tier } : {}),
        ...(task.driver && task.driver !== effectiveTrackDriver ? { driver: task.driver } : {}),
        ...(task.timeout ? { timeout: task.timeout } : {}),
        ...(task.middlewares !== undefined ? { middlewares: task.middlewares } : {}),
        ...(task.completion ? { completion: task.completion } : {}),
        ...(task.agent_profile ? { agent_profile: task.agent_profile } : {}),
        ...(task.permissions && !permissionsEqual(task.permissions, track.permissions)
          ? { permissions: task.permissions }
          : {}),
      };
    });

    return {
      id: track.id,
      name: track.name,
      ...(track.color ? { color: track.color } : {}),
      ...(track.agent_profile ? { agent_profile: track.agent_profile } : {}),
      ...(track.model_tier && track.model_tier !== 'medium' ? { model_tier: track.model_tier } : {}),
      ...(track.driver && track.driver !== (config.driver ?? 'claude-code') ? { driver: track.driver } : {}),
      ...(trackCwdRel ? { cwd: trackCwdRel } : {}),
      ...(track.middlewares?.length ? { middlewares: track.middlewares } : {}),
      ...(track.on_failure && track.on_failure !== 'skip_downstream' ? { on_failure: track.on_failure } : {}),
      ...(track.permissions && !permissionsEqual(track.permissions, DEFAULT_PERMISSIONS)
        ? { permissions: track.permissions }
        : {}),
      tasks,
    };
  });

  return {
    name: config.name,
    ...(config.driver ? { driver: config.driver } : {}),
    ...(config.timeout ? { timeout: config.timeout } : {}),
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
  const errors: string[] = [];
  try {
    buildDag(config);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return errors;
}

// ═══ Full Parse Pipeline ═══

export async function loadPipeline(yamlContent: string, workDir: string): Promise<PipelineConfig> {
  const raw = parseYaml(yamlContent);

  // Expand templates in each track
  const expandedTracks: RawTrackConfig[] = [];
  for (const track of raw.tracks) {
    const expandedTasks = await expandTemplates(track.tasks, track.id);
    expandedTracks.push({ ...track, tasks: expandedTasks });
  }

  const expandedRaw: RawPipelineConfig = { ...raw, tracks: expandedTracks };
  return resolveConfig(expandedRaw, workDir);
}
