// ═══ Task ports: substitute / resolve / extract / infer ═══
//
// One module, four concerns, all keyed on `task.ports`:
//
//   1. `substituteInputs(text, inputs)` — expand `{{inputs.<name>}}` in
//      user-authored strings (command lines, prompts). Strict syntax, no
//      arbitrary expressions — the placeholder is a thin pasteboard, not
//      a templating engine. Unknown / undefined references render as empty
//      string with a diagnostic that the caller can surface.
//
//   2. `resolveTaskInputs(task, upstreamOutputs, dependsOn)` — gather the
//      values a task will consume from its direct upstreams. Matches by
//      port name (or by explicit `from:`), applies defaults, coerces to
//      the declared type, and classifies the result as ready / missing
//      required / ambiguous. The engine calls this before a task starts
//      and uses the classification to decide whether to block.
//
//   3. `extractTaskOutputs(ports, stdout, normalizedOutput)` — after a
//      task succeeds, pull the declared output values from the task's
//      output stream. Default strategy: find the last non-empty line that
//      parses as a JSON object, and read each declared output name from
//      it. Prefer `normalizedOutput` for AI tasks, fall back to raw
//      stdout — command tasks only ever have stdout.
//
//   4. `inferPromptPorts({upstreams, downstreams})` — Prompt Tasks do NOT
//      declare ports; their I/O contract is inferred from direct-neighbor
//      Command Tasks. This helper synthesizes a `TaskPorts` object the
//      engine can feed into the three concerns above, and surfaces any
//      collisions that block the task (same port name on two upstreams,
//      incompatible types across downstreams, …). Prompt neighbors
//      contribute zero structured I/O — they pass free text via
//      `continue_from` / normalizedOutput instead.
//
// Everything here is pure / deterministic so it can be reused by the CLI,
// the editor (for preview/simulation), and the engine without side effects.

import type {
  PortDef,
  PortType,
  TaskConfig,
  TaskOutputBindings,
  TaskPorts,
} from './types';

// ─── Template substitution ────────────────────────────────────────────

/**
 * Matches `{{inputs.<identifier>}}` with optional whitespace inside the
 * braces. The identifier is restricted to the same character set we use
 * for task IDs (letter/underscore, then letters/digits/underscores) so
 * accidental use of `{{inputs.foo.bar}}` fails loudly rather than
 * silently producing garbage.
 */
const PLACEHOLDER_RE = /\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Scan `text` for every `{{inputs.<name>}}` placeholder and return the
 * set of referenced input names. Useful at validation time: the editor
 * can cross-check that each placeholder has a corresponding declared
 * port and flag typos before a run ever starts.
 */
export function extractInputReferences(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    names.add(match[1]!);
  }
  return [...names];
}

export interface SubstituteResult {
  readonly text: string;
  /** Port names that appeared in placeholders but weren't in `inputs`. */
  readonly unresolved: readonly string[];
}

/**
 * Replace `{{inputs.<name>}}` placeholders in `text` with values from
 * `inputs`. Coercion:
 *   - string  → as-is
 *   - number / boolean → `String(value)`
 *   - null / undefined → empty string (name is also reported as unresolved)
 *   - anything else (object, array, json port) → `JSON.stringify(value)`
 *
 * Values are substituted *verbatim* — quoting is the user's
 * responsibility in the authored text. For command lines that interpolate
 * user-provided strings, authors should wrap the placeholder in quotes:
 *
 *     weather.sh --city "{{inputs.city}}"
 *
 * That's a documented contract rather than a silent shell-escape, because
 * silent escaping would hide the difference between `--city Shanghai` and
 * `--flag $(echo pwned)` — both valid command fragments, one a bug, one a
 * feature. Users know which they want; the engine doesn't.
 */
