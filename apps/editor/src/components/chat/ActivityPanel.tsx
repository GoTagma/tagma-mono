import { useEffect, useState } from 'react';
import type React from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Layers,
  Loader2,
  Send,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ActivityEvent, ActivityKind } from '../../api/opencode-chat';

/**
 * Compact, collapsible "what is the model doing" log attached to an
 * assistant message. The summary line is visible only when it explains a
 * wait the user would otherwise perceive as blank/stuck (first response,
 * first token, retry, compaction, long-running tool, or long silence). Normal
 * streaming does not get a noisy "Working · Xs · N events" footer.
 *
 * Re-renders once per second whenever there's an open event tail, so the
 * elapsed counter and retry countdown move without depending on SSE traffic
 * (the whole point — silent stretches are exactly when the user wants
 * reassurance that something is happening). The interval shuts off the
 * moment all events are sealed.
 *
 * If the user has already expanded the panel, keep it mounted as "Activity"
 * so the details do not collapse out from under them when the state becomes
 * normal streaming again.
 */
export function TurnActivityPanel({
  activity,
  isCurrentTurn,
  surfaceSummary,
  expanded,
  onToggle,
}: {
  activity: ActivityEvent[];
  isCurrentTurn: boolean;
  surfaceSummary: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sessionStatus = useChatStore((s) => s.sessionStatus);
  const lastActivityAt = useChatStore((s) => s.lastActivityAt);
  const turnHealth = useChatStore((s) => s.turnHealth);

  const hasOpenEvent =
    isCurrentTurn && activity.length > 0 && activity[activity.length - 1].endedAt === null;

  // Tick once per second while the panel has live data. Pure cosmetic
  // re-render driver; we don't read the tick value, just need the cycle.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasOpenEvent) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, [hasOpenEvent]);

  if (activity.length === 0 && !isCurrentTurn) return null;

  const now = Date.now();
  const firstStartedAt = activity.length > 0 ? activity[0].startedAt : now;
  const summary = computeActivitySummary({
    activity,
    isCurrentTurn,
    surfaceSummary,
    sessionStatus,
    lastActivityAt,
    turnHealth,
    now,
  });
  if (!summary && !expanded) return null;
  const visibleSummary =
    summary ??
    ({
      line: 'Activity',
      tone: 'text-tagma-muted',
      icon: <ChevronRight size={11} className="text-tagma-muted/60 shrink-0" />,
    } satisfies ActivitySummary);

  return (
    <details
      open={expanded}
      onToggle={(e) => {
        if (e.currentTarget.open !== expanded) onToggle();
      }}
      className="w-full text-[10px] font-mono border-l-2 border-tagma-muted/30 pl-2 mt-1"
    >
      <summary
        className={`cursor-pointer flex items-center gap-1.5 select-none ${visibleSummary.tone}`}
      >
        {visibleSummary.icon}
        <span>{visibleSummary.line}</span>
        <ChevronRight
          size={10}
          className={`text-tagma-muted/50 transition-transform ml-auto ${
            expanded ? 'rotate-90' : ''
          }`}
        />
      </summary>
      <div className="mt-1 flex flex-col gap-0.5 text-tagma-muted/80">
        {activity.map((event, idx) => (
          <ActivityRow key={idx} event={event} now={now} firstStartedAt={firstStartedAt} />
        ))}
      </div>
    </details>
  );
}

function ActivityRow({
  event,
  now,
  firstStartedAt,
}: {
  event: ActivityEvent;
  now: number;
  firstStartedAt: number;
}) {
  const startSec = formatTimelineOffset(event.startedAt - firstStartedAt);
  const durationMs = (event.endedAt ?? now) - event.startedAt;
  const durationLabel = formatDurationShort(durationMs);
  const meta = describeActivity(event);
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-tagma-muted/50 tabular-nums shrink-0 w-10">{startSec}</span>
      <span className="shrink-0">{meta.icon}</span>
      <span className="min-w-0 flex-1 break-words">
        {meta.label}
        {event.detail && <span className="text-tagma-muted/70"> · {event.detail}</span>}
        {typeof event.bytes === 'number' && event.bytes > 0 && (
          <span className="text-tagma-muted/70"> · {formatBytes(event.bytes)}</span>
        )}
        {event.count > 1 && <span className="text-tagma-muted/50"> · ×{event.count}</span>}
      </span>
      <span className="text-tagma-muted/50 tabular-nums shrink-0">{durationLabel}</span>
    </div>
  );
}

