/**
 * Visual renderers for every non-text/non-tool Part the opencode SDK can emit.
 *
 * The SDK's `Part` union has 12 members. ChatPanel.tsx already renders `text`,
 * `reasoning`, and `tool` (with per-tool dispatch via ToolRenderers.tsx), and
 * filters out `step-finish` entirely (its per-step cost/token chips were
 * redundant with the cumulative AssistantMessageFooter). This file owns the
 * remaining eight — file, patch, agent, subtask, snapshot, step-start, retry,
 * compaction — plus a footer for the AssistantMessage envelope
 * (cost / tokens / finish reason) and a reusable file card used both for
 * `file` parts and for tool `attachments`.
 *
 * Visual language matches the existing chat:
 *   - mono font, 9–11 px sizes
 *   - `tagma-bg` / `tagma-surface` / `tagma-border` color tokens
 *   - tagma-ready (green), tagma-error (red), tagma-accent (yellow), tagma-muted (gray)
 *   - subtle for low-signal events (step boundaries, snapshots), high contrast
 *     for events the user actively cares about (patches, subtasks, errors)
 *
 * Renderers return `null` for the genuinely-empty case (e.g. an `agent` part
 * with no name) so callers can decide whether to skip the bubble entirely.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Camera,
  ChevronRight,
  FileBox,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Layers,
  Minimize2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type {
  AgentPart,
  AssistantMessage,
  CompactionPart,
  FilePart,
  PatchPart,
  RetryPart,
  SnapshotPart,
  StepStartPart,
  SubtaskPart,
} from '../../api/opencode-chat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortHash(s: string | undefined, n = 7): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) : s;
}

function basename(p: string): string {
  // Both forward- and back-slash safe — opencode normalizes to /, but local
  // tool output (Windows opencode invoking `dir`) can land here too.
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// FilePart — shared by inline `file` parts AND tool `attachments`. Picks an
// inline preview when the mime type is something the browser can render
// natively (image/*, application/pdf), otherwise falls back to a typed file
// card. Source citations (`file` / `symbol`) are shown as a quoted block
// underneath.
// ---------------------------------------------------------------------------

export function FilePartView({ part }: { part: FilePart }) {
  const name = part.filename ?? basename(part.url) ?? 'file';
  const mime = part.mime ?? '';
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';

  return (
    <div className="w-full flex flex-col gap-1 border border-tagma-border bg-tagma-surface/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-mono">
        {isImage ? (
          <ImageIcon size={11} className="text-tagma-accent shrink-0" />
        ) : isPdf ? (
          <FileText size={11} className="text-tagma-error/80 shrink-0" />
        ) : (
          <FileBox size={11} className="text-tagma-muted shrink-0" />
        )}
        <a
          href={part.url}
          target="_blank"
          rel="noreferrer noopener"
          className="select-text truncate text-tagma-text hover:text-tagma-accent transition-colors"
          title={part.url}
        >
          {name}
        </a>
        {mime && <span className="shrink-0 text-tagma-muted-dim text-[9px]">{mime}</span>}
      </div>
      {isImage && (
        <a href={part.url} target="_blank" rel="noreferrer noopener" className="block max-w-full">
          <img
            src={part.url}
            alt={name}
            // Cap at a sensible thumbnail size; click-through opens full-size
            // in a new tab. Object-contain keeps aspect ratio without
            // distorting tall screenshots.
            className="max-h-[280px] max-w-full w-auto h-auto object-contain border border-tagma-border bg-tagma-bg"
            loading="lazy"
          />
        </a>
      )}
      {isPdf && (
        <a
          href={part.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[10px] font-mono text-tagma-muted hover:text-tagma-text underline underline-offset-2"
        >
          Open PDF →
        </a>
      )}
      {part.source && <FileSourceQuote source={part.source} />}
    </div>
  );
}

function FileSourceQuote({ source }: { source: NonNullable<FilePart['source']> }) {
  // FilePartSource is a discriminated union of `file` (whole-file context) and
  // `symbol` (named symbol with a line range). Both carry the cited text in
  // `source.text.value` plus a path; symbols add a name + range. Render the
  // cite as a quoted code block so the user can see what the agent actually
  // saw — opencode uses these to attach selection context to user messages.
  const text = source.text?.value ?? '';
  const isSymbol = source.type === 'symbol';
  const meta = isSymbol
    ? `${source.path}#${source.name} L${source.range.start.line + 1}–${source.range.end.line + 1}`
    : source.path;
  return (
    <details className="text-[10px] font-mono">
      <summary className="cursor-pointer flex items-center gap-1 select-none text-tagma-muted/80 hover:text-tagma-text">
        <ChevronRight size={9} />
        <span className="truncate">{meta}</span>
      </summary>
      <pre className="select-text mt-1 px-2 py-1 text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-y-auto max-h-[200px] border-l border-tagma-accent/40 bg-tagma-bg">
        {text || '(empty)'}
      </pre>
    </details>
  );
}

// ---------------------------------------------------------------------------
// PatchPart — opencode emits this when a turn's tool calls produced a
// coherent patch hash spanning N files. Shows the file list with a
// short hash chip; the actual diff usually lives on the corresponding tool
// outputs (edit/write), so we don't try to re-render a diff here.
// ---------------------------------------------------------------------------

export function PatchPartView({ part }: { part: PatchPart }) {
  const files = part.files ?? [];
  if (files.length === 0) return null;
  return (
    <div className="w-full flex flex-col gap-1 border border-tagma-accent/40 bg-tagma-accent/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-tagma-text">
        <GitBranch size={11} className="text-tagma-accent shrink-0" />
        <span>Patch</span>
        <span className="text-tagma-muted-dim">·</span>
        <span className="text-tagma-muted">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span className="text-tagma-muted-dim text-[9px] ml-auto" title={part.hash}>
          {shortHash(part.hash)}
        </span>
      </div>
      <ul className="select-text space-y-px pl-4 text-[9px] font-mono text-tagma-text/85 max-h-[160px] overflow-y-auto">
        {files.map((f, i) => (
          <li key={`${f}-${i}`} className="truncate" title={f}>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentPart — appears when the assistant references an agent (e.g. typed
// `@reviewer` in chat). Just an inline chip; no body.
// ---------------------------------------------------------------------------

export function AgentPartView({ part }: { part: AgentPart }) {
  if (!part.name) return null;
  return (
    <div className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-tagma-accent/40 bg-tagma-accent/10 text-[10px] font-mono text-tagma-accent">
      <Bot size={10} />
      <span>@{part.name}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubtaskPart — a nested agent invocation surfaced inline. Card layout with
// the description as the title, the target agent as a chip, and the prompt
// collapsible (prompts can be long; we don't want them eating the viewport).
// ---------------------------------------------------------------------------

export function SubtaskPartView({ part }: { part: SubtaskPart }) {
  if (!part.description && !part.prompt) return null;
  return (
    <div className="w-full flex flex-col gap-1 border border-tagma-accent/40 bg-tagma-accent/5 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-mono">
        <Sparkles size={11} className="text-tagma-accent shrink-0" />
        <span className="text-tagma-text truncate">{part.description || '(subtask)'}</span>
        {part.agent && (
          <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px border border-tagma-accent/40 text-tagma-accent text-[9px]">
            <Bot size={9} />
            {part.agent}
          </span>
        )}
      </div>
      {part.prompt && (
        <details className="text-[10px] font-mono">
          <summary className="cursor-pointer text-tagma-muted/80 hover:text-tagma-text select-none">
            prompt
          </summary>
          <pre className="select-text mt-1 px-2 py-1 text-[9px] text-tagma-muted/90 whitespace-pre-wrap break-all overflow-y-auto max-h-[200px] border-l border-tagma-accent/40 bg-tagma-bg">
            {part.prompt}
          </pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnapshotPart — opencode checkpoints workspace state between steps so it can
// revert on user request. Surface as a tiny pill so users can see the trail
// without it dominating the viewport.
// ---------------------------------------------------------------------------

export function SnapshotPartView({ part }: { part: SnapshotPart }) {
  if (!part.snapshot) return null;
  return (
    <div className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-tagma-border/60 bg-tagma-surface/40 text-[9px] font-mono text-tagma-muted-dim">
      <Camera size={9} />
      <span title={part.snapshot}>snapshot {shortHash(part.snapshot)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepStartView — opencode emits step-start before each generation segment;
// render as a low-key horizontal divider so multi-step turns are still
// visually segmented. The paired step-finish (per-step cost/tokens) is
// suppressed at the PartRenderer level — the cumulative totals already
// appear in AssistantMessageFooter, so per-step chips were just noise.
// ---------------------------------------------------------------------------

export function StepStartView(_props: { part: StepStartPart }) {
  return (
    <div className="w-full flex items-center gap-1.5 my-0.5 select-none" aria-hidden>
      <span className="flex-1 h-px bg-tagma-border/40" />
      <span className="text-[8px] font-mono uppercase tracking-wider text-tagma-muted-dim">
        step
      </span>
      <span className="flex-1 h-px bg-tagma-border/40" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RetryPart — opencode auto-retries on transient API errors (e.g. 429s). Show
// the attempt number + the underlying error message so the user understands
// why a turn that's still in progress went quiet for a few seconds.
// ---------------------------------------------------------------------------

export function RetryPartView({ part }: { part: RetryPart }) {
  return (
    <div className="w-full flex items-start gap-1.5 px-2 py-1 border-l-2 border-tagma-error/60 bg-tagma-error/8 text-[10px] font-mono">
      <RotateCcw size={11} className="text-tagma-error/80 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="text-tagma-error/90">
          Retry · attempt {part.attempt}
          {part.error.data.statusCode != null && (
            <span className="ml-1.5 text-tagma-muted">HTTP {part.error.data.statusCode}</span>
          )}
        </div>
        <div className="select-text text-tagma-text/85 break-words">{part.error.data.message}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompactionPart — appears when opencode trims older turns to keep within the
// model's context window. Auto-compaction (the common case) gets a different
// label than user-triggered to make the cause visible.
// ---------------------------------------------------------------------------

export function CompactionPartView({ part }: { part: CompactionPart }) {
  return (
    <div className="w-full flex items-center gap-1.5 my-0.5 select-none">
      <span className="flex-1 h-px bg-tagma-muted/30" />
      <span className="inline-flex items-center gap-1 text-[9px] font-mono text-tagma-muted">
        <Minimize2 size={9} />
        <span>{part.auto ? 'auto-compacted' : 'compacted'}</span>
      </span>
      <span className="flex-1 h-px bg-tagma-muted/30" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssistantMessageFooter — the AssistantMessage *envelope* (not a Part)
// carries cumulative cost/tokens for the message and a typed `error` if the
// turn failed. Sole place per-message spend is surfaced now that step-finish
// chips are suppressed; also handles the typed `error` so users don't have to
// scroll up to the global error banner to see what went wrong.
// ---------------------------------------------------------------------------

export function AssistantMessageFooter({ info }: { info: AssistantMessage }) {
  const tokens = info.tokens;
  // ↑ output: tokens the model has produced this turn, including extended-
  //   thinking output (Anthropic counts thinking_delta as output tokens). Note
  //   the cadence: OpenCode only assigns `assistantMsg.tokens = usage.tokens`
  //   on the AI SDK `finish-step` event (see opencode session/index.ts), so
  //   this value lands once per LLM step boundary — at every tool-call round
  //   for multi-step turns, or in one shot at the end of a pure thinking turn.
  //   There is no per-delta usage bump in current OpenCode, so a long thinking
  //   phase shows 0 here until the step completes. Don't pretend otherwise.
  // ↓ input: prompt tokens the model is reading, summed with cache reads and
  //   writes so the total reflects how much context was actually delivered to
  //   the provider (cached reads are still data flowing in, just billed
  //   cheaper). Mostly static after the first step, but worth surfacing so
  //   users can sanity-check context size.
  const outputTokens = tokens?.output ?? 0;
  const inputTokens =
    (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0);
  const hasUsage = outputTokens > 0 || inputTokens > 0 || info.cost > 0;
  if (!hasUsage && !info.error && !info.finish) return null;
  return (
    <div className="w-full flex flex-wrap items-center gap-1.5 mt-0.5 text-[9px] font-mono text-tagma-muted-dim">
      {hasUsage && (
        <span
          className="inline-flex items-center gap-1 tabular-nums"
          title={[
            `output: ${tokens.output}`,
            tokens.reasoning > 0 ? `  (incl. reasoning: ${tokens.reasoning})` : null,
            `input: ${tokens.input}`,
            tokens.cache.read > 0 ? `cache read: ${tokens.cache.read}` : null,
            tokens.cache.write > 0 ? `cache write: ${tokens.cache.write}` : null,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <Layers size={9} />
          {outputTokens > 0 && <span>{formatTokens(outputTokens)}↑</span>}
          {inputTokens > 0 && <span>{formatTokens(inputTokens)}↓</span>}
          {info.cost > 0 && <span>· {formatCost(info.cost)}</span>}
        </span>
      )}
      {info.finish && info.finish !== 'stop' && (
        <span className="uppercase tracking-wider text-tagma-accent">{info.finish}</span>
      )}
      {info.error && <AssistantErrorChip error={info.error} />}
    </div>
  );
}

function AssistantErrorChip({ error }: { error: NonNullable<AssistantMessage['error']> }) {
  const [open, setOpen] = useState(false);
  // Different error names get different one-liners — saves the user from
  // having to read the raw payload to understand what happened.
  let label: string;
  switch (error.name) {
    case 'ProviderAuthError':
      label = 'auth failed';
      break;
    case 'MessageOutputLengthError':
      label = 'output truncated (length)';
      break;
    case 'MessageAbortedError':
      label = 'aborted';
      break;
    case 'APIError':
      label = `API error${'data' in error && error.data?.statusCode ? ` ${error.data.statusCode}` : ''}`;
      break;
    default:
      label = 'error';
  }
  const detail =
    'data' in error &&
    error.data &&
    typeof (error.data as { message?: unknown }).message === 'string'
      ? String((error.data as { message: string }).message)
      : null;
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="inline-flex items-center gap-1 text-tagma-error hover:text-tagma-error/80"
      title={detail ?? label}
    >
      <AlertTriangle size={9} />
      <span>{label}</span>
      {detail && open && (
        <span className="ml-1 max-w-[260px] truncate text-tagma-error/80 normal-case">
          {detail}
        </span>
      )}
    </button>
  );
}
