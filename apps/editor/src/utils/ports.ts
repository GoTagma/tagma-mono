// Editor-side helpers for the typed-ports UX.
//
// The engine owns the *runtime* port contract (resolve, substitute,
// extract); the editor owns the *authoring* experience: showing the user
// which upstream outputs exist, what drift has accumulated since the last
// sync, and whether two different upstreams are fighting for the same
// input name. These helpers turn the raw pipeline config into the
// structured view the TaskConfigPanel needs, without duplicating the
// engine's resolution logic.
//
// Everything here is pure — it accepts a RawPipelineConfig and a
// qualified task id, and returns plain records. No store, no async.

import type {
  PortDef,
  PortType,
  RawPipelineConfig,
  RawTaskConfig,
  RawTrackConfig,
  TaskInputBinding,
  TaskInputBindings,
  TaskOutputBinding,
  TaskOutputBindings,
} from '../api/client';
import type { PromptPortInference } from '@tagma/sdk/dataflow';
import { isCommandTaskConfig } from '@tagma/types';

interface PromptNeighborPortSource {
  readonly taskId: string;
  readonly outputs?: readonly PortDef[];
  readonly inputs?: readonly PortDef[];
}

export interface UpstreamOutputCandidate {
  /** Fully-qualified task id of the producer (e.g. "trackA.plan"). */
  readonly upstreamQid: string;
  /** The exported port definition as declared on the upstream task. */
  readonly port: PortDef;
}

/**
 * Drift means: the downstream has an input with name X, the upstream
 * still exports X, but the declared metadata (type, description, enum…)
 * no longer agrees with what the upstream says. Useful for the editor
 * to show a "upstream changed — click to re-sync" affordance instead
 * of letting the configs silently drift apart.
 */
export interface PortDrift {
  readonly portName: string;
  readonly upstreamQid: string;
  readonly downstream: PortDef;
  readonly upstream: PortDef;
  readonly changes: readonly string[];
}

export interface UpstreamPortsReport {
  /** Every output port exported by any direct upstream of this task. */
  readonly candidates: readonly UpstreamOutputCandidate[];
  /**
   * Names that two or more upstreams export with matching semantics.
   * At runtime the engine flags ambiguous matches as a blocked task;
   * the editor should prompt the user to add an explicit `from` binding.
   */
  readonly ambiguous: readonly {
    readonly portName: string;
    readonly producers: readonly string[];
  }[];
  /**
   * Inputs already declared on the downstream task that no longer have a
   * matching upstream output (neither by name nor by explicit `from`).
   * These will be `missing required` at runtime; the editor renders them
   * in red.
   */
  readonly unmatched: readonly PortDef[];
  /** Shape-mismatches between downstream inputs and upstream outputs. */
  readonly drift: readonly PortDrift[];
}

/**
 * Split a qualified id like "trackA.planner" into its parts. Returns
 * null for malformed ids (defensive — callers generally feed a good id).
 */
function splitQid(qid: string): { trackId: string; taskId: string } | null {
  const dot = qid.indexOf('.');
  if (dot <= 0 || dot === qid.length - 1) return null;
  return { trackId: qid.slice(0, dot), taskId: qid.slice(dot + 1) };
}

/** Flat qualified-id map over the whole pipeline — handy for lookups. */
function buildQidIndex(
  config: RawPipelineConfig,
): Map<string, { track: RawTrackConfig; task: RawTaskConfig }> {
  const idx = new Map<string, { track: RawTrackConfig; task: RawTaskConfig }>();
  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      idx.set(`${track.id}.${task.id}`, { track, task });
    }
  }
  return idx;
}

export function inputBindingsToPorts(bindings: TaskInputBindings | undefined): PortDef[] {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return [];
  return Object.entries(bindings).map(([name, binding]) => ({
    name,
    type: binding.type ?? 'json',
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.required !== undefined ? { required: binding.required } : {}),
    ...(binding.default !== undefined ? { default: binding.default } : {}),
    ...(binding.enum ? { enum: [...binding.enum] } : {}),
    ...(binding.from ? { from: binding.from } : {}),
  }));
}

export function outputBindingsToPorts(bindings: TaskOutputBindings | undefined): PortDef[] {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return [];
  return Object.entries(bindings).map(([name, binding]) => ({
    name,
    type: binding.type ?? 'json',
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.enum ? { enum: [...binding.enum] } : {}),
  }));
}

export function inputPortsToBindings(
  ports: readonly PortDef[] | undefined,
): TaskInputBindings | undefined {
  return mergeInputPortsIntoBindings(undefined, ports);
}

export function outputPortsToBindings(
  ports: readonly PortDef[] | undefined,
): TaskOutputBindings | undefined {
  return mergeOutputPortsIntoBindings(undefined, ports);
}

export function mergeInputPortsIntoBindings(
  existing: TaskInputBindings | undefined,
  ports: readonly PortDef[] | undefined,
): TaskInputBindings | undefined {
  if (!ports || ports.length === 0) return undefined;
  return Object.fromEntries(
    ports.map((port) => {
      const base = existing?.[port.name] ?? {};
      return [
        port.name,
        cleanBinding({
          ...base,
          ...portTypePatch(base, port.type),
          ...(port.description ? { description: port.description } : {}),
          ...(port.required !== undefined ? { required: port.required } : {}),
          ...(port.default !== undefined ? { default: port.default } : {}),
          ...(port.enum ? { enum: [...port.enum] } : {}),
          ...(port.from ? { from: port.from } : {}),
        }),
      ];
    }),
  );
}

export function mergeOutputPortsIntoBindings(
  existing: TaskOutputBindings | undefined,
  ports: readonly PortDef[] | undefined,
): TaskOutputBindings | undefined {
  if (!ports || ports.length === 0) return undefined;
  return Object.fromEntries(
    ports.map((port) => {
      const base = existing?.[port.name] ?? {};
      return [
        port.name,
        cleanBinding({
          ...base,
          ...portTypePatch(base, port.type),
          ...(port.description ? { description: port.description } : {}),
          ...(port.enum ? { enum: [...port.enum] } : {}),
        }),
      ];
    }),
  );
}

