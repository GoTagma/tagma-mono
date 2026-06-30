/**
 * Display-only JSON prettification for the run panel.
 *
 * These helpers are pure and React-free on purpose: the panel renders a
 * *view* derived from a task's raw output string and never mutates the
 * stored bytes, the `continue_from` handoff, or published port values.
 * `highlightJson` returns data tokens (not React nodes) so the whole module
 * stays unit-testable without a DOM and the component layer owns markup.
 */

/**
 * Char-count ceiling above which we skip parse+highlight entirely. Measured
 * in UTF-16 code units (cheap, no allocation) as a proxy for byte size —
 * exactness doesn't matter, this only exists so a multi-megabyte stdout tail
 * can't janky-freeze the panel. Raw is the only sensible view at that size.
 */
export const JSON_PRETTY_MAX_BYTES = 262_144;

export type JsonishParse =
  { kind: 'json'; value: unknown } | { kind: 'ndjson'; values: unknown[] } | { kind: 'none' };

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Classify a raw output string without mutating it:
 *  - `json`   — the whole string is one JSON document (claude-code's
 *               `{"type":"result",…}` envelope, or a model answer that is
 *               itself JSON).
 *  - `ndjson` — ≥2 newline-delimited JSON records and NOT one document
 *               (opencode's event stream). Blank lines tolerated.
 *  - `none`   — prose, truncated/invalid JSON, empty, or over the size guard.
 *               Callers fall back to the existing plain `<pre>` (no toggle),
 *               so non-JSON output is a zero-regression passthrough.
 */
export function tryParseJsonish(text: string): JsonishParse {
  if (typeof text !== 'string') return { kind: 'none' };
  if (text.length > JSON_PRETTY_MAX_BYTES) return { kind: 'none' };

  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: 'none' };

  const single = tryParse(trimmed);
  if (single.ok) return { kind: 'json', value: single.value };

  // NDJSON: every non-blank line must independently parse, and we need at
  // least two records (one bad line ⇒ `none`, not a partial stream).
  const values: unknown[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parsed = tryParse(line);
    if (!parsed.ok) return { kind: 'none' };
    values.push(parsed.value);
  }
  if (values.length >= 2) return { kind: 'ndjson', values };

  return { kind: 'none' };
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface JsonToken {
  readonly text: string;
  /** Tailwind text-color class, or `null` for structural/plain text. */
  readonly cls: string | null;
}

const CLS_KEY = 'text-tagma-accent';
const CLS_STRING = 'text-tagma-success';
const CLS_NUMBER = 'text-tagma-warning';
const CLS_LITERAL = 'text-tagma-info'; // true | false | null
const CLS_PUNCT = 'text-tagma-muted-dim';

/**
 * Tokenize a `JSON.stringify(_, null, 2)` string into colored spans.
 *
 * Operates on the already-stringified pretty text (never the raw input), so
 * structure is well-formed by construction. Invariant — the concatenation of
 * every emitted token's `text` is byte-identical to the input: nothing is
 * dropped, reordered, or rewritten, only annotated. Any unexpected failure
 * degrades to a single uncolored token rather than throwing.
 */
export function highlightJson(pretty: string): JsonToken[] {
  try {
    const tokens: JsonToken[] = [];
    let i = 0;
    const n = pretty.length;

    while (i < n) {
      const ch = pretty[i];

      // Whitespace / newlines / indentation — emit verbatim, unclassified.
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
        let j = i + 1;
        while (
          j < n &&
          (pretty[j] === ' ' || pretty[j] === '\n' || pretty[j] === '\r' || pretty[j] === '\t')
        ) {
          j++;
        }
        tokens.push({ text: pretty.slice(i, j), cls: null });
        i = j;
        continue;
      }

      // Strings — scan to the matching unescaped quote, then decide whether
      // it's an object key (next non-ws char is `:`) or a string value.
      if (ch === '"') {
        let j = i + 1;
        while (j < n) {
          const c = pretty[j];
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === '"') {
            j++;
            break;
          }
          j++;
        }
        const str = pretty.slice(i, j);
        let k = j;
        while (k < n && (pretty[k] === ' ' || pretty[k] === '\t')) k++;
        const isKey = pretty[k] === ':';
        tokens.push({ text: str, cls: isKey ? CLS_KEY : CLS_STRING });
        i = j;
        continue;
      }

      // Numbers (incl. negative / exponent / fraction).
      if (ch === '-' || (ch >= '0' && ch <= '9')) {
        let j = i + 1;
        while (j < n && /[-0-9eE+.]/.test(pretty[j])) j++;
        tokens.push({ text: pretty.slice(i, j), cls: CLS_NUMBER });
        i = j;
        continue;
      }

      // Literals.
      if (pretty.startsWith('true', i)) {
        tokens.push({ text: 'true', cls: CLS_LITERAL });
        i += 4;
        continue;
      }
      if (pretty.startsWith('false', i)) {
        tokens.push({ text: 'false', cls: CLS_LITERAL });
        i += 5;
        continue;
      }
      if (pretty.startsWith('null', i)) {
        tokens.push({ text: 'null', cls: CLS_LITERAL });
        i += 4;
        continue;
      }

      // Structural punctuation: { } [ ] , :
      tokens.push({ text: ch, cls: CLS_PUNCT });
      i++;
    }

    return tokens;
  } catch {
    return [{ text: pretty, cls: null }];
  }
}