interface ActivitySummaryInput {
  activity: ActivityEvent[];
  isCurrentTurn: boolean;
  surfaceSummary: boolean;
  sessionStatus: ReturnType<typeof useChatStore.getState>['sessionStatus'];
  lastActivityAt: number | null;
  turnHealth: ReturnType<typeof useChatStore.getState>['turnHealth'];
  now: number;
}

interface ActivitySummary {
  line: string;
  tone: string;
  icon: React.ReactNode;
}

interface TurnHealthSummary {
  label: string;
  tone: 'normal' | 'warning';
}

type TurnHealthState = ReturnType<typeof useChatStore.getState>['turnHealth'];

export function formatTurnHealthSummary(
  turnHealth: TurnHealthState,
  now: number,
): TurnHealthSummary | null {
  if (!turnHealth) return null;
  const checkedAgo = formatDurationShort(now - turnHealth.checkedAt);
  if (turnHealth.status === 'checking') {
    return { label: 'checking OpenCode', tone: 'normal' };
  }
  if (turnHealth.processAlive === false) {
    return { label: `OpenCode unresponsive · checked ${checkedAgo} ago`, tone: 'warning' };
  }
  if (turnHealth.status === 'degraded') {
    return { label: `OpenCode reconnecting · checked ${checkedAgo} ago`, tone: 'warning' };
  }
  if (turnHealth.sseState === 'reconnecting') {
    return { label: `SSE reconnecting · verified ${checkedAgo} ago`, tone: 'warning' };
  }
  const sseLabel = turnHealth.lastSseEventAt
    ? `SSE idle ${formatDurationShort(now - turnHealth.lastSseEventAt)}`
    : turnHealth.sseState === 'connected'
      ? 'SSE connected'
      : null;
  const label = sseLabel
    ? `verified ${checkedAgo} ago · ${sseLabel}`
    : `OpenCode verified ${checkedAgo} ago`;
  return { label, tone: 'normal' };
}

export function formatRecentTurnHealthSummary(
  turnHealth: TurnHealthState,
  now: number,
): TurnHealthSummary | null {
  const summary = formatTurnHealthSummary(turnHealth, now);
  if (!summary || !turnHealth) return null;
  if (turnHealth.status === 'ok' && now - turnHealth.checkedAt > 10_000) return null;
  return summary;
}

function appendTurnHealth(line: string, health: TurnHealthSummary | null): string {
  return health ? `${line} · ${health.label}` : line;
}

function toneWithHealth(base: string, health: TurnHealthSummary | null): string {
  return health?.tone === 'warning' ? 'text-tagma-warning' : base;
}

function iconWithHealth(base: React.ReactNode, health: TurnHealthSummary | null): React.ReactNode {
  if (health?.tone !== 'warning') return base;
  return <AlertTriangle size={11} className="text-tagma-warning shrink-0" />;
}

/**
 * Build the always-visible header line. Priority of overrides:
 *   1. retry — provider is between attempts; users want the countdown.
 *   2. last event is `compacting` and recent (≤3 s) — surface it briefly.
 *   3. no assistant envelope yet — explicit "waiting for first response".
 *   4. tool running ≥5 s — name the tool so users know what's blocking.
 *   5. current turn but silent ≥10 s after assistant activity — "waiting
 *      for next update" (not "no activity", which reads like an error).
 */