export function substituteInputs(
  text: string,
  inputs: Readonly<Record<string, unknown>>,
): SubstituteResult {
  const unresolved = new Set<string>();
  const out = text.replace(PLACEHOLDER_RE, (_full, name: string) => {
    if (!(name in inputs)) {
      unresolved.add(name);
      return '';
    }
    const value = inputs[name];
    if (value === null || value === undefined) {
      unresolved.add(name);
      return '';
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      // Circular / unserializable — render a placeholder rather than
      // throwing, and mark it unresolved so the caller can warn.
      unresolved.add(name);
      return '';
    }
  });
  return { text: out, unresolved: [...unresolved] };
}

// ─── Input resolution ─────────────────────────────────────────────────

export type InputResolution =
  | {
      readonly kind: 'ready';
      readonly inputs: Readonly<Record<string, unknown>>;
      /**
       * Optional inputs that had no upstream producer and no default;
       * they are absent from `inputs` (so placeholders render empty).
       * Separate from `missingRequired` so the engine can log softly
       * without blocking the task.
       */
      readonly missingOptional: readonly string[];
    }
  | {
      readonly kind: 'blocked';
      /** Required port names that could not be satisfied. */
      readonly missingRequired: readonly string[];
      /** Port names with multiple ambiguous producers. */
      readonly ambiguous: readonly { port: string; producers: readonly string[] }[];
      /** Port names whose resolved value failed type coercion. */
      readonly typeErrors: readonly { port: string; reason: string }[];
      /** Human-readable multi-line description for the engine to log. */
      readonly reason: string;
    };

/**
 * Resolve the input values for `task` from the outputs its direct
 * upstreams produced.
 *
 * `upstreamOutputs` is keyed by fully-qualified task id and maps to the
 * outputs that task published (its `TaskResult.outputs`). `dependsOn` is
 * the already-qualified dependency list (from `DagNode.dependsOn`). When
 * an upstream has no outputs entry (e.g. it didn't declare any or it
 * failed), its entry may be missing — we just skip it during matching.
 *
 * Matching rules:
 *   - If the input port has `from: "taskId.portName"` → look up that
 *     specific upstream / port. Missing = unsatisfied.
 *   - If it has `from: "portName"` (bare) → treat as explicit port name
 *     but allow any upstream to provide it (useful when the user wants
 *     to match by name but still be explicit about the intent).
 *   - If no `from` → scan every upstream's outputs for a key matching
 *     the input name. Zero hits = unsatisfied; 2+ hits across different
 *     upstreams = ambiguous.
 *
 * The function never throws on config errors — every failure mode maps
 * to a field of the `blocked` result so the engine can log a unified
 * message and mark the task blocked.
 */
export function resolveTaskInputs(
  task: TaskConfig,
  upstreamOutputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  dependsOn: readonly string[],
): InputResolution {
  const inputsDecl = task.ports?.inputs;
  if (!inputsDecl || inputsDecl.length === 0) {
    return { kind: 'ready', inputs: {}, missingOptional: [] };
  }

  const inputs: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const ambiguous: { port: string; producers: string[] }[] = [];
  const typeErrors: { port: string; reason: string }[] = [];

  for (const port of inputsDecl) {
    const found = findUpstreamValue(port, upstreamOutputs, dependsOn);
    if (found.kind === 'ambiguous') {
      ambiguous.push({ port: port.name, producers: found.producers });
      continue;
    }
    let value: unknown;
    let present = false;
    if (found.kind === 'hit') {
      value = found.value;
      present = true;
    } else if (port.default !== undefined) {
      value = port.default;
      present = true;
    }

    if (!present) {
      if (port.required === true) {
        missingRequired.push(port.name);
      } else {
        missingOptional.push(port.name);
      }
      continue;
    }

    const coerced = coerceValue(port, value);
    if (coerced.kind === 'error') {
      typeErrors.push({ port: port.name, reason: coerced.reason });
      continue;
    }
    inputs[port.name] = coerced.value;
  }

  if (missingRequired.length > 0 || ambiguous.length > 0 || typeErrors.length > 0) {
    const lines: string[] = [];
    if (missingRequired.length > 0) {
      lines.push(`missing required input(s): ${missingRequired.join(', ')}`);
    }
    if (ambiguous.length > 0) {
      for (const amb of ambiguous) {
        lines.push(
          `input "${amb.port}" is produced by multiple upstreams ` +
            `(${amb.producers.join(', ')}) — disambiguate with "from: taskId.${amb.port}"`,
        );
      }
    }
    if (typeErrors.length > 0) {
      for (const te of typeErrors) {
        lines.push(`input "${te.port}": ${te.reason}`);
      }
    }
    return {
      kind: 'blocked',
      missingRequired,
      ambiguous,
      typeErrors,
      reason: lines.join('\n'),
    };
  }

  return { kind: 'ready', inputs, missingOptional };
}

