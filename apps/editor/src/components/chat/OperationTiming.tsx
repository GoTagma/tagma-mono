import { ChevronRight } from 'lucide-react';
import type { ChatOperationTiming } from '../../../shared/chat-operation-timing';
import { formatDurationShort } from './ActivityPanel';

export function OperationTimingDetails({
  timing,
  now = timing?.observedAt ?? 0,
}: {
  timing: ChatOperationTiming | null;
  now?: number;
}) {
  if (!timing) return null;
  const delta = timing.activeCategory === null ? 0 : Math.max(0, now - timing.observedAt);
  const durations = timing.durationsMs ? { ...timing.durationsMs } : null;
  if (durations && timing.activeCategory !== null) durations[timing.activeCategory] += delta;
  return (
    <details className="chat-disclosure mt-1 text-caption font-mono text-tagma-muted">
      <summary className="cursor-pointer select-none flex items-start gap-1">
        <ChevronRight size={10} className="chat-disclosure-chevron mt-0.5 shrink-0" />
        <span>
          Timing details · {formatDurationShort(timing.elapsedMs + delta)} total
          {timing.trialPlanAttempts > 0
            ? ` · Trial plan attempts: ${timing.trialPlanAttempts}`
            : ''}
        </span>
      </summary>
      {durations ? (
        <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 tabular-nums">
          <dt>Waiting for your input</dt>
          <dd>{formatDurationShort(durations.approval)}</dd>
          <dt title="Model invocations, including provider and tool activity; excludes time waiting for your input.">
            AI request processing
          </dt>
          <dd>{formatDurationShort(durations.ai)}</dd>
          <dt title="Sandbox cases and Live Smoke execution, including case setup and assertions.">
            Trial execution
          </dt>
          <dd>{formatDurationShort(durations.execution)}</dd>
          <dt>Other processing</dt>
          <dd>{formatDurationShort(durations.other)}</dd>
        </dl>
      ) : (
        <p className="mt-1">
          Detailed timings are unavailable because the retained event history is incomplete.
        </p>
      )}
    </details>
  );
}