function computeActivitySummary({
  activity,
  isCurrentTurn,
  surfaceSummary,
  sessionStatus,
  lastActivityAt,
  turnHealth,
  now,
}: ActivitySummaryInput): ActivitySummary | null {
  if (!surfaceSummary) return null;

  const isRetry = isCurrentTurn && sessionStatus?.type === 'retry';
  if (isRetry && sessionStatus && sessionStatus.type === 'retry') {
    const remainingSec = Math.max(0, Math.ceil((sessionStatus.next - now) / 1000));
    return {
      line: `Retrying provider · attempt ${sessionStatus.attempt} · next in ${remainingSec}s`,
      tone: 'text-tagma-warning',
      icon: <AlertTriangle size={11} className="text-tagma-warning shrink-0" />,
    };
  }

  const last = activity.length > 0 ? activity[activity.length - 1] : null;
  const firstAt = activity.length > 0 ? activity[0].startedAt : now;
  const hasAssistantStarted = activity.some((event) => event.kind === 'assistant-started');
  const recentHealth = formatRecentTurnHealthSummary(turnHealth, now);
  if (isCurrentTurn && last?.kind === 'compacting' && now - last.startedAt < 3000) {
    return {
      line: 'Compacting history…',
      tone: 'text-tagma-muted',
      icon: <Layers size={11} className="text-tagma-muted shrink-0" />,
    };
  }

  if (isCurrentTurn && !hasAssistantStarted) {
    const baseIcon = <Loader2 size={11} className="animate-spin shrink-0 text-tagma-muted" />;
    return {
      line: appendTurnHealth(
        `Waiting for first response · ${formatDurationShort(now - firstAt)}`,
        recentHealth,
      ),
      tone: toneWithHealth('text-tagma-text', recentHealth),
      icon: iconWithHealth(baseIcon, recentHealth),
    };
  }

  if (isCurrentTurn && last?.kind === 'assistant-started') {
    const baseIcon = <Loader2 size={11} className="animate-spin shrink-0 text-tagma-muted" />;
    return {
      line: appendTurnHealth(
        `Waiting for first token · ${formatDurationShort(now - last.startedAt)}`,
        recentHealth,
      ),
      tone: toneWithHealth('text-tagma-text', recentHealth),
      icon: iconWithHealth(baseIcon, recentHealth),
    };
  }

  if (isCurrentTurn && last?.kind === 'tool-running' && now - last.startedAt > 5000) {
    const sec = Math.floor((now - last.startedAt) / 1000);
    const baseIcon = <Wrench size={11} className="text-tagma-muted shrink-0 animate-pulse" />;
    return {
      line: appendTurnHealth(`Running tool: ${last.detail ?? 'tool'} (${sec}s)`, recentHealth),
      tone: toneWithHealth('text-tagma-muted', recentHealth),
      icon: iconWithHealth(baseIcon, recentHealth),
    };
  }

  if (isCurrentTurn && lastActivityAt !== null && now - lastActivityAt > 10_000) {
    if (turnHealth?.status === 'checking') {
      return {
        line: 'Checking OpenCode...',
        tone: 'text-tagma-muted',
        icon: <Loader2 size={11} className="animate-spin shrink-0 text-tagma-muted" />,
      };
    }
    // Process health: if opencode itself isn't responding, surface it first —
    // everything else (SSE, transcript) depends on the process being alive.
    if (turnHealth?.processAlive === false) {
      return {
        line: `OpenCode process unresponsive · checked ${formatDurationShort(now - turnHealth.checkedAt)} ago`,
        tone: 'text-tagma-warning',
        icon: <AlertTriangle size={11} className="text-tagma-warning shrink-0" />,
      };
    }
    if (turnHealth?.status === 'degraded') {
      return {
        line: `OpenCode reconnecting · checked ${formatDurationShort(now - turnHealth.checkedAt)} ago`,
        tone: 'text-tagma-warning',
        icon: <AlertTriangle size={11} className="text-tagma-warning shrink-0" />,
      };
    }
    // SSE reconnecting: the event stream dropped and is being re-established.
    // This is more actionable than "still waiting" — the user knows something
    // is being fixed.
    if (turnHealth?.sseState === 'reconnecting') {
      return {
        line: `Still waiting · SSE reconnecting · verified ${formatDurationShort(now - turnHealth.checkedAt)} ago`,
        tone: 'text-tagma-warning',
        icon: <AlertTriangle size={11} className="text-tagma-warning shrink-0" />,
      };
    }
    if (turnHealth?.status === 'ok') {
      const sseAgo = turnHealth.lastSseEventAt
        ? formatDurationShort(now - turnHealth.lastSseEventAt)
        : null;
      // Build a line that tells the user exactly what's alive and what's
      // quiet: "Still waiting · model still running · SSE idle 2m · verified
      // 5s ago". This is the key insight — if everything is alive but no
      // events are flowing, the model is probably just thinking slowly.
      const segments: string[] = ['Still waiting'];
      if (turnHealth.detail) segments.push(turnHealth.detail);
      if (turnHealth.sseState === 'idle' && sseAgo) {
        segments.push(`SSE idle ${sseAgo}`);
      } else if (turnHealth.sseState === 'connected') {
        segments.push('SSE connected');
      }
      segments.push(`verified ${formatDurationShort(now - turnHealth.checkedAt)} ago`);
      return {
        line: segments.join(' · '),
        tone: 'text-tagma-muted',
        icon: <CheckCircle2 size={11} className="text-tagma-ready shrink-0" />,
      };
    }
    const idleSec = Math.floor((now - lastActivityAt) / 1000);
    const isLongIdle = idleSec >= 30;
    return {
      line: isLongIdle
        ? `Still waiting · ${idleSec}s since last update`
        : `Waiting for next update · ${idleSec}s`,
      tone: isLongIdle ? 'text-tagma-warning' : 'text-tagma-muted',
      icon: isLongIdle ? (
        <AlertTriangle size={11} className="text-tagma-warning shrink-0" />
      ) : (
        <Loader2 size={11} className="animate-spin shrink-0 text-tagma-muted" />
      ),
    };
  }

  if (!isCurrentTurn) return null;

  const lastEnd = activity.length > 0 ? (activity[activity.length - 1].endedAt ?? now) : now;
  const elapsedMs = Math.max(0, lastEnd - firstAt);
  const elapsed = formatDurationShort(elapsedMs);
  const toolCount = countUniqueTools(activity);
  const parts = [`Working · ${elapsed}`, `${activity.length} events`];
  if (toolCount > 0) parts.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  return {
    line: parts.join(' · '),
    tone: 'text-tagma-text',
    icon: <Loader2 size={11} className="animate-spin shrink-0 text-tagma-muted" />,
  };
}