// ─── Lightweight binding resolution ──────────────────────────────────

export interface UpstreamBindingData {
  readonly outputs?: Readonly<Record<string, unknown>> | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly normalizedOutput?: string | null;
  readonly exitCode?: number | null;
}

export type BindingInputResolution =
  | {
      readonly kind: 'ready';
      readonly inputs: Readonly<Record<string, unknown>>;
      readonly missingOptional: readonly string[];
    }
  | {
      readonly kind: 'blocked';
      readonly missingRequired: readonly string[];
      readonly ambiguous: readonly { input: string; producers: readonly string[] }[];
      readonly typeErrors: readonly { input: string; reason: string }[];
      readonly reason: string;
    };

export function resolveTaskBindingInputs(
  task: Pick<TaskConfig, 'inputs'>,
  upstreamData: ReadonlyMap<string, UpstreamBindingData>,
  dependsOn: readonly string[],
): BindingInputResolution {
  const bindings = task.inputs;
  if (!bindings || Object.keys(bindings).length === 0) {
    return { kind: 'ready', inputs: {}, missingOptional: [] };
  }

  const inputs: Record<string, unknown> = {};
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const ambiguous: { input: string; producers: string[] }[] = [];
  const typeErrors: { input: string; reason: string }[] = [];

  for (const [name, binding] of Object.entries(bindings)) {
    let value: unknown;
    let present = false;

    if ('value' in binding) {
      value = binding.value;
      present = true;
    } else if (binding.from) {
      const found = resolveBindingSource(binding.from, upstreamData, dependsOn);
      if (found.kind === 'ambiguous') {
        ambiguous.push({ input: name, producers: found.producers });
        continue;
      }
      if (found.kind === 'hit') {
        value = found.value;
        present = true;
      }
    }

    if (!present && 'default' in binding) {
      value = binding.default;
      present = true;
    }

    if (!present || value === undefined || value === null) {
      if (binding.required === true) {
        missingRequired.push(name);
      } else {
        missingOptional.push(name);
      }
      continue;
    }

    const coerced = coerceBindingValue(binding, value);
    if (coerced.kind === 'error') {
      typeErrors.push({ input: name, reason: coerced.reason });
      continue;
    }

    inputs[name] = coerced.value;
  }

  if (missingRequired.length > 0 || ambiguous.length > 0 || typeErrors.length > 0) {
    const lines: string[] = [];
    if (missingRequired.length > 0) {
      lines.push(`missing required binding input(s): ${missingRequired.join(', ')}`);
    }
    for (const amb of ambiguous) {
      lines.push(
        `binding input "${amb.input}" is produced by multiple upstreams ` +
          `(${amb.producers.join(', ')}) — use "taskId.outputs.${amb.input}"`,
      );
    }
    for (const te of typeErrors) {
      lines.push(`binding input "${te.input}": ${te.reason}`);
    }
    return { kind: 'blocked', missingRequired, ambiguous, typeErrors, reason: lines.join('\n') };
  }

  return { kind: 'ready', inputs, missingOptional };
}

type BindingLookup =
  | { kind: 'hit'; producer: string; value: unknown }
  | { kind: 'miss' }
  | { kind: 'ambiguous'; producers: string[] };

