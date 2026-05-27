import { useMemo } from 'react';
import { CheckCircle2, Clock, Loader2, XCircle, Ban, SkipForward } from 'lucide-react';
import type { WorkflowGraphEvent, WorkflowGraphNodeStatus } from '../../api/client';

interface WorkflowTimelineProps {
  events: WorkflowGraphEvent[];
  pipelineIds: string[];
}

interface TimelineEntry {
  pipelineId: string;
  status: WorkflowGraphNodeStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  attempts: number;
}

const STATUS_CONFIG: Record<
  WorkflowGraphNodeStatus,
  {
    label: string;
    icon: typeof Clock;
    color: string;
    bgColor: string;
    borderColor: string;
  }
> = {
  waiting: {
    label: 'Waiting',
    icon: Clock,
    color: 'text-tagma-muted',
    bgColor: 'bg-tagma-muted/20',
    borderColor: 'border-tagma-muted/40',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    color: 'text-tagma-ready',
    bgColor: 'bg-tagma-ready/20',
    borderColor: 'border-tagma-ready/60',
  },
  success: {
    label: 'Success',
    icon: CheckCircle2,
    color: 'text-tagma-success',
    bgColor: 'bg-tagma-success/20',
    borderColor: 'border-tagma-success/60',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    color: 'text-tagma-error',
    bgColor: 'bg-tagma-error/20',
    borderColor: 'border-tagma-error/60',
  },
  skipped: {
    label: 'Skipped',
    icon: SkipForward,
    color: 'text-tagma-muted',
    bgColor: 'bg-tagma-muted/20',
    borderColor: 'border-tagma-muted/40',
  },
  aborted: {
    label: 'Aborted',
    icon: Ban,
    color: 'text-tagma-warning',
    bgColor: 'bg-tagma-warning/20',
    borderColor: 'border-tagma-warning/60',
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatTimestamp(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function WorkflowTimeline({ events, pipelineIds }: WorkflowTimelineProps) {
  const timelineEntries = useMemo(() => {
    const entries = new Map<string, TimelineEntry>();

    // Initialize entries for all pipelines
    for (const pipelineId of pipelineIds) {
      entries.set(pipelineId, {
        pipelineId,
        status: 'waiting',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        error: null,
        attempts: 0,
      });
    }

    // Process events to build timeline
    for (const event of events) {
      if (event.type === 'pipeline_update') {
        const existing = entries.get(event.pipelineId);
        if (!existing) continue;

        const startedAt = event.startedAt ? new Date(event.startedAt) : existing.startedAt;
        const finishedAt = event.finishedAt ? new Date(event.finishedAt) : existing.finishedAt;
        const durationMs =
          startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : existing.durationMs;

        // Count attempts (each run_start increments)
        const attempts =
          event.status === 'running' && existing.status !== 'running'
            ? existing.attempts + 1
            : existing.attempts;

        entries.set(event.pipelineId, {
          ...existing,
          status: event.status,
          startedAt,
          finishedAt,
          durationMs,
          error: event.error ?? existing.error,
          attempts,
        });
      } else if (event.type === 'graph_end') {
        // Final state from graph_end
        for (const pipeline of event.pipelines) {
          const existing = entries.get(pipeline.pipelineId);
          if (!existing) continue;

          const startedAt = pipeline.startedAt ? new Date(pipeline.startedAt) : existing.startedAt;
          const finishedAt = pipeline.finishedAt
            ? new Date(pipeline.finishedAt)
            : existing.finishedAt;
          const durationMs =
            startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : existing.durationMs;

          entries.set(pipeline.pipelineId, {
            ...existing,
            status: pipeline.status,
            startedAt,
            finishedAt,
            durationMs,
            error: pipeline.error ?? existing.error,
            attempts: pipeline.runCount ?? existing.attempts,
          });
        }
      }
    }

    return Array.from(entries.values());
  }, [events, pipelineIds]);

  // Calculate timeline bounds
  const timelineBounds = useMemo(() => {
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const entry of timelineEntries) {
      if (entry.startedAt) {
        minTime = Math.min(minTime, entry.startedAt.getTime());
      }
      if (entry.finishedAt) {
        maxTime = Math.max(maxTime, entry.finishedAt.getTime());
      } else if (entry.startedAt && entry.status === 'running') {
        // For running pipelines, extend to current time
        maxTime = Math.max(maxTime, Date.now());
      }
    }

    if (minTime === Infinity || maxTime === -Infinity) {
      return null;
    }

    return { minTime, maxTime, duration: maxTime - minTime };
  }, [timelineEntries]);

  if (!timelineBounds || timelineEntries.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-tagma-muted text-sm">
        No execution data available
      </div>
    );
  }

  const { minTime, duration } = timelineBounds;

  return (
    <div className="space-y-2 p-4 bg-tagma-surface rounded-lg border border-tagma-border">
      <h3 className="text-sm font-semibold text-tagma-text mb-3">Execution Timeline</h3>

      {/* Timeline header */}
      <div className="relative h-6 mb-2">
        <div className="absolute inset-x-0 top-1/2 h-px bg-tagma-border" />
        <div className="absolute left-0 top-0 text-xs text-tagma-muted">
          {formatTimestamp(new Date(minTime))}
        </div>
        <div className="absolute right-0 top-0 text-xs text-tagma-muted">
          {formatTimestamp(new Date(minTime + duration))}
        </div>
      </div>

      {/* Pipeline timeline bars */}
      <div className="space-y-3">
        {timelineEntries.map((entry) => {
          const config = STATUS_CONFIG[entry.status];
          const Icon = config.icon;
          const isRunning = entry.status === 'running';

          // Calculate bar position and width
          const barLeft = entry.startedAt
            ? ((entry.startedAt.getTime() - minTime) / duration) * 100
            : 0;
          const barWidth =
            entry.startedAt && entry.finishedAt
              ? ((entry.finishedAt.getTime() - entry.startedAt.getTime()) / duration) * 100
              : entry.startedAt && isRunning
                ? ((Date.now() - entry.startedAt.getTime()) / duration) * 100
                : 2; // Minimum width for waiting/skipped

          return (
            <div key={entry.pipelineId} className="space-y-1">
              {/* Pipeline label */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Icon className={`w-3.5 h-3.5 ${config.color} ${isRunning ? 'animate-spin' : ''}`} />
                  <span className="font-medium text-tagma-text">{entry.pipelineId}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${config.bgColor} ${config.color}`}>
                    {config.label}
                  </span>
                  {entry.attempts > 1 && (
                    <span className="text-tagma-muted">
                      Attempt {entry.attempts}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-tagma-muted">
                  {entry.durationMs !== null && (
                    <span className="font-mono">{formatDuration(entry.durationMs)}</span>
                  )}
                  <span className="font-mono text-[10px]">
                    {formatTimestamp(entry.startedAt)} → {formatTimestamp(entry.finishedAt)}
                  </span>
                </div>
              </div>

              {/* Timeline bar */}
              <div className="relative h-6 bg-tagma-elevated rounded border border-tagma-border overflow-hidden">
                <div
                  className={`absolute top-1 bottom-1 rounded ${config.bgColor} border ${config.borderColor} transition-all ${
                    isRunning ? 'animate-pulse' : ''
                  }`}
                  style={{
                    left: `${Math.max(0, Math.min(barLeft, 100))}%`,
                    width: `${Math.max(barWidth, 2)}%`,
                  }}
                >
                  {/* Duration label inside bar if wide enough */}
                  {barWidth > 15 && entry.durationMs !== null && (
                    <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-tagma-text">
                      {formatDuration(entry.durationMs)}
                    </div>
                  )}
                </div>
              </div>

              {/* Error message if present */}
              {entry.error && (
                <div className="text-xs text-tagma-error bg-tagma-error/10 border border-tagma-error/30 rounded px-2 py-1 mt-1">
                  {entry.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary stats */}
      <div className="flex items-center gap-4 pt-3 mt-3 border-t border-tagma-border text-xs text-tagma-muted">
        <div>
          <span className="font-medium">Total duration:</span>{' '}
          <span className="font-mono">{formatDuration(duration)}</span>
        </div>
        <div>
          <span className="font-medium">Pipelines:</span> {timelineEntries.length}
        </div>
        <div>
          <span className="font-medium">Success:</span>{' '}
          {timelineEntries.filter((e) => e.status === 'success').length}
        </div>
        <div>
          <span className="font-medium">Failed:</span>{' '}
          {timelineEntries.filter((e) => e.status === 'failed').length}
        </div>
      </div>
    </div>
  );
}