function countUniqueTools(activity: ActivityEvent[]): number {
  const seen = new Set<string>();
  for (const e of activity) {
    if (
      (e.kind === 'tool-running' || e.kind === 'tool-completed' || e.kind === 'tool-error') &&
      e.detail
    ) {
      seen.add(e.detail);
    }
  }
  return seen.size;
}

const ACTIVITY_KIND_META: Record<ActivityKind, { label: string; icon: React.ReactNode }> = {
  'request-sent': {
    label: 'Request sent',
    icon: <Send size={9} className="text-tagma-muted/70" />,
  },
  'assistant-started': {
    label: 'Assistant started',
    icon: <span className="text-tagma-muted/70">›</span>,
  },
  thinking: {
    label: 'Thinking',
    icon: <Brain size={9} className="text-tagma-muted/70" />,
  },
  'streaming-answer': {
    label: 'Streaming answer',
    icon: <span className="text-tagma-muted/70">¶</span>,
  },
  'tool-running': {
    label: 'Tool running',
    icon: <Wrench size={9} className="text-tagma-muted/70" />,
  },
  'tool-completed': {
    label: 'Tool completed',
    icon: <CheckCircle2 size={9} className="text-tagma-ready" />,
  },
  'tool-error': {
    label: 'Tool error',
    icon: <XCircle size={9} className="text-tagma-error" />,
  },
  'step-start': {
    label: 'Step start',
    icon: <span className="text-tagma-muted/50">·</span>,
  },
  'step-finish': {
    label: 'Step finish',
    icon: <span className="text-tagma-muted/50">·</span>,
  },
  retry: {
    label: 'Retry',
    icon: <AlertTriangle size={9} className="text-tagma-warning" />,
  },
  compacting: {
    label: 'Compacting history',
    icon: <Layers size={9} className="text-tagma-muted/70" />,
  },
};

function describeActivity(event: ActivityEvent): { label: string; icon: React.ReactNode } {
  return ACTIVITY_KIND_META[event.kind] ?? { label: event.kind, icon: null };
}

function formatTimelineOffset(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${String(min).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${String(remSec).padStart(2, '0')}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} chars`;
  return `${(n / 1024).toFixed(1)}k chars`;
}