function resolveBindingSource(
  source: string,
  upstreamData: ReadonlyMap<string, UpstreamBindingData>,
  dependsOn: readonly string[],
): BindingLookup {
  if (source.startsWith('outputs.')) {
    return findOutputByName(source.slice('outputs.'.length), upstreamData, dependsOn);
  }

  const outputMarker = '.outputs.';
  const outputIdx = source.lastIndexOf(outputMarker);
  if (outputIdx > 0) {
    const upstreamId = source.slice(0, outputIdx);
    const outputName = source.slice(outputIdx + outputMarker.length);
    if (!dependsOn.includes(upstreamId)) return { kind: 'miss' };
    const upstream = upstreamData.get(upstreamId);
    if (upstream?.outputs && outputName in upstream.outputs) {
      return { kind: 'hit', producer: upstreamId, value: upstream.outputs[outputName] };
    }
    return { kind: 'miss' };
  }

  for (const field of ['stdout', 'stderr', 'normalizedOutput', 'exitCode'] as const) {
    const suffix = `.${field}`;
    if (!source.endsWith(suffix)) continue;
    const upstreamId = source.slice(0, -suffix.length);
    if (!dependsOn.includes(upstreamId)) return { kind: 'miss' };
    const upstream = upstreamData.get(upstreamId);
    if (!upstream) return { kind: 'miss' };
    const value = upstream[field];
    return value === undefined || value === null
      ? { kind: 'miss' }
      : { kind: 'hit', producer: upstreamId, value };
  }

  return { kind: 'miss' };
}

function findOutputByName(
  name: string,
  upstreamData: ReadonlyMap<string, UpstreamBindingData>,
  dependsOn: readonly string[],
): BindingLookup {
  const hits: { producer: string; value: unknown }[] = [];
  for (const upstreamId of dependsOn) {
    const upstream = upstreamData.get(upstreamId);
    if (upstream?.outputs && name in upstream.outputs) {
      hits.push({ producer: upstreamId, value: upstream.outputs[name] });
    }
  }
  if (hits.length === 0) return { kind: 'miss' };
  if (hits.length === 1) return { kind: 'hit', producer: hits[0]!.producer, value: hits[0]!.value };
  return { kind: 'ambiguous', producers: hits.map((h) => h.producer) };
}

type UpstreamLookup =
  | { kind: 'hit'; producer: string; value: unknown }
  | { kind: 'miss' }
  | { kind: 'ambiguous'; producers: string[] };

function findUpstreamValue(
  port: PortDef,
  upstreamOutputs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  dependsOn: readonly string[],
): UpstreamLookup {
  // Explicit fully-qualified binding: "taskId.portName"
  if (port.from && port.from.includes('.')) {
    const dot = port.from.lastIndexOf('.');
    const upstreamId = port.from.slice(0, dot);
    const portName = port.from.slice(dot + 1);
    const upstream = upstreamOutputs.get(upstreamId);
    if (upstream && portName in upstream) {
      return { kind: 'hit', producer: upstreamId, value: upstream[portName] };
    }
    return { kind: 'miss' };
  }

  // Name match (either explicit `from: "portName"` or defaulted to port.name)
  const key = port.from ?? port.name;
  const hits: { producer: string; value: unknown }[] = [];
  for (const upstreamId of dependsOn) {
    const upstream = upstreamOutputs.get(upstreamId);
    if (upstream && key in upstream) {
      hits.push({ producer: upstreamId, value: upstream[key] });
    }
  }
  if (hits.length === 0) return { kind: 'miss' };
  if (hits.length === 1) return { kind: 'hit', producer: hits[0]!.producer, value: hits[0]!.value };
  return { kind: 'ambiguous', producers: hits.map((h) => h.producer) };
}

// ─── Type coercion ────────────────────────────────────────────────────

type Coercion = { kind: 'ok'; value: unknown } | { kind: 'error'; reason: string };

