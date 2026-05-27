import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { Brain, Check, CheckCircle2, Copy, Loader2, Wrench, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { extractSkillNameFromToolState } from '../../utils/chat-tool-display';
import type {
  AgentPart,
  AssistantMessage,
  CompactionPart,
  FilePart,
  OpencodeThreadEntry,
  Part,
  PatchPart,
  Provider,
  RetryPart,
  SnapshotPart,
  StepStartPart,
  SubtaskPart,
  ToolPart,
  ToolState,
} from '../../api/opencode-chat';
import { pickToolRenderer } from './ToolRenderers';
import {
  AgentPartView,
  AssistantMessageFooter,
  CompactionPartView,
  FilePartView,
  PatchPartView,
  RetryPartView,
  SnapshotPartView,
  StepStartView,
  SubtaskPartView,
} from './StructuredParts';
import { getRenderableMessageParts, shouldRenderMessageBubble } from './message-rendering';
import { TurnActivityPanel } from './ActivityPanel';
import { useChatStore } from '../../store/chat-store';
import { stripAskAiContext } from '../../utils/ask-ai-context';

export function MessageBubble({
  entry,
  streaming = false,
  activityExpanded = false,
  onToggleActivity,
  isCurrentTurn = false,
  surfaceActivitySummary = false,
}: {
  entry: OpencodeThreadEntry;
  streaming?: boolean;
  activityExpanded?: boolean;
  onToggleActivity?: () => void;
  isCurrentTurn?: boolean;
  surfaceActivitySummary?: boolean;
}) {
  const role = entry.info.role;
  if (
    role === 'user' &&
    entry.parts.some(
      (p) =>
        p.type === 'text' &&
        stripAskAiContext(p.text.replace(EDITOR_CONTEXT_RE, ''))
          .trimStart()
          .startsWith('<tagma-internal>'),
    )
  ) {
    return null;
  }
  // Attachment-only send with no instruction: everything strips away, so a
  // rendered bubble would be an empty box. Suppress it (the assistant reply
  // still arrives normally).
  if (isContextOnlyUserMessage(role, entry.parts)) {
    return null;
  }
  // Hide non-user-visible SDK bookkeeping parts before rendering.
  // `synthetic` text — those are framework-injected (e.g. the
  // `<editor-context>` block prepended in chat-store.buildEditorContext)
  // and would surface workspace plumbing to the user. Empty text/reasoning
  // deltas are also hidden so they do not produce blank bordered chat boxes.
  // Visible structured parts get visual treatment in PartRenderer / StructuredParts.tsx.
  const renderableParts = getRenderableMessageParts(entry.parts);

  const hasActivity = role === 'assistant' && (entry.activity?.length ?? 0) > 0;
  if (!shouldRenderMessageBubble({ info: entry.info, parts: renderableParts }) && !hasActivity) {
    return null;
  }

  // Concatenated text for the copy button: only assistant-visible text parts.
  // Strip the synthetic `<editor-context>` prefix on user side (same rule as
  // PartRenderer) so the copy is what the human actually sees.
  const copyableText =
    role === 'assistant'
      ? renderableParts
          .filter((p): p is Part & { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n\n')
          .trim()
      : '';

  return (
    <div className={`flex flex-col gap-1 ${role === 'user' ? 'items-end' : 'items-start'}`}>
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60 flex items-center gap-2">
        <span>{role}</span>
      </div>
      <div
        className={`max-w-[90%] min-w-0 flex flex-col gap-1.5 ${
          role === 'user' ? 'items-end' : 'items-start'
        }`}
      >
        {renderableParts.map((part) => (
          // Wrap each part so flex sizing propagates the bubble's 90% cap.
          // Default flex `min-width: auto` lets a long URL / hash / path
          // inside a part blow the bubble out; `min-w-0` lets the wrapper
          // shrink below its content's intrinsic width, and `max-w-full`
          // pins it to the bubble. No `overflow-hidden` — long tokens are
          // wrapped via `break-*` on the leaves, not clipped.
          <div key={part.id} className="min-w-0 max-w-full">
            <PartRenderer part={part} role={role} streaming={streaming} />
          </div>
        ))}
        {role === 'assistant' && <AssistantMessageFooter info={entry.info as AssistantMessage} />}
        {role === 'assistant' && (
          <AssistantResponseControls info={entry.info as AssistantMessage} text={copyableText} />
        )}
        {role === 'assistant' && (entry.activity?.length ?? 0) > 0 && (
          <TurnActivityPanel
            activity={entry.activity ?? []}
            isCurrentTurn={isCurrentTurn}
            surfaceSummary={surfaceActivitySummary}
            expanded={activityExpanded}
            onToggle={onToggleActivity ?? (() => {})}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Per-message model attribution. A single chat thread can be answered by
 * different models over its lifetime — the user can switch models mid-
 * conversation, or resume a session created weeks ago under a newer
 * default. The global ModelPicker only reflects the *current* selection,
 * so it can't tell you which model produced an older turn. Stamping the
 * model on each assistant message's footer is the only place that survives
 * model switches and session reloads (the modelID lives on the message
 * envelope itself, persisted by opencode, not on transient picker state).
 *
 * Friendly name resolution mirrors ChatPanel's ModelPicker: look the model
 * up in the providers catalog (`provider.models[id].name`). When metadata
 * is missing — e.g. the model was removed upstream but history still
 * references it, or providers haven't loaded yet for a freshly opened
 * thread — fall back to the raw providerID/modelID so the turn is never left
 * unattributed. The exact `providerID/modelID` is always on hover.
 */
function AssistantResponseControls({ info, text }: { info: AssistantMessage; text: string }) {
  const providersFromHook = useChatStore((s) => s.providers);
  const providers =
    providersFromHook.length > 0 ? providersFromHook : useChatStore.getState().providers;
  const attribution = resolveAssistantAttribution(info, providers);
  if (!attribution && !text) return null;
  return (
    <div className="self-stretch flex items-center justify-between gap-2 mt-0.5 text-[9px] font-mono text-tagma-muted-dim">
      {attribution ? (
        <span className="min-w-0 truncate" title={attribution.title}>
          Generated by <span className="text-tagma-muted">{attribution.providerLabel}</span>
          <span className="text-tagma-muted/60"> / </span>
          <span className="text-tagma-muted">{attribution.modelLabel}</span>
        </span>
      ) : (
        <span />
      )}
      {text && <CopyButton text={text} />}
    </div>
  );
}

export function resolveAssistantAttribution(
  info: AssistantMessage,
  providers: readonly Provider[],
): { providerLabel: string; modelLabel: string; title: string } | null {
  const providerID = info.providerID?.trim();
  const modelID = info.modelID?.trim();
  if (!providerID && !modelID) return null;
  const provider = providerID ? providers.find((p) => p.id === providerID) : undefined;
  return {
    providerLabel: provider?.name ?? providerID ?? 'unknown provider',
    modelLabel: (modelID && provider?.models[modelID]?.name) || modelID || 'unknown model',
    title: providerID && modelID ? `${providerID}/${modelID}` : (providerID ?? modelID ?? ''),
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (rare in Electron + localhost web) — no-op */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? 'Copied assistant response' : 'Copy assistant response'}
      aria-label={copied ? 'Copied assistant response' : 'Copy assistant response'}
      className="ml-auto shrink-0 inline-flex items-center justify-center p-0.5 text-tagma-muted/70 hover:text-tagma-text transition-colors"
    >
      {copied ? <Check size={10} className="text-tagma-ready" /> : <Copy size={10} />}
    </button>
  );
}

// Strip the per-turn `<editor-context>` block that chat-store prepends to
// every user message before sending. The block exists only for the agent's
// benefit; surfacing it in the chat history would clutter every bubble with
// a workspace-path preamble the user already knows about. See chat-store's
// buildEditorContext() for the source side of this contract.
const EDITOR_CONTEXT_RE = /^<editor-context>[\s\S]*?<\/editor-context>\n+/;

/**
 * A user message whose entire visible content is synthetic context — the
 * `<editor-context>` preamble and/or one or more `<ask-ai-context>` blocks —
 * with no instruction text and nothing else renderable. Reachable when the
 * user sends with only context attachments after clearing the seeded
 * "Fix this bug." instruction. Both blocks are stripped from display, so
 * rendering the bubble would leave an empty box; callers suppress it instead
 * (same spirit as the `<tagma-internal>` hide above).
 */
export function isContextOnlyUserMessage(role: 'user' | 'assistant', parts: Part[]): boolean {
  if (role !== 'user') return false;
  const renderable = getRenderableMessageParts(parts);
  if (renderable.length === 0) return false;
  return renderable.every(
    (p) =>
      p.type === 'text' &&
      stripAskAiContext(p.text.replace(EDITOR_CONTEXT_RE, '')).trim().length === 0,
  );
}

function PartRenderer({
  part,
  role,
  streaming = false,
}: {
  part: Part;
  role: 'user' | 'assistant';
  streaming?: boolean;
}) {
  switch (part.type) {
    case 'text': {
      const text =
        role === 'user' ? stripAskAiContext(part.text.replace(EDITOR_CONTEXT_RE, '')) : part.text;
      // User messages keep the exact text they typed (`<pre>`-style), so copy/
      // paste round-trips and any accidental markdown-looking input isn't
      // reformatted away. Assistant replies get full markdown (GFM tables,
      // code fences, lists) so its structured output renders as intended.
      if (role === 'user') {
        return (
          <div className="select-text px-2.5 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-words border border-tagma-ready/40 bg-tagma-ready/5 text-tagma-text">
            {text}
          </div>
        );
      }
      return (
        <div className="chat-markdown px-2.5 py-1.5 text-[11px] border border-tagma-border bg-tagma-bg text-tagma-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      );
    }
    case 'reasoning':
      return <ReasoningPartView text={part.text} streaming={streaming} />;
    case 'tool':
      return <ToolPartView part={part as ToolPart} />;
    case 'file':
      return <FilePartView part={part as FilePart} />;
    case 'patch':
      return <PatchPartView part={part as PatchPart} />;
    case 'agent':
      return <AgentPartView part={part as AgentPart} />;
    case 'subtask':
      return <SubtaskPartView part={part as SubtaskPart} />;
    case 'snapshot':
      return <SnapshotPartView part={part as SnapshotPart} />;
    case 'step-start':
      return <StepStartView part={part as StepStartPart} />;
    case 'retry':
      return <RetryPartView part={part as RetryPart} />;
    case 'compaction':
      return <CompactionPartView part={part as CompactionPart} />;
    default:
      return null;
  }
}

/**
 * Keep a `<details>` block visible after the user expands it. Without this,
 * expanding a reasoning/tool block near the bottom of the scroll viewport
 * pushes the new content below the fold, and the ChatMessages auto-scroll
 * only fires when the user was exactly pinned to the tail — so the just-
 * expanded content stays cut off and the user has to scroll manually.
 *
 * Runs in a rAF after the browser has laid out the newly-visible content
 * so `scrollIntoView` sees the final geometry. `block: 'nearest'` scrolls
 * the minimum amount: nothing if the region is already visible, just
 * enough to bring its bottom into view otherwise. We target the details'
 * last child (the body container) rather than the details itself, so the
 * summary doesn't stay pinned to the top while the body extends past the
 * viewport.
 */
function useExpandIntoView() {
  return (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const el = e.currentTarget;
    if (!el.open) return;
    const body = el.lastElementChild as HTMLElement | null;
    requestAnimationFrame(() => {
      (body ?? el).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };
}

/**
 * Reasoning block — auto-expanded while the parent message is still being
 * generated so the user can watch the model think in real time (matches how
 * Claude and ChatGPT surface chain-of-thought). Collapses to the summary
 * once streaming ends, but only if the user hasn't already toggled it; a
 * `userToggled` ref latches the moment of first interaction, after which
 * open/closed follows the user and ignores the streaming prop.
 */
function ReasoningPartView({ text, streaming }: { text: string; streaming: boolean }) {
  const userToggled = useRef(false);
  const [open, setOpen] = useState(streaming);
  const onExpandIntoView = useExpandIntoView();
  useEffect(() => {
    if (streaming && !userToggled.current) setOpen(true);
  }, [streaming]);
  return (
    <details
      open={open}
      onToggle={(e) => {
        userToggled.current = true;
        setOpen(e.currentTarget.open);
        onExpandIntoView(e);
      }}
      className="w-full text-[10px] font-mono text-tagma-muted/80 border-l-2 border-tagma-muted/30 pl-2"
    >
      <summary className="cursor-pointer flex items-center gap-1 select-none">
        <Brain size={10} />
        <span>reasoning</span>
        {streaming && <Loader2 size={9} className="animate-spin text-tagma-muted/60" />}
      </summary>
      <div className="select-text mt-1 whitespace-pre-wrap break-words opacity-80">{text}</div>
    </details>
  );
}

// Tools whose body is the primary signal of the call (vs. a side-effect log)
// — for these the user almost always wants to see the body without an extra
// click. Todo lists in particular: the *content* of the list is the message,
// the tool wrapper is just bookkeeping. Keep the <details> wrapper so the
// user can still collapse it manually if they want.
const DEFAULT_OPEN_TOOLS = new Set(['todowrite', 'todoread', 'skill']);

function ToolPartView({ part }: { part: ToolPart }) {
  const state: ToolState = part.state;
  const onExpandIntoView = useExpandIntoView();
  const icon =
    state.status === 'completed' ? (
      <CheckCircle2 size={10} className="text-tagma-ready" />
    ) : state.status === 'error' ? (
      <XCircle size={10} className="text-tagma-error" />
    ) : state.status === 'running' ? (
      <Loader2 size={10} className="text-tagma-muted animate-spin" />
    ) : (
      <Wrench size={10} className="text-tagma-muted" />
    );

  const title = toolTitle(part, state);

  const defaultOpen = DEFAULT_OPEN_TOOLS.has(part.tool.toLowerCase());

  return (
    <details
      open={defaultOpen || undefined}
      onToggle={onExpandIntoView}
      className="text-[10px] font-mono w-full border border-tagma-border/60 bg-tagma-surface/40"
    >
      <summary className="cursor-pointer flex items-center gap-1.5 px-1.5 py-1 select-none hover:bg-tagma-border/20">
        {icon}
        <span className="text-tagma-muted/80">{part.tool}</span>
        <span className="flex-1 truncate text-tagma-text">{title}</span>
        <span className="text-tagma-muted/60 text-[9px]">{state.status}</span>
      </summary>
      <div className="px-2 py-1.5 border-t border-tagma-border/40 space-y-1">
        <ToolBody part={part} state={state} />
      </div>
    </details>
  );
}

function toolTitle(part: ToolPart, state: ToolState): string {
  if (part.tool.toLowerCase() === 'skill') {
    const skillName = extractSkillNameFromToolState(state) ?? 'unknown';
    if (state.status === 'completed') return `Loaded skill: ${skillName}`;
    if (state.status === 'running') return `Loading skill: ${skillName}`;
    if (state.status === 'error') return `Skill failed: ${skillName}`;
    return `Skill: ${skillName}`;
  }
  return state.status === 'completed' || state.status === 'running'
    ? (state.title ?? part.tool)
    : part.tool;
}

/**
 * Renders the body of a tool call. Tries a per-tool visual renderer first
 * (see `ToolRenderers.tsx`); if no renderer is registered for `part.tool` —
 * or the registered renderer can't make sense of the input shape and returns
 * `null` — falls back to the legacy JSON-pre + raw-output view so unknown
 * tools still surface their data instead of going silent.
 */
function ToolBody({ part, state }: { part: ToolPart; state: ToolState }) {
  const renderer = pickToolRenderer(part.tool);
  // ToolStateCompleted may carry an `attachments: FilePart[]` — produced by
  // tools that return binary artifacts (screenshot tools, plot generators,
  // PDF builders). Rendered below the main body in every case (custom
  // renderer or fallback) so per-tool renderers don't need to know about
  // attachments to surface them.
  const attachments = state.status === 'completed' ? state.attachments : undefined;
  const renderedBody = renderer ? renderer({ part, state }) : null;
  const body = renderedBody ?? (
    <>
      {Object.keys(state.input).length > 0 && (
        <pre className="select-text text-[9px] text-tagma-muted/80 whitespace-pre-wrap break-all overflow-hidden">
          {safeStringify(state.input)}
        </pre>
      )}
      {state.status === 'completed' && state.output && (
        <pre className="select-text text-[9px] text-tagma-text/90 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto">
          {state.output}
        </pre>
      )}
      {state.status === 'error' && (
        <pre className="select-text text-[9px] text-tagma-error/90 whitespace-pre-wrap">
          {state.error}
        </pre>
      )}
    </>
  );
  return (
    <>
      {body}
      {attachments && attachments.length > 0 && (
        <div className="space-y-1 mt-1">
          {attachments.map((att) => (
            <FilePartView key={att.id} part={att} />
          ))}
        </div>
      )}
    </>
  );
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