function cleanBinding<T extends TaskInputBinding | TaskOutputBinding>(binding: T): T {
  const next = { ...binding } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  return next as T;
}

function portTypePatch(
  existing: { readonly type?: PortType },
  type: PortType,
): { readonly type?: PortType } {
  if (type === 'json' && existing.type === undefined) return {};
  return { type };
}

/**
 * Resolve a single `depends_on` ref (`task_id` or `track_id.task_id`)
 * from the perspective of `fromTrackId`. Mirrors the SDK's
 * `resolveTaskRef` but returns null rather than distinguishing
 * "ambiguous" / "not found" — the editor panel already surfaces those
 * via the main validate-raw pass; here we only need the qid for lookup.
 */
function resolveDependencyRef(
  ref: string,
  fromTrackId: string,
  qidIndex: Map<string, unknown>,
): string | null {
  if (ref.includes('.')) {
    return qidIndex.has(ref) ? ref : null;
  }
  const sameTrack = `${fromTrackId}.${ref}`;
  if (qidIndex.has(sameTrack)) return sameTrack;
  let hit: string | null = null;
  for (const key of qidIndex.keys()) {
    if (key.endsWith(`.${ref}`)) {
      if (hit !== null) return null; // ambiguous — bail, editor already flags
      hit = key;
    }
  }
  return hit;
}

/**
 * Given a downstream task, build the full picture of what its direct
 * upstreams currently export and how that compares to what this task
 * has declared as inputs. This one function powers both the "Inputs"
 * editor (suggestions + drift warnings) and the "Sync from upstream" button.
 */
export function buildUpstreamPortsReport(
  config: RawPipelineConfig,
  downstreamQid: string,
): UpstreamPortsReport {
  const qidIndex = buildQidIndex(config);
  const split = splitQid(downstreamQid);
  const entry = qidIndex.get(downstreamQid);
  if (!split || !entry) {
    return { candidates: [], ambiguous: [], unmatched: [], drift: [] };
  }

  const downstreamInputs = inputBindingsToPorts(entry.task.inputs);

  // Collect upstream outputs keyed by the *output* name. Multiple upstreams
  // can export the same name — we keep them all so we can detect ambiguity
  // and so a user with `from: "producer.name"` can pick a specific one.
  const candidates: UpstreamOutputCandidate[] = [];
  const producersByName = new Map<string, string[]>();
  const outputByUpstream = new Map<string, Map<string, PortDef>>();

  const deps = entry.task.depends_on ?? [];
  for (const dep of deps) {
    const qid = resolveDependencyRef(dep, split.trackId, qidIndex);
    if (!qid) continue;
    const upstream = qidIndex.get(qid);
    if (!upstream) continue;
    const outputs = outputBindingsToPorts(upstream.task.outputs);
    if (outputs.length === 0) continue;
    outputByUpstream.set(qid, new Map(outputs.map((p) => [p.name, p])));
    for (const port of outputs) {
      candidates.push({ upstreamQid: qid, port });
      const list = producersByName.get(port.name) ?? [];
      list.push(qid);
      producersByName.set(port.name, list);
    }
  }

  const ambiguous = [...producersByName.entries()]
    .filter(([, producers]) => producers.length > 1)
    .map(([portName, producers]) => ({ portName, producers }));

  // For downstream inputs, find a matching producer and compare shapes.
  const unmatched: PortDef[] = [];
  const drift: PortDrift[] = [];
  for (const input of downstreamInputs) {
    const match = resolveUpstreamForInput(input, outputByUpstream);
    if (!match) {
      unmatched.push(input);
      continue;
    }
    const changes = diffPortShape(input, match.port);
    if (changes.length > 0) {
      drift.push({
        portName: input.name,
        upstreamQid: match.upstreamQid,
        downstream: input,
        upstream: match.port,
        changes,
      });
    }
  }

  return { candidates, ambiguous, unmatched, drift };
}

/**
 * Find the upstream output that satisfies a given downstream input,
 * honouring an explicit `from` binding where present.
 */
export function resolveUpstreamForInput(
  input: PortDef,
  outputByUpstream: ReadonlyMap<string, ReadonlyMap<string, PortDef>>,
): { upstreamQid: string; port: PortDef } | null {
  const exact = parseProducerOutputSource(input.from);
  if (exact) {
    const upstreamQid = resolveProducerQid(exact.upstreamRef, outputByUpstream.keys());
    if (!upstreamQid) return null;
    const { portName } = exact;
    const out = outputByUpstream.get(upstreamQid)?.get(portName);
    return out ? { upstreamQid, port: out } : null;
  }
  const key = parseLooseOutputSource(input.from) ?? input.name;
  const hits: { upstreamQid: string; port: PortDef }[] = [];
  for (const [upstreamQid, map] of outputByUpstream) {
    const out = map.get(key);
    if (out) hits.push({ upstreamQid, port: out });
  }
  return hits.length === 1 ? hits[0]! : null;
}

function parseProducerOutputSource(
  source: string | undefined,
): { upstreamRef: string; portName: string } | null {
  if (!source) return null;
  if (source.startsWith('outputs.')) return null;
  const marker = '.outputs.';
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex > 0) {
    const upstreamRef = source.slice(0, markerIndex);
    const portName = source.slice(markerIndex + marker.length);
    return upstreamRef && portName ? { upstreamRef, portName } : null;
  }
  const dot = source.lastIndexOf('.');
  if (dot <= 0) return null;
  const upstreamRef = source.slice(0, dot);
  const portName = source.slice(dot + 1);
  return upstreamRef && portName ? { upstreamRef, portName } : null;
}

function parseLooseOutputSource(source: string | undefined): string | null {
  if (!source) return null;
  const prefix = 'outputs.';
  if (!source.startsWith(prefix)) return null;
  const name = source.slice(prefix.length);
  return name || null;
}