function coerceValue(port: PortDef, raw: unknown): Coercion {
  switch (port.type) {
    case 'string': {
      if (typeof raw === 'string') return { kind: 'ok', value: raw };
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { kind: 'ok', value: String(raw) };
      }
      return { kind: 'error', reason: `expected string, got ${describe(raw)}` };
    }
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return { kind: 'ok', value: raw };
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return { kind: 'ok', value: n };
      }
      return { kind: 'error', reason: `expected number, got ${describe(raw)}` };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { kind: 'ok', value: raw };
      if (raw === 'true' || raw === 'false') return { kind: 'ok', value: raw === 'true' };
      return { kind: 'error', reason: `expected boolean, got ${describe(raw)}` };
    }
    case 'enum': {
      const allowed = port.enum ?? [];
      if (allowed.length === 0) {
        return { kind: 'error', reason: 'enum port declared without "enum" values' };
      }
      const asStr = typeof raw === 'string' ? raw : String(raw);
      if (!allowed.includes(asStr)) {
        return {
          kind: 'error',
          reason: `value ${JSON.stringify(raw)} not in enum [${allowed.map((v) => JSON.stringify(v)).join(', ')}]`,
        };
      }
      return { kind: 'ok', value: asStr };
    }
    case 'json':
      // 'json' accepts anything that survives JSON round-trip. We don't
      // validate deeply — users opt into `json` precisely because they
      // want a free-form payload.
      return { kind: 'ok', value: raw };
    default: {
      // Exhaustiveness — TypeScript won't let us reach here unless a
      // new PortType is added without updating this switch. The return
      // satisfies the type checker; in practice the default branch is
      // dead code.
      const _exhaustive: never = port.type;
      void _exhaustive;
      return { kind: 'error', reason: `unknown port type "${String(port.type)}"` };
    }
  }
}

function coerceBindingValue(
  binding: { readonly type?: PortType; readonly enum?: readonly string[] },
  raw: unknown,
): Coercion {
  if (!binding.type) return { kind: 'ok', value: raw };
  return coerceValue(
    {
      name: 'binding',
      type: binding.type,
      ...(binding.enum ? { enum: binding.enum } : {}),
    },
    raw,
  );
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ─── Output extraction ────────────────────────────────────────────────

export interface ExtractResult {
  /** Coerced values keyed by port name. Ports that failed to resolve are absent. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /**
   * Human-readable diagnostic describing what went wrong, if anything.
   * `null` when every declared output was resolved cleanly. The engine
   * appends this to stderr so the pipeline log explains why downstream
   * inputs are missing.
   */
  readonly diagnostic: string | null;
}

/**
 * Extract declared outputs from a terminated task's output streams.
 *
 * Strategy (v1 — intentionally dumb but predictable):
 *   1. Prefer `normalizedOutput` when provided (AI drivers populate this
 *      with the canonical assistant message; it's much cleaner than raw
 *      stdout, which often has JSONL event dumps). Fall back to stdout
 *      otherwise.
 *   2. Scan from the end for the first non-empty line. If it parses as a
 *      JSON object, use that as the source record.
 *   3. If (2) fails, try parsing the entire source as JSON (supports
 *      commands that pretty-print with line breaks).
 *   4. For each declared output port, read the matching key and coerce
 *      to the declared type. Coercion failures produce a diagnostic and
 *      the port is absent from `outputs` (treated as missing downstream).
 *
 * When no declared outputs are present this returns an empty `outputs`
 * map and null diagnostic — the engine interprets that as "task has no
 * port contract".
 */
export function extractTaskOutputs(
  ports: TaskPorts | undefined,
  stdout: string,
  normalizedOutput: string | null,
): ExtractResult {
  const decl = ports?.outputs;
  if (!decl || decl.length === 0) {
    return { outputs: {}, diagnostic: null };
  }

  const source = (normalizedOutput ?? '').length > 0 ? normalizedOutput! : stdout;
  const record = parseJsonTail(source);
  if (record === null) {
    return {
      outputs: {},
      diagnostic:
        'outputs: could not find a final-line JSON object in task output — declared outputs are unresolved',
    };
  }

  const outputs: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const port of decl) {
    if (!(port.name in record)) {
      warnings.push(`missing key "${port.name}"`);
      continue;
    }
    const coerced = coerceValue(port, record[port.name]);
    if (coerced.kind === 'error') {
      warnings.push(`"${port.name}": ${coerced.reason}`);
      continue;
    }
    outputs[port.name] = coerced.value;
  }

  const diagnostic = warnings.length > 0 ? `outputs: ${warnings.join('; ')}` : null;
  return { outputs, diagnostic };
}

