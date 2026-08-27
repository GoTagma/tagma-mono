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
import type { ActivityEvent, ActivityKind } from '../../api/opencode-chat';

const LIVE_ACTIVITY_TICK_MS = 1000;
const LIVE_ACTIVITY_RESYNC_MS = 5000;

interface TurnActivityPanelProps {
  activity: ActivityEvent[];
  isCurrentTurn: boolean;
  surfaceSummary: boolean;
  expanded: boolean;
  onToggle: () => void;
}

interface ActivitySummary {
  line: string;
  tone: string;
  icon: React.ReactNode;
}

/** Render Host-projected Chat Operation V2 activity without subscribing to raw OpenCode runtime state. */
export function TurnActivityPanel({
  activity,
  isCurrentTurn,
  surfaceSummary,
  expanded,
  onToggle,
}: TurnActivityPanelProps) {
  const hasOpenEvent =
    isCurrentTurn && activity.length > 0 && activity[activity.length - 1].endedAt === null;
  const openEvent = hasOpenEvent ? activity[activity.length - 1] : null;
  const liveClockKey = openEvent
    ? `${openEvent.kind}:${openEvent.startedAt}:${openEvent.key ?? ''}:${openEvent.detail ?? ''}`
    : null;
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (!liveClockKey) return;
    setLiveNow(Date.now());
    let cancelled = false;
    let timeoutId: number | null = null;
    const schedule = () => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        setLiveNow((previous) => advanceLiveActivityNow(previous, Date.now()));
        schedule();
      }, LIVE_ACTIVITY_TICK_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [liveClockKey]);

  if (activity.length === 0 && !isCurrentTurn) return null;
  const now = hasOpenEvent ? liveNow : Date.now();
  const firstStartedAt = activity[0]?.startedAt ?? now;
  const summary = computeActivitySummary(activity, isCurrentTurn, surfaceSummary, now);
  if (!summary && !expanded) return null;
  const visibleSummary =
    summary ??
    ({
      line: 'Activity',
      tone: 'text-tagma-muted',
      icon: <ChevronRight size={10} className="shrink-0 text-tagma-muted/60" />,
    } satisfies ActivitySummary);

  return (
    <details
      open={expanded}
      onToggle={(event) => {
        if (event.currentTarget.open !== expanded) onToggle();
      }}
      className={`w-full max-w-full min-w-0 border-l-2 pl-2 text-caption font-mono ${
        isCurrentTurn ? 'chat-live-rail' : 'border-tagma-muted/30'
      }`}
    >
      <summary
        className={`flex min-w-0 cursor-pointer select-none items-center gap-1.5 ${visibleSummary.tone}`}
      >
        {visibleSummary.icon}
        <span className="min-w-0 flex-1 truncate tabular-nums" title={visibleSummary.line}>
          {visibleSummary.line}
        </span>
        <ChevronRight
          size={10}
          className={`shrink-0 text-tagma-muted/50 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </summary>
      <div className="mt-1 flex min-w-0 flex-col gap-0.5 text-tagma-muted/80">
        {activity.map((event, index) => (
          <ActivityRow
            key={`${event.key ?? event.startedAt}:${index}`}
            event={event}
            now={now}
            firstStartedAt={firstStartedAt}
          />
        ))}
      </div>
    </details>
  );
}

function computeActivitySummary(
  activity: ActivityEvent[],
  isCurrentTurn: boolean,
  surfaceSummary: boolean,
  now: number,
): ActivitySummary | null {
  if (!surfaceSummary || !isCurrentTurn) return null;
  const last = activity.at(-1);
  if (!last) {
    return {
      line: 'Starting Chat Operation V2…',
      tone: 'text-tagma-text',
      icon: <Loader2 size={11} className="shrink-0 animate-spin text-tagma-muted" />,
    };
  }
  const elapsed = formatDurationShort((last.endedAt ?? now) - last.startedAt);
  const meta = describeActivity(last);
  const detail = last.detail ? ` · ${last.detail}` : '';
  return {
    line: `${meta.label}${detail} · ${elapsed}`,
    tone: last.kind === 'tool-error' ? 'text-tagma-warning' : 'text-tagma-text',
    icon:
      last.kind === 'tool-error' ? (
        <AlertTriangle size={11} className="shrink-0 text-tagma-warning" />
      ) : (
        <Loader2 size={11} className="shrink-0 animate-spin text-tagma-muted" />
      ),
  };
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
  const meta = describeActivity(event);
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-10 shrink-0 tabular-nums text-tagma-muted/50">
        {formatTimelineOffset(event.startedAt - firstStartedAt)}
      </span>
      <span className="shrink-0">{meta.icon}</span>
      <span className="min-w-0 flex-1 break-words">
        {meta.label}
        {event.detail && <span className="text-tagma-muted/70"> · {event.detail}</span>}
        {typeof event.bytes === 'number' && event.bytes > 0 && (
          <span className="text-tagma-muted/70"> · {formatBytes(event.bytes)}</span>
        )}
        {event.count > 1 && <span className="text-tagma-muted/50"> · ×{event.count}</span>}
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-tagma-muted/50">
        {formatDurationShort((event.endedAt ?? now) - event.startedAt)}
      </span>
    </div>
  );
}

export function advanceLiveActivityNow(previousNow: number, actualNow: number): number {
  if (!Number.isFinite(previousNow) || !Number.isFinite(actualNow)) return actualNow;
  if (actualNow <= previousNow) return previousNow;
  const elapsed = actualNow - previousNow;
  if (elapsed > LIVE_ACTIVITY_RESYNC_MS) return actualNow;
  return previousNow + Math.min(LIVE_ACTIVITY_TICK_MS, elapsed);
}

const ACTIVITY_KIND_META: Record<ActivityKind, { label: string; icon: React.ReactNode }> = {
  'request-sent': {
    label: 'Request sent',
    icon: <Send size={9} className="text-tagma-muted/70" />,
  },
  'assistant-started': {
    label: 'Host processing',
    icon: <Loader2 size={9} className="text-tagma-muted/70" />,
  },
  thinking: { label: 'Thinking', icon: <Brain size={9} className="text-tagma-muted/70" /> },
  'streaming-answer': {
    label: 'Response',
    icon: <Brain size={9} className="text-tagma-muted/70" />,
  },
  'tool-running': {
    label: 'Host action',
    icon: <Wrench size={9} className="text-tagma-muted/70" />,
  },
  'tool-completed': {
    label: 'Host action completed',
    icon: <CheckCircle2 size={9} className="text-tagma-ready" />,
  },
  'tool-error': {
    label: 'Host action failed',
    icon: <XCircle size={9} className="text-tagma-error" />,
  },
  'step-start': { label: 'Step started', icon: <span className="text-tagma-muted/70">·</span> },
  'step-finish': { label: 'Step finished', icon: <span className="text-tagma-muted/70">·</span> },
  retry: { label: 'Retry', icon: <AlertTriangle size={9} className="text-tagma-warning" /> },
  compacting: {
    label: 'Compacting history',
    icon: <Layers size={9} className="text-tagma-muted/70" />,
  },
};

function describeActivity(event: ActivityEvent): { label: string; icon: React.ReactNode } {
  return ACTIVITY_KIND_META[event.kind] ?? { label: event.kind, icon: null };
}

function formatTimelineOffset(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatDurationShort(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} chars` : `${(value / 1024).toFixed(1)}k chars`;
}