function resolveProducerQid(upstreamRef: string, upstreamQids: Iterable<string>): string | null {
  const all = [...upstreamQids];
  if (all.includes(upstreamRef)) return upstreamRef;
  if (upstreamRef.includes('.')) return null;
  const matches = all.filter((qid) => bareTaskId(qid) === upstreamRef);
  return matches.length === 1 ? matches[0]! : null;
}

function bareTaskId(qid: string): string {
  const dot = qid.lastIndexOf('.');
  return dot >= 0 ? qid.slice(dot + 1) : qid;
}

/**
 * Return a list of human-readable differences between a downstream
 * input and its matched upstream output. `name` is always expected to
 * agree (that's how we matched) so it's not in the comparison.
 */
export function diffPortShape(input: PortDef, output: PortDef): string[] {
  const changes: string[] = [];
  if (input.type !== output.type) {
    changes.push(`type: ${input.type} → ${output.type}`);
  }
  const inDescr = (input.description ?? '').trim();
  const outDescr = (output.description ?? '').trim();
  if (inDescr !== outDescr) changes.push('description changed');
  if (input.type === 'enum') {
    const a = [...(input.enum ?? [])].sort().join(',');
    const b = [...(output.enum ?? [])].sort().join(',');
    if (a !== b) changes.push('enum values changed');
  }
  return changes;
}

/**
 * Build the fresh `ports.inputs` array the editor should write when the
 * user clicks "sync from upstream". Behaviour:
 *   - Every upstream output name that has a unique producer is added as
 *     an input (copied shape: type, description, enum) with a source that
 *     retains the producer task identity.
 *   - Names exported by multiple upstreams become inputs with an
 *     explicit `from: "upstreamQid.name"` pointing at whichever producer
 *     declared it first, so the runtime doesn't block on ambiguity.
 *     The user can switch producers by editing `from` afterwards.
 *   - Legacy editor-authored `from: "outputs.name"` sources are upgraded
 *     to a concrete producer so mixed command/prompt fan-in stays attributable.
 *   - If the downstream already declared inputs under these names,
 *     existing settings (required, default, specific from) are preserved
 *     — sync is idempotent and non-destructive for user edits.
 *
 * Returns `undefined` when the resulting inputs array is empty so the
 * caller can clear the field (YAML round-trip prefers absent over
 * `inputs: []`).
 */
export function computeSyncedInputs(
  existing: readonly PortDef[] | undefined,
  candidates: readonly UpstreamOutputCandidate[],
): PortDef[] | undefined {
  if (candidates.length === 0) return existing ? [...existing] : undefined;

  const existingByName = new Map<string, PortDef>((existing ?? []).map((p) => [p.name, p]));
  const byName = new Map<string, UpstreamOutputCandidate[]>();
  for (const cand of candidates) {
    const list = byName.get(cand.port.name) ?? [];
    list.push(cand);
    byName.set(cand.port.name, list);
  }

  const nextByName = new Map<string, PortDef>();
  for (const [name, list] of byName) {
    const existingPort = existingByName.get(name);
    const producer = list[0]!;
    const existingSpecificSource =
      existingPort?.from && existingPort.from !== `outputs.${name}` ? existingPort.from : undefined;
    const copied: PortDef = {
      name,
      type: producer.port.type as PortType,
      ...(producer.port.description ? { description: producer.port.description } : {}),
      ...(producer.port.enum ? { enum: [...producer.port.enum] } : {}),
      ...(existingPort?.required !== undefined
        ? { required: existingPort.required }
        : { required: true }),
      ...(existingPort?.default !== undefined ? { default: existingPort.default } : {}),
      from: existingSpecificSource ?? sourceForCandidate(producer, candidates),
    };
    nextByName.set(name, copied);
  }

  // Preserve any pre-existing inputs that don't correspond to an upstream
  // output — the user may be using defaults or external triggers to fill
  // them in. Sync should never delete user-authored ports.
  for (const [name, port] of existingByName) {
    if (!nextByName.has(name)) nextByName.set(name, port);
  }

  const result = [...nextByName.values()];
  return result.length > 0 ? result : undefined;
}

const RESERVED_INPUT_SOURCE_FIELDS = new Set(['stdout', 'stderr', 'normalizedOutput', 'exitCode']);

function sourceForCandidate(
  candidate: UpstreamOutputCandidate,
  candidates: readonly UpstreamOutputCandidate[],
): string {
  const taskId = bareTaskId(candidate.upstreamQid);
  const bareTaskIdIsUnique =
    candidates.filter((other) => bareTaskId(other.upstreamQid) === taskId).length === 1;
  if (!bareTaskIdIsUnique || RESERVED_INPUT_SOURCE_FIELDS.has(candidate.port.name)) {
    return `${candidate.upstreamQid}.outputs.${candidate.port.name}`;
  }
  return `${taskId}.${candidate.port.name}`;
}

// ─── Reverse direction: upstream outputs synced from downstream inputs ──
//
// The upstream task authors `outputs`; downstream tasks author `inputs`.
// When the upstream hasn't declared an output yet but a downstream already
// declared a matching input, the editor offers a one-click "Sync N from
// downstream" button so the upstream can adopt the contract the downstream
// is already expecting. Symmetric to the forward flow above.

export interface DownstreamInputCandidate {
  /** Fully-qualified task id of the consumer (e.g. "trackA.report"). */
  readonly downstreamQid: string;
  /** The output-side port this upstream should expose for that consumer. */
  readonly port: PortDef;
}

export interface DownstreamPortsReport {
  /** Every input port declared by any direct downstream of this task. */
  readonly candidates: readonly DownstreamInputCandidate[];
  /**
   * Names declared by two or more downstreams with different shapes.
   * Sync picks one (the first encountered) and preserves it; the user
   * can manually reconcile later.
   */
  readonly conflicting: readonly {
    readonly portName: string;
    readonly consumers: readonly string[];
  }[];
}