export function extractTaskBindingOutputs(
  bindings: TaskOutputBindings | undefined,
  stdout: string,
  stderr: string,
  normalizedOutput: string | null,
): ExtractResult {
  if (!bindings || Object.keys(bindings).length === 0) {
    return { outputs: {}, diagnostic: null };
  }

  const outputs: Record<string, unknown> = {};
  const missing: string[] = [];
  let record: Record<string, unknown> | null | undefined;

  for (const [name, binding] of Object.entries(bindings)) {
    let value: unknown;
    let present = false;

    if ('value' in binding) {
      value = binding.value;
      present = true;
    } else {
      const source = binding.from ?? `json.${name}`;
      if (source === 'stdout') {
        value = stdout;
        present = true;
      } else if (source === 'stderr') {
        value = stderr;
        present = true;
      } else if (source === 'normalizedOutput') {
        if (normalizedOutput !== null) {
          value = normalizedOutput;
          present = true;
        }
      } else if (source.startsWith('json.')) {
        if (record === undefined) {
          const jsonSource = (normalizedOutput ?? '').length > 0 ? normalizedOutput! : stdout;
          record = parseJsonTail(jsonSource);
        }
        const key = source.slice('json.'.length);
        if (record && key in record) {
          value = record[key];
          present = true;
        }
      }
    }

    if (!present && 'default' in binding) {
      value = binding.default;
      present = true;
    }

    if (!present || value === undefined || value === null) {
      missing.push(name);
      continue;
    }

    const coerced = coerceBindingValue(binding, value);
    if (coerced.kind === 'error') {
      missing.push(`"${name}": ${coerced.reason}`);
      continue;
    }

    outputs[name] = coerced.value;
  }

  return {
    outputs,
    diagnostic: missing.length > 0 ? `outputs: unresolved binding output(s): ${missing.join(', ')}` : null,
  };
}

/**
 * Find the last non-empty line that parses as a JSON object. Returns
 * null when no such line exists. Also tries the whole source as a
 * fallback — covers pretty-printed JSON that spans multiple lines.
 */
function parseJsonTail(source: string): Record<string, unknown> | null {
  const lines = source.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const parsed = safeParseJson(line);
    if (parsed !== null) return parsed;
    // First non-empty line from the tail — if it didn't parse, fall through
    // to the whole-source attempt below rather than scanning further up
    // (otherwise a prior human-readable line would be silently picked up
    // if it happened to contain `{...}` fragments).
    break;
  }
  return safeParseJson(source.trim());
}

