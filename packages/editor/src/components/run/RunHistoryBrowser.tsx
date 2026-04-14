import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  History, RefreshCw, FileText, Loader2, Check, X, Clock, SkipForward, Ban,
  Filter, Download,
} from 'lucide-react';
import { api } from '../../api/client';
import type { RunHistoryEntry, RunSummary, RunSummaryTask, TaskStatus } from '../../api/client';

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  idle: <Clock size={9} className="text-tagma-muted/50" />,
  waiting: <Clock size={9} className="text-tagma-muted/60" />,
  running: <Loader2 size={9} className="text-tagma-ready" />,
  success: <Check size={9} className="text-tagma-success" />,
  failed: <X size={9} className="text-tagma-error" />,
  timeout: <Clock size={9} className="text-tagma-warning" />,
  skipped: <SkipForward size={9} className="text-tagma-muted/60" />,
  blocked: <Ban size={9} className="text-tagma-warning" />,
};

const STATUS_CHIP: Record<TaskStatus, string> = {
  idle:    'bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted',
  waiting: 'bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted',
  running: 'bg-tagma-ready/10 border-tagma-ready/20 text-tagma-ready',
  success: 'bg-tagma-success/10 border-tagma-success/20 text-tagma-success',
  failed:  'bg-tagma-error/10 border-tagma-error/20 text-tagma-error',
  timeout: 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning',
  skipped: 'bg-tagma-muted/6 border-tagma-muted/10 text-tagma-muted/60',
  blocked: 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning',
};

type FilterMode = 'all' | 'success' | 'failed';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function computeRunDuration(entry: RunHistoryEntry): string {
  if (!entry.startedAt || !entry.finishedAt) return '—';
  const start = new Date(entry.startedAt).getTime();
  const end = new Date(entry.finishedAt).getTime();
  return formatDuration(end - start);
}

/** Absolute timestamp: shows Today / Yesterday / Mon DD / YYYY-MM-DD
 *  together with HH:mm in 24h format — concise but unambiguous. */
function formatAbsTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${hhmm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) {
    const month = d.toLocaleString(undefined, { month: 'short' });
    return `${month} ${d.getDate()} ${hhmm}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

/** "3 min ago", "2 h ago", "5 d ago" — quick relative scan. */
function formatRelTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 30) return `${dy} d ago`;
  const mo = Math.floor(dy / 30);
  if (mo < 12) return `${mo} mo ago`;
  const y = Math.floor(dy / 365);
  return `${y} y ago`;
}

function downloadSummary(summary: RunSummary): void {
  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${summary.runId}.summary.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Browses `.tagma/logs/run_*` directories under the current workspace.
 * Visible when no active run is running. §3.12: the selected run loads
 * its summary.json (per-task status + timings) and renders a grid of
 * task results; the raw pipeline.log is still available via a toggle.
 */
export function RunHistoryBrowser() {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [logLoading, setLogLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'summary' | 'log'>('summary');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listRunHistory();
      setRuns(res.runs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const loadRun = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setSummary(null);
    setLogContent('');
    setSummaryError(null);
    setViewMode('summary');
    setSummaryLoading(true);
    try {
      const s = await api.getRunSummary(runId);
      setSummary(s);
    } catch (e: unknown) {
      setSummaryError(e instanceof Error ? e.message : 'No summary available for this run');
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadLog = useCallback(async (runId: string) => {
    setLogLoading(true);
    setLogContent('');
    try {
      const res = await api.getRunLog(runId);
      setLogContent(res.content);
    } catch (e: unknown) {
      setLogContent(`Error: ${e instanceof Error ? e.message : 'Failed to load log'}`);
    } finally {
      setLogLoading(false);
    }
  }, []);

  // History-list filter: only show runs matching the selected filter mode.
  const visibleRuns = useMemo(() => {
    if (filterMode === 'all') return runs;
    return runs.filter((r) => {
      if (filterMode === 'success') return r.success === true;
      if (filterMode === 'failed') return r.success === false;
      return true;
    });
  }, [runs, filterMode]);

  // Group summary tasks by track for the per-track timeline view.
  const tasksByTrack = useMemo(() => {
    if (!summary) return new Map<string, RunSummaryTask[]>();
    const out = new Map<string, RunSummaryTask[]>();
    for (const t of summary.tasks) {
      const list = out.get(t.trackId) ?? [];
      list.push(t);
      out.set(t.trackId, list);
    }
    return out;
  }, [summary]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left pane: run list ── */}
      <div className="w-72 shrink-0 border-r border-tagma-border flex flex-col bg-tagma-surface overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-tagma-border shrink-0">
          <History size={12} className="text-tagma-muted" />
          <span className="text-[11px] font-medium text-tagma-text flex-1">Run History</span>
          <button
            type="button"
            onClick={loadHistory}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Filter toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-tagma-border/60 shrink-0 text-[9px] font-mono">
          <Filter size={9} className="text-tagma-muted/60" />
          {(['all', 'success', 'failed'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setFilterMode(mode)}
              className={`px-1.5 py-0.5 uppercase tracking-wider ${
                filterMode === mode
                  ? 'text-tagma-accent border border-tagma-accent/40 bg-tagma-accent/6'
                  : 'text-tagma-muted/60 hover:text-tagma-text border border-transparent'
              }`}
            >
              {mode}
            </button>
          ))}
          <span className="ml-auto text-tagma-muted/40">{visibleRuns.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 text-[10px] text-tagma-error font-mono">{error}</div>
          )}
          {!loading && !error && visibleRuns.length === 0 && (
            <div className="px-3 py-3 text-[10px] text-tagma-muted">
              {filterMode === 'all'
                ? <>No past runs found in <span className="font-mono">.tagma/logs/</span></>
                : <>No runs match filter <span className="font-mono">{filterMode}</span></>}
            </div>
          )}
          {visibleRuns.map((run) => {
            const isSelected = selectedRunId === run.runId;
            const statusIcon = run.success == null
              ? <Clock size={11} className="text-tagma-muted/60 shrink-0" />
              : run.success
                ? <Check size={11} className="text-tagma-success shrink-0" />
                : <X size={11} className="text-tagma-error shrink-0" />;
            return (
              <button
                type="button"
                key={run.runId}
                onClick={() => loadRun(run.runId)}
                className={`
                  w-full text-left px-3 py-2 border-b border-tagma-border/40 hover:bg-tagma-elevated transition-colors
                  ${isSelected ? 'bg-tagma-accent/8 border-l-2 border-l-tagma-accent' : ''}
                `}
              >
                {/* Primary line — the time is the most scannable piece of
                    information when disambiguating which past run a user is
                    after, so it's promoted to the top line alongside the
                    status icon and total duration. */}
                <div className="flex items-center gap-1.5">
                  {statusIcon}
                  <span className="text-[11px] font-medium text-tagma-text flex-1 truncate">
                    {formatAbsTime(run.startedAt)}
                  </span>
                  <span className="text-[9px] font-mono text-tagma-muted/70 tabular-nums shrink-0">
                    {computeRunDuration(run)}
                  </span>
                </div>
                {/* Secondary line — pipeline name + relative time ("3 min ago")
                    for quick temporal scanning without parsing the timestamp. */}
                <div className="text-[9px] text-tagma-muted pl-[18px] mt-0.5 flex items-center gap-1.5 min-w-0">
                  {run.pipelineName && (
                    <>
                      <span className="truncate text-tagma-text/70">{run.pipelineName}</span>
                      <span className="text-tagma-muted/40 shrink-0">·</span>
                    </>
                  )}
                  <span className="shrink-0 text-tagma-muted/60">{formatRelTime(run.startedAt)}</span>
                </div>
                {/* Task-count chips (unchanged) */}
                {run.taskCounts && (
                  <div className="flex items-center gap-1 pl-[18px] mt-1">
                    {run.taskCounts.success > 0 && (
                      <span className="chip-xs bg-tagma-success/10 border-tagma-success/20 text-tagma-success">
                        <Check size={7} />
                        <span className="tabular-nums">{run.taskCounts.success}</span>
                      </span>
                    )}
                    {run.taskCounts.failed > 0 && (
                      <span className="chip-xs bg-tagma-error/10 border-tagma-error/20 text-tagma-error">
                        <X size={7} />
                        <span className="tabular-nums">{run.taskCounts.failed}</span>
                      </span>
                    )}
                    {run.taskCounts.timeout > 0 && (
                      <span className="chip-xs bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning">
                        <Clock size={7} />
                        <span className="tabular-nums">{run.taskCounts.timeout}</span>
                      </span>
                    )}
                    {run.taskCounts.skipped > 0 && (
                      <span className="chip-xs bg-tagma-muted/6 border-tagma-muted/10 text-tagma-muted/60">
                        <SkipForward size={7} />
                        <span className="tabular-nums">{run.taskCounts.skipped}</span>
                      </span>
                    )}
                  </div>
                )}
                {!run.taskCounts && (
                  <div className="text-[9px] font-mono text-tagma-muted/40 pl-[18px] mt-0.5">
                    {formatSize(run.sizeBytes)} log
                  </div>
                )}
                {/* Tertiary — the opaque runId kept small/muted as a tooltip-
                    like fingerprint, useful when correlating with server logs. */}
                <div className="text-[8.5px] font-mono text-tagma-muted/35 pl-[18px] mt-1 truncate" title={run.runId}>
                  {run.runId}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right pane: summary or log ── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-tagma-bg">
        {/* Header with view toggle */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-tagma-border shrink-0">
          <FileText size={12} className="text-tagma-muted" />
          <span className="text-[11px] font-mono text-tagma-muted flex-1 truncate">
            {selectedRunId ?? 'Select a run to view its details'}
          </span>
          {selectedRunId && (
            <>
              <div className="flex items-center border border-tagma-border">
                <button
                  type="button"
                  className={`px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
                    viewMode === 'summary' ? 'bg-tagma-accent/10 text-tagma-accent' : 'text-tagma-muted hover:text-tagma-text'
                  }`}
                  onClick={() => setViewMode('summary')}
                >
                  Summary
                </button>
                <button
                  type="button"
                  className={`px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider border-l border-tagma-border ${
                    viewMode === 'log' ? 'bg-tagma-accent/10 text-tagma-accent' : 'text-tagma-muted hover:text-tagma-text'
                  }`}
                  onClick={() => {
                    setViewMode('log');
                    if (!logContent && !logLoading) loadLog(selectedRunId);
                  }}
                >
                  Log
                </button>
              </div>
              {summary && (
                <button
                  type="button"
                  onClick={() => downloadSummary(summary)}
                  className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
                  title="Export summary.json"
                >
                  <Download size={11} />
                </button>
              )}
              {(summaryLoading || logLoading) && <Loader2 size={11} className="animate-spin text-tagma-muted" />}
            </>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {!selectedRunId && (
            <div className="px-4 py-6 text-[11px] font-mono text-tagma-muted/60">
              Select a run from the list to see its per-task timeline.
            </div>
          )}

          {viewMode === 'summary' && selectedRunId && (
            <div className="px-4 py-3">
              {summaryError && (
                <div className="mb-3 p-2.5 bg-tagma-warning/5 border border-tagma-warning/20 text-[10px] text-tagma-warning font-mono">
                  {summaryError}. Older runs (pre-summary.json) will only have a pipeline.log available.
                </div>
              )}
              {summary && (
                <>
                  {/* Run header */}
                  <div className="mb-4 pb-3 border-b border-tagma-border/40">
                    <div className="flex items-center gap-2 mb-1">
                      {summary.success
                        ? <Check size={13} className="text-tagma-success" />
                        : <X size={13} className="text-tagma-error" />}
                      <span className="text-[13px] font-medium text-tagma-text truncate">{summary.pipelineName}</span>
                    </div>
                    <div className="text-[10px] font-mono text-tagma-muted flex items-center gap-2">
                      <span>{new Date(summary.startedAt).toLocaleString()}</span>
                      <span className="text-tagma-muted/40">→</span>
                      <span>{new Date(summary.finishedAt).toLocaleString()}</span>
                      <span className="text-tagma-muted/40">·</span>
                      <span>{formatDuration(new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime())}</span>
                    </div>
                    {summary.error && (
                      <div className="mt-2 text-[10px] font-mono text-tagma-error/90 bg-tagma-error/5 border border-tagma-error/20 px-2 py-1">
                        {summary.error}
                      </div>
                    )}
                  </div>

                  {/* Per-track task list */}
                  {Array.from(tasksByTrack.entries()).map(([trackId, tasks]) => (
                    <div key={trackId} className="mb-4">
                      <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 mb-1.5">
                        {tasks[0]?.trackName ?? trackId}
                      </div>
                      <div className="border border-tagma-border/60 bg-tagma-bg/40">
                        {tasks.map((task, i) => (
                          <div
                            key={task.taskId}
                            className={`flex items-center gap-2 px-2.5 py-1.5 text-[10px] font-mono ${
                              i > 0 ? 'border-t border-tagma-border/40' : ''
                            }`}
                          >
                            <span className={`chip-xs shrink-0 uppercase tracking-wider ${STATUS_CHIP[task.status]}`}>
                              {STATUS_ICON[task.status]}
                              {task.status}
                            </span>
                            <span className="flex-1 min-w-0 truncate text-tagma-text">{task.taskName}</span>
                            {task.driver && (
                              <span className="shrink-0 text-tagma-accent/70 text-[9px]">{task.driver}</span>
                            )}
                            {task.modelTier && (
                              <span className="shrink-0 text-tagma-muted text-[9px]">{task.modelTier}</span>
                            )}
                            {task.exitCode != null && (
                              <span
                                className={`shrink-0 text-[9px] ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}
                              >
                                exit {task.exitCode}
                              </span>
                            )}
                            <span className="shrink-0 text-tagma-muted tabular-nums w-[40px] text-right">
                              {formatDuration(task.durationMs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {!summary && !summaryLoading && !summaryError && (
                <div className="text-[10px] font-mono text-tagma-muted/60">Loading summary...</div>
              )}
            </div>
          )}

          {viewMode === 'log' && selectedRunId && !logLoading && (
            <pre className="text-[10px] font-mono text-tagma-text whitespace-pre-wrap break-words px-3 py-2">
              {logContent || '(empty)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