/**
 * Given an upstream task, collect every `inputs` port declared by a
 * task that directly depends on it. Mirror of `buildUpstreamPortsReport`
 * but walking the reverse dependency edge.
 */
export function buildDownstreamPortsReport(
  config: RawPipelineConfig,
  upstreamQid: string,
): DownstreamPortsReport {
  const qidIndex = buildQidIndex(config);
  if (!qidIndex.has(upstreamQid)) {
    return { candidates: [], conflicting: [] };
  }

  const candidates: DownstreamInputCandidate[] = [];
  const shapeByName = new Map<string, { shape: string; consumers: string[] }>();

  for (const [qid, { track, task }] of qidIndex) {
    if (qid === upstreamQid) continue;
    const deps = task.depends_on ?? [];
    const dependencyQids: string[] = [];
    let dependsOnUs = false;
    for (const dep of deps) {
      const resolved = resolveDependencyRef(dep, track.id, qidIndex);
      if (!resolved) continue;
      dependencyQids.push(resolved);
      if (resolved === upstreamQid) {
        dependsOnUs = true;
      }
    }
    if (!dependsOnUs) continue;
    const inputs = inputBindingsToPorts(task.inputs);
    for (const input of inputs) {
      const port = downstreamInputToUpstreamOutputCandidate(input, dependencyQids, upstreamQid);
      if (!port) continue;
      candidates.push({ downstreamQid: qid, port });
      const shape = portShapeKey(port);
      const entry = shapeByName.get(port.name);
      if (!entry) {
        shapeByName.set(port.name, { shape, consumers: [qid] });
      } else {
        entry.consumers.push(qid);
        if (entry.shape !== shape) {
          // Shape mismatch is recorded as conflict; the stored shape
          // stays the first one encountered (which is what sync will
          // adopt), making the conflict list actionable.
        }
      }
    }
  }

  const conflicting: { portName: string; consumers: string[] }[] = [];
  const seenShapes = new Map<string, Set<string>>();
  for (const cand of candidates) {
    const set = seenShapes.get(cand.port.name) ?? new Set<string>();
    set.add(portShapeKey(cand.port));
    seenShapes.set(cand.port.name, set);
  }
  for (const [name, shapes] of seenShapes) {
    if (shapes.size > 1) {
      const consumers = shapeByName.get(name)?.consumers ?? [];
      conflicting.push({ portName: name, consumers });
    }
  }

  return { candidates, conflicting };
}

function downstreamInputToUpstreamOutputCandidate(
  input: PortDef,
  dependencyQids: readonly string[],
  upstreamQid: string,
): PortDef | null {
  const exact = parseProducerOutputSource(input.from);
  if (exact) {
    const producerQid = resolveProducerQid(exact.upstreamRef, dependencyQids);
    if (producerQid !== upstreamQid) return null;
    return { ...input, name: exact.portName };
  }

  const loose = parseLooseOutputSource(input.from);
  if (loose) {
    return dependencyQids.length === 1 ? { ...input, name: loose } : null;
  }

  return dependencyQids.length === 1 ? input : null;
}

// ─── Prompt-task inferred-port view ───────────────────────────────────
//
// Prompt Tasks get inferred ports from direct-neighbor Command Tasks and
// can also declare explicit task-level `inputs` / `outputs`. The editor
// mirrors the runtime inference so the Task Inspector can show what data
// the Prompt will receive and what it must produce.
//
// Browser code may not import @tagma/sdk/@tagma/core runtime modules (see
// client-bundle-boundary.test.ts), so this is a local mirror of the SDK's
// pure inferPromptPorts helper. editor-ports-utils.test.ts compares it
// against @tagma/sdk/dataflow so SDK/core remain the source of truth.
function inferPromptPortsForClient(input: {
  readonly promptTaskId?: string;
  readonly upstreams: readonly PromptNeighborPortSource[];
  readonly downstreams: readonly PromptNeighborPortSource[];
}): PromptPortInference {
  const inputsByName = new Map<string, { port: PortDef; firstProducer: string }>();
  const inputCollisionSources = new Map<string, { taskId: string; type: PortType }[]>();

  for (const upstream of input.upstreams) {
    if (!upstream.outputs || upstream.outputs.length === 0) continue;
    for (const out of upstream.outputs) {
      const prior = inputsByName.get(out.name);
      if (!prior) {
        inputsByName.set(out.name, {
          port: {
            name: out.name,
            type: out.type,
            ...(out.description ? { description: out.description } : {}),
            ...(out.enum ? { enum: [...out.enum] } : {}),
            required: true,
          },
          firstProducer: upstream.taskId,
        });
        continue;
      }

      const list = inputCollisionSources.get(out.name) ?? [
        { taskId: prior.firstProducer, type: prior.port.type },
      ];
      list.push({ taskId: upstream.taskId, type: out.type });
      inputCollisionSources.set(out.name, list);
    }
  }

  const inputConflicts: Array<PromptPortInference['inputConflicts'][number]> = [];
  for (const [portName, producers] of inputCollisionSources) {
    const producerList = producers.map((p) => p.taskId).join(', ');
    inputConflicts.push({
      portName,
      producers,
      reason:
        `input "${portName}" is produced by multiple upstream Commands (${producerList}) - ` +
        `declare explicit input aliases with "from" bindings on the Prompt task, ` +
        `or rename one of the upstream outputs.`,
    });
  }

  const outputsByName = new Map<string, { port: PortDef; firstConsumer: string }>();
  const outputCollisionSources = new Map<string, { taskId: string; type: PortType }[]>();

  for (const downstream of input.downstreams) {
    if (!downstream.inputs || downstream.inputs.length === 0) continue;
    for (const inp of downstream.inputs) {
      const outputPort = inferPromptOutputPort(inp, input.promptTaskId);
      if (outputPort === null) continue;
      const prior = outputsByName.get(outputPort.name);
      if (!prior) {
        outputsByName.set(outputPort.name, {
          port: outputPort,
          firstConsumer: downstream.taskId,
        });
        continue;
      }
      if (portsAreCompatible(prior.port, outputPort)) continue;

      const list = outputCollisionSources.get(outputPort.name) ?? [
        { taskId: prior.firstConsumer, type: prior.port.type },
      ];
      list.push({ taskId: downstream.taskId, type: outputPort.type });
      outputCollisionSources.set(outputPort.name, list);
    }
  }

  const outputConflicts: Array<PromptPortInference['outputConflicts'][number]> = [];
  for (const [portName, producers] of outputCollisionSources) {
    const consumerList = producers.map((p) => `${p.taskId} (${p.type})`).join(', ');
    outputConflicts.push({
      portName,
      producers,
      reason:
        `output "${portName}" has conflicting type requirements across downstream Commands ` +
        `(${consumerList}) - a single LLM emission cannot satisfy both. ` +
        `Rename the input on one of the downstream Commands.`,
    });
  }

  const inferredInputs = [...inputsByName.values()].map((entry) => entry.port);
  const inferredOutputs = [...outputsByName.values()].map((entry) => entry.port);
  return {
    ports: {
      ...(inferredInputs.length > 0 ? { inputs: inferredInputs } : {}),
      ...(inferredOutputs.length > 0 ? { outputs: inferredOutputs } : {}),
    },
    inputConflicts,
    outputConflicts,
  };
}

