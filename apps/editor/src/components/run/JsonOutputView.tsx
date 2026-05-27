/**
 * Display-only formatter for a prompt/LLM task's JSON output in the run
 * panel. Given the *raw* output string it shows a pretty-printed,
 * syntax-highlighted view with a `Formatted | Raw` toggle. Nothing here
 * mutates stored task state, the `continue_from` handoff, or port values; the
 * transformation lives purely in this render path, and the Raw view is
 * byte-identical to the input.
 *
 * When the string isn't JSON (prose, truncated tail, still-streaming,
 * oversize) it renders the exact same plain `<pre>` the panel used before, so
 * non-JSON output is a zero-regression passthrough.
 */
import { Fragment, useMemo } from 'react';
import {
  tryParseJsonish,
  formatJson,
  highlightJson,
  type JsonToken,
} from '../../utils/json-pretty';
import { useJsonViewMode } from './useJsonViewMode';
import { CopyButton } from './CopyButton';

interface JsonOutputViewProps {
  /** Section heading, e.g. "Output" or "Normalized Output". */
  label: string;
  /** The original output string, rendered verbatim in Raw mode. */
  raw: string;
  /** The exact `<pre>` classes the panel used for this section (kept so the
   *  non-JSON fallback is visually identical to the prior behavior). */
  preClassName: string;
}

function Tokens({ tokens }: { tokens: JsonToken[] }) {
  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          <Fragment key={i}>{t.text}</Fragment>
        ),
      )}
    </>
  );
}

function segClass(active: boolean): string {
  return active
    ? 'px-1.5 py-0.5 bg-tagma-accent/15 text-tagma-accent'
    : 'px-1.5 py-0.5 text-tagma-muted hover:text-tagma-text transition-colors';
}

export function JsonOutputView({ label, raw, preClassName }: JsonOutputViewProps) {
  const parsed = useMemo(() => tryParseJsonish(raw), [raw]);
  const [mode, setMode] = useJsonViewMode();
  // Memoized so the O(n) format+highlight doesn't re-run on every unrelated
  // panel re-render (the run store updates the panel on each run-event while
  // a run is active). Computed before the early return so the hook is always
  // called in the same order regardless of `parsed.kind`.
  const formatted = useMemo(() => {
    if (parsed.kind === 'json') {
      return <Tokens tokens={highlightJson(formatJson(parsed.value))} />;
    }
    if (parsed.kind === 'ndjson') {
      return parsed.values.map((v, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="block my-1.5 border-t border-tagma-border/40" aria-hidden />}
          <Tokens tokens={highlightJson(formatJson(v))} />
        </Fragment>
      ));
    }
    return null;
  }, [parsed]);

  // Non-JSON: identical to the panel's previous plain rendering.
  if (parsed.kind === 'none') {
    return (
      <div>
        <label className="field-label">{label}</label>
        <pre className={preClassName}>{raw}</pre>
      </div>
    );
  }

  const showRaw = mode === 'raw';

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="field-label !mb-0">{label}</label>
        <div className="flex items-center gap-1.5">
          <div className="inline-flex border border-tagma-border text-[9px] font-mono uppercase tracking-wider">
            <button
              type="button"
              onClick={() => setMode('formatted')}
              className={segClass(!showRaw)}
            >
              Formatted
            </button>
            <button
              type="button"
              onClick={() => setMode('raw')}
              className={`border-l border-tagma-border ${segClass(showRaw)}`}
            >
              Raw
            </button>
          </div>
          <CopyButton value={raw} title={`Copy ${label}`} />
        </div>
      </div>
      <pre className={preClassName}>{showRaw ? raw : formatted}</pre>
    </div>
  );
}