function safeParseJson(candidate: string): Record<string, unknown> | null {
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

// ─── Prompt-task port inference ───────────────────────────────────────
//
// Prompt Tasks have no declared ports. The engine calls `inferPromptPorts`
// to synthesize one from the Task's direct DAG neighbors:
//
//   - **inputs** are taken from the declared `outputs` of every direct
//     upstream Command Task. The union of names becomes the Prompt's
//     inferred inputs. Upstream Prompt neighbors contribute nothing —
//     information flows between Prompts as free text through
//     `continue_from` / normalizedOutput, not through port values.
//
//   - **outputs** are taken from the declared `inputs` of every direct
//     downstream Command Task. The union of names becomes the Prompt's
//     inferred outputs, which drives the `[Output Format]` block that
//     tells the LLM what JSON to emit. Downstream Prompt neighbors
//     contribute nothing (they just consume free text).
//
// Collisions:
//
//   - **Input collision**: two upstream Commands both export an output
//     named `city`. Command→Command would let a downstream add
//     `from: taskId.city` to pick one; Prompt Tasks have no port
//     declarations and therefore no escape hatch. The only fix is to
//     rename on the Command side. We surface this as an `inputConflicts`
//     entry; the engine blocks the task with that reason.
//
  //   - **Output collision with compatible types** (e.g. both downstreams
  //     ask for `date: string`) → merged into a single inferred output.
  //     Compatibility is determined by `type` and `enum` only; `description`
  //     differences are ignored. The Prompt produces one `date`; both
  //     downstreams consume it.
//
//   - **Output collision with incompatible types** (e.g. one downstream
//     wants `date: string`, another `date: number`) → no single LLM
//     emission can satisfy both. Surfaced as `outputConflicts`; engine
//     blocks the task. User must rename on one side.

export interface PromptUpstreamNeighbor {
  readonly taskId: string;
  /**
   * Declared outputs of the upstream task. `undefined` signals that the
   * neighbor is a Prompt Task (no structured contribution) or otherwise
   * has no outputs to offer. The inference logic treats `undefined` and
   * an empty array the same way — neither contributes ports.
   */
  readonly outputs: readonly PortDef[] | undefined;
}

export interface PromptDownstreamNeighbor {
  readonly taskId: string;
  /**
   * Declared inputs of the downstream task. `undefined` signals a
   * Prompt-Task neighbor or a Command Task without declared inputs.
   * Either way it contributes no ports to the inferred output contract.
   */
  readonly inputs: readonly PortDef[] | undefined;
}

export interface PromptPortConflict {
  readonly portName: string;
  readonly producers: readonly { readonly taskId: string; readonly type: PortType }[];
  /** Pre-formatted human-readable reason for logs / stderr. */
  readonly reason: string;
}

export interface PromptPortInference {
  /**
   * Synthetic `TaskPorts` the engine feeds into the resolve / substitute /
   * render / extract helpers, exactly as if the Prompt had declared these
   * ports itself. Empty arrays are preserved as absent so downstream code
   * paths treat "no ports" uniformly (see engine.ts's existing
   * `task.ports?.outputs && task.ports.outputs.length > 0` guard).
   */
  readonly ports: TaskPorts;
  readonly inputConflicts: readonly PromptPortConflict[];
  readonly outputConflicts: readonly PromptPortConflict[];
}

/**
 * Derive the effective `TaskPorts` for a Prompt Task from its direct
 * neighbors. See the module-level "Prompt-task port inference" comment
 * for the full contract.
 *
 * Pure function — no side effects, safe to call from the CLI, editor
 * preview, and engine hot path alike.
 */
export function inferPromptPorts(input: {
  readonly upstreams: readonly PromptUpstreamNeighbor[];
  readonly downstreams: readonly PromptDownstreamNeighbor[];
}): PromptPortInference {
  const { upstreams, downstreams } = input;

  // ─── Inputs: union of upstream-Command outputs ─────────────────────
  //
  // Walk every upstream in DAG order. First occurrence of a name wins
  // (for the synthesized port shape used to resolve values). Subsequent
  // occurrences under the same name become an `inputConflicts` entry —
  // the engine blocks the task because a Prompt can't disambiguate.
  const inputsByName = new Map<string, { port: PortDef; firstProducer: string }>();
  const inputCollisionSources = new Map<string, { taskId: string; type: PortType }[]>();

  for (const upstream of upstreams) {
    if (!upstream.outputs || upstream.outputs.length === 0) continue;
    for (const out of upstream.outputs) {
      const prior = inputsByName.get(out.name);
      if (!prior) {
        // Copy the shape verbatim but drop output-only fields and force
        // `required: true`. Prompt-task inferred inputs are required by
        // default: the LLM wouldn't be getting a real-world value
        // otherwise, and substituting an empty string silently is the
        // same kind of bug we already reject elsewhere.
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
      // Collision — seed the source list with the first producer too so
      // the emitted conflict lists *all* contributing producers.
      const list = inputCollisionSources.get(out.name) ?? [
        { taskId: prior.firstProducer, type: prior.port.type },
      ];
      list.push({ taskId: upstream.taskId, type: out.type });
      inputCollisionSources.set(out.name, list);
    }
  }

  const inputConflicts: PromptPortConflict[] = [];
  for (const [portName, producers] of inputCollisionSources) {
    const producerList = producers.map((p) => p.taskId).join(', ');
    inputConflicts.push({
      portName,
      producers,
      reason:
        `input "${portName}" is produced by multiple upstream Commands (${producerList}) — ` +
        `Prompt tasks cannot disambiguate (no explicit "from:" binding). ` +
        `Rename the output on one of the upstream Commands.`,
    });
  }

  // ─── Outputs: union of downstream-Command inputs ───────────────────
  //
  // Compatible repeats merge (preserve first-encountered shape; prefer
  // required when any downstream requires it). Incompatible repeats
  // (different type, different enum set) go to `outputConflicts`.
  const outputsByName = new Map<string, { port: PortDef; firstConsumer: string }>();
  const outputCollisionSources = new Map<string, { taskId: string; type: PortType }[]>();

  for (const downstream of downstreams) {
    if (!downstream.inputs || downstream.inputs.length === 0) continue;
    for (const inp of downstream.inputs) {
      const prior = outputsByName.get(inp.name);
      if (!prior) {
        // Outputs drop input-only fields (required, default, from).
        outputsByName.set(inp.name, {
          port: {
            name: inp.name,
            type: inp.type,
            ...(inp.description ? { description: inp.description } : {}),
            ...(inp.enum ? { enum: [...inp.enum] } : {}),
          },
          firstConsumer: downstream.taskId,
        });
        continue;
      }
      if (portsAreCompatible(prior.port, inp)) continue; // merge silently
      const list = outputCollisionSources.get(inp.name) ?? [
        { taskId: prior.firstConsumer, type: prior.port.type },
      ];
      list.push({ taskId: downstream.taskId, type: inp.type });
      outputCollisionSources.set(inp.name, list);
    }
  }

  const outputConflicts: PromptPortConflict[] = [];
  for (const [portName, producers] of outputCollisionSources) {
    const consumerList = producers.map((p) => `${p.taskId} (${p.type})`).join(', ');
    outputConflicts.push({
      portName,
      producers,
      reason:
        `output "${portName}" has conflicting type requirements across downstream Commands ` +
        `(${consumerList}) — a single LLM emission cannot satisfy both. ` +
        `Rename the input on one of the downstream Commands.`,
    });
  }

  const inferredInputs = [...inputsByName.values()].map((e) => e.port);
  const inferredOutputs = [...outputsByName.values()].map((e) => e.port);

  const ports: TaskPorts = {
    ...(inferredInputs.length > 0 ? { inputs: inferredInputs } : {}),
    ...(inferredOutputs.length > 0 ? { outputs: inferredOutputs } : {}),
  };
  return { ports, inputConflicts, outputConflicts };
}

/**
 * Two ports with the same name are compatible if they agree on `type`
 * and, for enum ports, on the enum value set. Descriptions and
 * required/default flags are deliberately ignored — they don't affect
 * whether a single value can satisfy both consumers.
 */
function portsAreCompatible(a: PortDef, b: PortDef): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'enum') {
    const aEnum = [...(a.enum ?? [])].sort().join(' ');
    const bEnum = [...(b.enum ?? [])].sort().join(' ');
    if (aEnum !== bEnum) return false;
  }
  return true;
}