function inferPromptOutputPort(input: PortDef, promptTaskId: string | undefined): PortDef | null {
  const outputName = promptOutputNameFromInput(input, promptTaskId);
  if (outputName === null) return null;
  return {
    name: outputName,
    type: input.type,
    ...(input.description ? { description: input.description } : {}),
    ...(input.enum ? { enum: [...input.enum] } : {}),
  };
}

function promptOutputNameFromInput(
  input: PortDef,
  promptTaskId: string | undefined,
): string | null {
  const source = input.from;
  if (!source) return input.name;
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

function sourceRefMatchesTaskId(sourceTaskId: string, taskId: string | undefined): boolean {
  if (taskId === undefined) return true;
  if (sourceTaskId === taskId) return true;
  return !sourceTaskId.includes('.') && bareTaskId(taskId) === sourceTaskId;
}

function portsAreCompatible(a: PortDef, b: PortDef): boolean {
  if (a.type !== b.type) return false;
  if (a.type !== 'enum') return true;
  const aEnum = [...(a.enum ?? [])].sort();
  const bEnum = [...(b.enum ?? [])].sort();
  return aEnum.length === bEnum.length && aEnum.every((value, index) => value === bEnum[index]);
}

export interface InferredPromptPortsView {
  /** Synthetic ports (inputs+outputs) the Prompt will actually see. */
  readonly ports: PromptPortInference['ports'];
  /**
   * Upstream-Command name collisions that would block the task at runtime.
   * Editor renders these as red error cards with the producer list so the
   * user can click through to rename on one side.
   */
  readonly inputConflicts: PromptPortInference['inputConflicts'];
  /**
   * Downstream-Command type conflicts that can't be resolved by any single
   * LLM emission. Same UX treatment as inputConflicts.
   */
  readonly outputConflicts: PromptPortInference['outputConflicts'];
  /** Direct-upstream task qids (for showing provenance). */
  readonly upstreamIds: readonly string[];
  /** Direct-downstream task qids (for showing provenance). */
  readonly downstreamIds: readonly string[];
}

/**
 * Compute the inferred port view for a Prompt Task. Returns an empty
 * view (no ports, no conflicts) when the task is not a Prompt Task or
 * doesn't exist — callers should check `task.prompt !== undefined`
 * themselves if they want to distinguish.
 */
export function buildInferredPromptPorts(
  config: RawPipelineConfig,
  promptQid: string,
): InferredPromptPortsView {
  const qidIndex = buildQidIndex(config);
  const split = splitQid(promptQid);
  const entry = qidIndex.get(promptQid);
  if (!split || !entry) {
    return {
      ports: {},
      inputConflicts: [],
      outputConflicts: [],
      upstreamIds: [],
      downstreamIds: [],
    };
  }

  // Direct upstreams (what this task depends on).
  const upstreamIds: string[] = [];
  for (const dep of entry.task.depends_on ?? []) {
    const qid = resolveDependencyRef(dep, split.trackId, qidIndex);
    if (qid && !upstreamIds.includes(qid)) upstreamIds.push(qid);
  }
  // Direct downstreams (anyone who depends on this task).
  const downstreamIds: string[] = [];
  for (const [otherQid, otherEntry] of qidIndex) {
    if (otherQid === promptQid) continue;
    const deps = otherEntry.task.depends_on ?? [];
    const depsOnUs = deps.some(
      (d) => resolveDependencyRef(d, otherEntry.track.id, qidIndex) === promptQid,
    );
    if (depsOnUs) downstreamIds.push(otherQid);
  }

  const inference = inferPromptPortsForClient({
    promptTaskId: promptQid,
    upstreams: upstreamIds.map((qid) => {
      const up = qidIndex.get(qid);
      const isCommand = up ? isCommandTaskConfig(up.task) : false;
      return {
        taskId: qid,
        outputs: isCommand ? outputBindingsToPorts(up?.task.outputs) : undefined,
      };
    }),
    downstreams: downstreamIds.map((qid) => {
      const down = qidIndex.get(qid);
      const isCommand = down ? isCommandTaskConfig(down.task) : false;
      return {
        taskId: qid,
        inputs: isCommand ? inputBindingsToPorts(down?.task.inputs) : undefined,
      };
    }),
  });

  return {
    ports: inference.ports,
    inputConflicts: inference.inputConflicts,
    outputConflicts: inference.outputConflicts,
    upstreamIds,
    downstreamIds,
  };
}

// ─── Unified editor ports view ───────────────────────────────────────
//
// The editor renders Command and Prompt task dataflow through the same
// panel. Command tasks usually have only explicit bindings; Prompt tasks
// can have inferred rows plus explicit manual overrides.

export type UnifiedPortKind = 'input' | 'output';
export type UnifiedPortStatus = 'inferred' | 'manual' | 'overridden' | 'conflict';
export type UnifiedPortSourceKind =
  | 'auto_by_name'
  | 'specific_upstream'
  | 'literal_value'
  | 'default_value'
  | 'output_json'
  | 'output_stream'
  | 'output_source'
  | 'inferred_downstream'
  | 'conflict';

export interface UnifiedPortSource {
  readonly kind: UnifiedPortSourceKind;
  readonly label: string;
  readonly detail?: string;
}

export interface UnifiedPortConflict {
  readonly portName: string;
  readonly producers: readonly { readonly taskId: string; readonly type: PortType }[];
  readonly reason: string;
}

export interface UnifiedPortRow {
  readonly kind: UnifiedPortKind;
  readonly name: string;
  readonly type: PortType;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly required?: boolean;
  readonly status: UnifiedPortStatus;
  readonly source: UnifiedPortSource;
  readonly binding?: TaskInputBinding | TaskOutputBinding;
  readonly inferred?: PortDef;
  readonly conflict?: UnifiedPortConflict;
}

export interface UnifiedPortsView {
  readonly inputs: readonly UnifiedPortRow[];
  readonly outputs: readonly UnifiedPortRow[];
  readonly upstreamIds: readonly string[];
  readonly downstreamIds: readonly string[];
}

export function buildUnifiedPortsView(input: {
  readonly inputs?: TaskInputBindings;
  readonly outputs?: TaskOutputBindings;
  readonly inferred?: InferredPromptPortsView | null;
}): UnifiedPortsView {
  return {
    inputs: buildUnifiedPortRows({
      kind: 'input',
      explicit: inputBindingsToPorts(input.inputs),
      explicitBindings: input.inputs,
      inferred: toEditorPorts(input.inferred?.ports.inputs),
      conflicts: input.inferred?.inputConflicts ?? [],
    }),
    outputs: buildUnifiedPortRows({
      kind: 'output',
      explicit: outputBindingsToPorts(input.outputs),
      explicitBindings: input.outputs,
      inferred: toEditorPorts(input.inferred?.ports.outputs),
      conflicts: input.inferred?.outputConflicts ?? [],
    }),
    upstreamIds: input.inferred?.upstreamIds ?? [],
    downstreamIds: input.inferred?.downstreamIds ?? [],
  };
}

function toEditorPorts(
  ports:
    | readonly {
        readonly name: string;
        readonly type: PortType;
        readonly description?: string;
        readonly required?: boolean;
        readonly default?: unknown;
        readonly enum?: readonly string[];
        readonly from?: string;
      }[]
    | undefined,
): PortDef[] {
  return (ports ?? []).map((port) => ({
    name: port.name,
    type: port.type,
    ...(port.description ? { description: port.description } : {}),
    ...(port.required !== undefined ? { required: port.required } : {}),
    ...(port.default !== undefined ? { default: port.default } : {}),
    ...(port.enum ? { enum: [...port.enum] } : {}),
    ...(port.from ? { from: port.from } : {}),
  }));
}

function buildUnifiedPortRows(input: {
  readonly kind: UnifiedPortKind;
  readonly explicit: readonly PortDef[];
  readonly explicitBindings?: TaskInputBindings | TaskOutputBindings;
  readonly inferred: readonly PortDef[];
  readonly conflicts: readonly UnifiedPortConflict[];
}): UnifiedPortRow[] {
  const explicitByName = new Map(input.explicit.map((port) => [port.name, port]));
  const inferredByName = new Map(input.inferred.map((port) => [port.name, port]));
  const conflictByName = new Map(input.conflicts.map((conflict) => [conflict.portName, conflict]));
  const names: string[] = [];
  const pushName = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };

  for (const port of input.inferred) pushName(port.name);
  for (const port of input.explicit) pushName(port.name);
  for (const conflict of input.conflicts) pushName(conflict.portName);

  return names.map((name) => {
    const explicit = explicitByName.get(name);
    const inferred = inferredByName.get(name);
    const conflict = conflictByName.get(name);
    const binding = input.explicitBindings?.[name];

    if (conflict && !explicit && !inferred) {
      return {
        kind: input.kind,
        name,
        type: conflict.producers[0]?.type ?? 'json',
        status: 'conflict',
        source: {
          kind: 'conflict',
          label: input.kind === 'input' ? 'Needs explicit source' : 'Needs explicit output',
          detail: conflict.producers.map((p) => p.taskId).join(', '),
        },
        conflict,
      };
    }

    const port = explicit ?? inferred ?? { name, type: 'json' as const };
    const status: UnifiedPortStatus = explicit
      ? inferred
        ? 'overridden'
        : 'manual'
      : conflict
        ? 'conflict'
        : 'inferred';

    return {
      kind: input.kind,
      name: port.name,
      type: port.type,
      ...(port.description ? { description: port.description } : {}),
      ...(port.enum ? { enum: [...port.enum] } : {}),
      ...(port.required !== undefined ? { required: port.required } : {}),
      status,
      source: binding
        ? sourceForBinding(input.kind, name, binding)
        : inferred
          ? sourceForInferredPort(input.kind, name)
          : sourceForBinding(input.kind, name, {}),
      ...(binding ? { binding } : {}),
      ...(inferred ? { inferred } : {}),
      ...(conflict ? { conflict } : {}),
    };
  });
}

