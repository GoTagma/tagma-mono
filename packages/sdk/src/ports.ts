// ═══ Task ports: substitute / resolve / extract ═══
//
// One module, three concerns, all keyed on `task.ports`:
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
// Everything here is pure / deterministic so it can be reused by the CLI,
// the editor (for preview/simulation), and the engine without side effects.

import type { PortDef, TaskConfig, TaskPorts } from './types';

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