function sourceForBinding(
  kind: UnifiedPortKind,
  name: string,
  binding: Partial<TaskInputBinding & TaskOutputBinding>,
): UnifiedPortSource {
  if (binding.value !== undefined) {
    return {
      kind: 'literal_value',
      label: 'Literal value',
      detail: formatSourceValue(binding.value),
    };
  }
  if (kind === 'input') {
    if (binding.from) {
      if (binding.from === `outputs.${name}`) {
        return { kind: 'auto_by_name', label: 'Auto by name', detail: binding.from };
      }
      return {
        kind: 'specific_upstream',
        label: 'Specific upstream output',
        detail: binding.from,
      };
    }
    if (binding.default !== undefined) {
      return {
        kind: 'default_value',
        label: 'Default value',
        detail: formatSourceValue(binding.default),
      };
    }
    return { kind: 'auto_by_name', label: 'Auto by name', detail: `outputs.${name}` };
  }

  if (binding.from) {
    if (binding.from.startsWith('json.')) {
      return { kind: 'output_json', label: 'Publish from JSON', detail: binding.from };
    }
    if (isOutputStreamSource(binding.from)) {
      return { kind: 'output_stream', label: 'Publish from stream', detail: binding.from };
    }
    return { kind: 'output_source', label: 'Publish from source', detail: binding.from };
  }
  if (binding.default !== undefined) {
    return {
      kind: 'default_value',
      label: 'Default value',
      detail: formatSourceValue(binding.default),
    };
  }
  return { kind: 'output_json', label: 'Publish from JSON', detail: `json.${name}` };
}

function sourceForInferredPort(kind: UnifiedPortKind, name: string): UnifiedPortSource {
  if (kind === 'input') {
    return { kind: 'auto_by_name', label: 'Auto by name', detail: `outputs.${name}` };
  }
  return {
    kind: 'inferred_downstream',
    label: 'Expected by downstream',
    detail: `json.${name}`,
  };
}

function isOutputStreamSource(source: string): boolean {
  return source === 'stdout' || source === 'stderr' || source === 'normalizedOutput';
}

function formatSourceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Serialize the subset of port fields that matter for output-side sync. */
function portShapeKey(port: PortDef): string {
  const enumKey = port.type === 'enum' ? [...(port.enum ?? [])].sort().join('|') : '';
  return `${port.type}::${(port.description ?? '').trim()}::${enumKey}`;
}

/**
 * Build the fresh `ports.outputs` array for "sync from downstream".
 *
 * Behaviour:
 *   - Every downstream-consumed output name that is *not* already an output
 *     is added (copied shape: type, description, enum). Input-only fields
 *     (required, default, from) are dropped because they're meaningless
 *     on outputs.
 *   - Existing outputs are preserved untouched — sync never overwrites
 *     a contract the upstream has already committed to.
 *   - When two downstreams declare the same input with different shapes,
 *     the first one encountered wins; the editor surfaces the conflict
 *     separately so the user can reconcile manually.
 *
 * Returns `undefined` when the resulting list is empty so the caller can
 * omit the field from the YAML (absent > `outputs: []`).
 */
/**
 * Deep-equality check for two arrays of PortDef.
 * Order-sensitive: ports in different order are considered unequal.
 */
export function portsEqual(
  a: readonly PortDef[] | undefined,
  b: readonly PortDef[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.name !== pb.name) return false;
    if (pa.type !== pb.type) return false;
    if (pa.description !== pb.description) return false;
    if (String(pa.required) !== String(pb.required)) return false;
    if (JSON.stringify(pa.default) !== JSON.stringify(pb.default)) return false;
    if (pa.from !== pb.from) return false;
    const enumA = JSON.stringify(pa.enum ?? null);
    const enumB = JSON.stringify(pb.enum ?? null);
    if (enumA !== enumB) return false;
  }
  return true;
}

// ─── Pipeline- and track-level boundary I/O ──────────────────────────
//
// The Track I/O dialog needs two views of the same pipeline:
//
//   • Pipeline boundary (the "All" mode): inputs no task in the entire
//     pipeline satisfies (must come from outside the run) and outputs no
//     task in the pipeline consumes (the run's net products).
//
//   • Track boundary (the "By Track" mode for a chosen track): inputs no
//     task *in the same track* satisfies (whether they come from another
//     track or from outside the run) and outputs that some task *outside
//     this track* consumes — or that nothing consumes at all. Ports that
//     stay entirely inside the track are intentionally hidden.
//
// All four collectors are pure derivations of the raw config — nothing
// here touches the runtime. They share the same row shape so the dialog
// can render them with a single component.

export interface PortIORow {
  readonly trackId: string;
  readonly trackName: string;
  readonly taskId: string;
  readonly taskName?: string;
  /** Fully-qualified id `${trackId}.${taskId}` — handy as a stable key. */
  readonly qid: string;
  readonly port: PortDef;
}

interface ConsumerEdge {
  readonly producerQid: string;
  readonly portName: string;
  readonly consumerTrackId: string;
}

/**
 * Walk every task in the pipeline once and emit a "consumer edge" for
 * each input that resolves to a concrete upstream output. The result is
 * the single source of truth for the various "is this output consumed,
 * and by whom?" questions the boundary collectors need to answer.
 */
function collectConsumerEdges(config: RawPipelineConfig): ConsumerEdge[] {
  const edges: ConsumerEdge[] = [];
  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      const consumerQid = `${track.id}.${task.id}`;
      const report = buildUpstreamPortsReport(config, consumerQid);
      const outputByUpstream = new Map<string, Map<string, PortDef>>();
      for (const cand of report.candidates) {
        let m = outputByUpstream.get(cand.upstreamQid);
        if (!m) {
          m = new Map();
          outputByUpstream.set(cand.upstreamQid, m);
        }
        m.set(cand.port.name, cand.port);
      }
      const inputs = inputBindingsToPorts(task.inputs);
      for (const input of inputs) {
        const match = resolveUpstreamForInput(input, outputByUpstream);
        if (!match) continue;
        edges.push({
          producerQid: match.upstreamQid,
          portName: match.port.name,
          consumerTrackId: track.id,
        });
      }
    }
  }
  return edges;
}

function bindingToPortDef(name: string, binding: TaskInputBinding): PortDef {
  return {
    name,
    type: binding.type ?? 'json',
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.required !== undefined ? { required: binding.required } : {}),
    ...(binding.default !== undefined ? { default: binding.default } : {}),
    ...(binding.enum ? { enum: [...binding.enum] } : {}),
    ...(binding.from ? { from: binding.from } : {}),
  };
}

function rowFor(track: RawTrackConfig, task: RawTaskConfig, port: PortDef): PortIORow {
  return {
    trackId: track.id,
    trackName: track.name,
    taskId: task.id,
    ...(task.name !== undefined ? { taskName: task.name } : {}),
    qid: `${track.id}.${task.id}`,
    port,
  };
}

/**
 * Inputs the pipeline as a whole expects from outside any task. An input
 * with a literal `value` is hardcoded and excluded; one whose `from` does
 * not resolve (or which has no `from` and no upstream produces a matching
 * name) counts as a pipeline-boundary input.
 */
export function collectPipelineInputs(config: RawPipelineConfig): PortIORow[] {
  const rows: PortIORow[] = [];
  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id || !task.inputs) continue;
      const report = buildUpstreamPortsReport(config, `${track.id}.${task.id}`);
      const unmatched = new Set(report.unmatched.map((p) => p.name));
      for (const [name, binding] of Object.entries(task.inputs)) {
        if (binding.value !== undefined) continue;
        if (!unmatched.has(name)) continue;
        rows.push(rowFor(track, task, bindingToPortDef(name, binding)));
      }
    }
  }
  return rows;
}

/**
 * Outputs the pipeline as a whole produces — i.e. outputs that no task
 * inside the pipeline consumes.
 */
export function collectPipelineOutputs(config: RawPipelineConfig): PortIORow[] {
  const consumed = new Set<string>();
  for (const edge of collectConsumerEdges(config)) {
    consumed.add(`${edge.producerQid}::${edge.portName}`);
  }
  const rows: PortIORow[] = [];
  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      const qid = `${track.id}.${task.id}`;
      for (const port of outputBindingsToPorts(task.outputs)) {
        if (consumed.has(`${qid}::${port.name}`)) continue;
        rows.push(rowFor(track, task, port));
      }
    }
  }
  return rows;
}

/**
 * Inputs of tasks in `trackId` that the track does NOT satisfy on its
 * own — they must arrive from another track or from outside the run.
 * Literal `value` bindings are excluded; an input whose upstream match
 * lives in the same track is considered "internal" and hidden.
 */
export function collectTrackInputs(config: RawPipelineConfig, trackId: string): PortIORow[] {
  const target = config.tracks.find((t) => t.id === trackId);
  if (!target) return [];
  const rows: PortIORow[] = [];
  for (const task of target.tasks ?? []) {
    if (!task.id || !task.inputs) continue;
    const report = buildUpstreamPortsReport(config, `${trackId}.${task.id}`);
    const outputByUpstream = new Map<string, Map<string, PortDef>>();
    for (const cand of report.candidates) {
      let m = outputByUpstream.get(cand.upstreamQid);
      if (!m) {
        m = new Map();
        outputByUpstream.set(cand.upstreamQid, m);
      }
      m.set(cand.port.name, cand.port);
    }
    for (const [name, binding] of Object.entries(task.inputs)) {
      if (binding.value !== undefined) continue;
      const port = bindingToPortDef(name, binding);
      const match = resolveUpstreamForInput(port, outputByUpstream);
      if (match) {
        // Same-track upstream means the input is fully resolved internally.
        const matchTrackId = match.upstreamQid.slice(0, match.upstreamQid.indexOf('.'));
        if (matchTrackId === trackId) continue;
      }
      rows.push(rowFor(target, task, port));
    }
  }
  return rows;
}

/**
 * Outputs of tasks in `trackId` that escape the track — i.e. consumed by
 * a task in some other track, or unconsumed by anyone (still "exposed at
 * the track boundary" in the sense that nothing inside this track ate
 * them). Outputs consumed only by same-track tasks are hidden.
 */
export function collectTrackOutputs(config: RawPipelineConfig, trackId: string): PortIORow[] {
  const target = config.tracks.find((t) => t.id === trackId);
  if (!target) return [];
  const consumerTracks = new Map<string, Set<string>>(); // "producerQid::portName" → consumer trackIds
  for (const edge of collectConsumerEdges(config)) {
    const key = `${edge.producerQid}::${edge.portName}`;
    let set = consumerTracks.get(key);
    if (!set) {
      set = new Set();
      consumerTracks.set(key, set);
    }
    set.add(edge.consumerTrackId);
  }
  const rows: PortIORow[] = [];
  for (const task of target.tasks ?? []) {
    if (!task.id) continue;
    const qid = `${trackId}.${task.id}`;
    for (const port of outputBindingsToPorts(task.outputs)) {
      const set = consumerTracks.get(`${qid}::${port.name}`);
      if (set) {
        const allInternal = [...set].every((t) => t === trackId);
        if (allInternal) continue;
      }
      rows.push(rowFor(target, task, port));
    }
  }
  return rows;
}

export function computeSyncedOutputs(
  existing: readonly PortDef[] | undefined,
  candidates: readonly DownstreamInputCandidate[],
): PortDef[] | undefined {
  const existingByName = new Map<string, PortDef>((existing ?? []).map((p) => [p.name, p]));
  if (candidates.length === 0) {
    return existing && existing.length > 0 ? [...existing] : undefined;
  }

  const firstByName = new Map<string, PortDef>();
  for (const cand of candidates) {
    if (!firstByName.has(cand.port.name)) firstByName.set(cand.port.name, cand.port);
  }

  const nextByName = new Map<string, PortDef>(existingByName);
  for (const [name, port] of firstByName) {
    if (nextByName.has(name)) continue; // preserve existing output authoring
    const copied: PortDef = {
      name,
      type: port.type as PortType,
      ...(port.description ? { description: port.description } : {}),
      ...(port.enum ? { enum: [...port.enum] } : {}),
    };
    nextByName.set(name, copied);
  }

  const result = [...nextByName.values()];
  return result.length > 0 ? result : undefined;
}
