import { useEffect, useMemo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  FileText, Loader2, Check, X, Clock, SkipForward, Ban, Download,
  History as HistoryIcon, GitBranch, Code2,
} from 'lucide-react';
import { api } from '../../api/client';
import type { RunHistoryEntry, RunSummary, RunSummaryTask, TaskStatus } from '../../api/client';
import { HistoryFlowView } from './HistoryFlowView';

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

type OutcomeFilter = 'all' | 'success' | 'failed';

const OUTCOME_TABS: ReadonlyArray<{ key: OutcomeFilter; label: string }> = [
  { key: 'all', label: 'All Runs' },
  { key: 'success', label: 'Successful' },
  { key: 'failed', label: 'Failed' },
];

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

interface RunHistoryBrowserProps {
  /**
   * Incremented by the parent (RunView) whenever the external Refresh
   * button is clicked. A new value triggers `loadHistory()`; the initial
   * 0 value is ignored so the mount effect isn't double-fired.
   */
  refreshToken?: number;
  /**
   * Reports the loading state up to the parent so the external Refresh
   * button can animate its spinner. Called on every loading transition.
   */
  onLoadingChange?: (loading: boolean) => void;
}

/**
 * Browses `.tagma/logs/run_*` directories under the current workspace.
 * Visible when no active run is running. §3.12: the selected run loads
 * its summary.json (per-task status + timings) and renders a grid of
 * task results; the raw pipeline.log is still available via a toggle.
 *
 * Layout mirrors PluginsPage: an editorial masthead (wordmark + subtitle
 * + underline tabs for outcome filter), a run list column, and a detail
 * pane. Every class choice is deliberately aligned with PluginsPage so
 * navigating between Plugins and History feels like one document with
 * different contents.
 *
 * Refresh is owned by the parent (RunView) which places the button in
 * its own h-11 toolbar — the history browser exposes a refreshToken /
 * onLoadingChange prop pair so the external button can trigger reloads
 * and animate its spinner without this component needing to render its
 * own utility row.
 */
export function RunHistoryBrowser({
  refreshToken = 0,
  onLoadingChange,
}: RunHistoryBrowserProps = {}) {
  const [runs, setRuns] = useState<RunHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [logLoading, setLogLoading] = useState(false);
  const [yamlContent, setYamlContent] = useState<string | null>(null);
  const [yamlLoading, setYamlLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'summary' | 'flow' | 'log' | 'yaml'>('flow');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');

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

  // Report loading transitions so the parent's external Refresh button
  // can animate its spinner. Fires on every change, including the
  // initial mount.
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  // External refresh trigger: when the parent bumps refreshToken, reload
  // history. Ignoring the initial 0 keeps the mount load from firing
  // twice (once via the effect above, once via this one).
  useEffect(() => {
    if (refreshToken > 0) loadHistory();
  }, [refreshToken, loadHistory]);

  const loadRun = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setSummary(null);
    setLogContent('');
    setYamlContent(null);
    setSummaryError(null);
    setViewMode('flow');
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

  const loadYaml = useCallback(async (runId: string) => {
    setYamlLoading(true);
    setYamlContent(null);
    try {
      const text = await api.getRunYamlSnapshot(runId);
      setYamlContent(text ?? '');
    } catch (e: unknown) {
      setYamlContent(`# Error: ${e instanceof Error ? e.message : 'Failed to load yaml snapshot'}`);
    } finally {
      setYamlLoading(false);
    }
  }, []);

  // Outcome filter from the header tabs. An empty list plus an active
  // filter surfaces a filter-aware empty state instead of the generic
  // "no past runs" copy.
  const visibleRuns = useMemo(() => {
    return runs.filter((r) => {
      if (outcome === 'success' && r.success !== true) return false;
      if (outcome === 'failed' && r.success !== false) return false;
      return true;
    });
  }, [runs, outcome]);

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
    <div className="h-full flex flex-col bg-tagma-bg">
      <HistoryHeader
        outcome={outcome}
        onOutcome={setOutcome}
      />

      <div className="flex-1 min-h-0 flex">
        <div className="w-72 shrink-0 border-r border-tagma-border flex flex-col bg-tagma-surface/25 overflow-hidden">
          <div className="shrink-0 h-11 px-5 flex items-center justify-between border-b border-tagma-border/60">
            <span className="text-[9px] tracking-[0.22em] uppercase text-tagma-muted-dim">
              Runs
            </span>
            <span className="text-[10px] font-mono tabular-nums text-tagma-muted-dim">
              {visibleRuns.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="px-5 py-3 text-[10px] text-tagma-error font-mono">{error}</div>
            )}
            {!loading && !error && visibleRuns.length === 0 && (
              <EmptyRunList outcome={outcome} totalRuns={runs.length} />
            )}
            {visibleRuns.map((run) => (
              <RunListItem
                key={run.runId}
                run={run}
                selected={selectedRunId === run.runId}
                onClick={() => loadRun(run.runId)}
              />
            ))}
          </div>
        </div>

        <section className="flex-1 min-h-0 overflow-hidden flex flex-col">
          <DetailPane
            selectedRunId={selectedRunId}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            logContent={logContent}
            logLoading={logLoading}
            yamlContent={yamlContent}
            yamlLoading={yamlLoading}
            viewMode={viewMode}
            onViewMode={(mode) => {
              setViewMode(mode);
              if (mode === 'log' && selectedRunId && !logContent && !logLoading) {
                loadLog(selectedRunId);
              }
              if (mode === 'yaml' && selectedRunId && yamlContent === null && !yamlLoading) {
                loadYaml(selectedRunId);
              }
            }}
            onDownload={() => summary && downloadSummary(summary)}
            tasksByTrack={tasksByTrack}
          />
        </section>
      </div>
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────
//
// Slim outcome-tab strip. RunView owns the h-11 toolbar above this
// component (Back + pipeline name + Refresh) so the history page shares
// the same chrome height as live-run mode; the tabs sit directly
// beneath it as a single compact row, without a second wordmark.
function HistoryHeader({
  outcome,
  onOutcome,
}: {
  outcome: OutcomeFilter;
  onOutcome: (o: OutcomeFilter) => void;
}) {
  return (
    <header className="shrink-0 bg-tagma-surface/60 border-b border-tagma-border">
      <div className="px-6 pt-2">
        <div className="flex items-end gap-7 -mb-px">
          {OUTCOME_TABS.map((t) => (
            <HeaderTab
              key={t.key}
              active={outcome === t.key}
              onClick={() => onOutcome(t.key)}
              icon={
                t.key === 'all' ? <HistoryIcon size={13} />
                  : t.key === 'success' ? <Check size={13} />
                  : <X size={13} />
              }
              label={t.label}
            />
          ))}
        </div>
      </div>
    </header>
  );
}

function HeaderTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-0.5 pb-2.5 text-[12px] font-medium tracking-wide transition-colors border-b-2 ${
        active
          ? 'text-tagma-text border-tagma-accent'
          : 'text-tagma-muted border-transparent hover:text-tagma-text hover:border-tagma-border'
      }`}
    >
      <span className={active ? 'text-tagma-accent' : ''}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ─── Run list item ─────────────────────────────────────────────────────
//
// Same information the previous compact card showed — time, pipeline
// name, duration, relative age, task-count chips — but with more
// breathing room between lines and a left copper rule on the active
// row. Kept in the same ~88-96px vertical rhythm so a dense `.tagma/
// logs` directory still fits a reasonable number of entries on screen.
function RunListItem({
  run,
  selected,
  onClick,
}: {
  run: RunHistoryEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const statusIcon = run.success == null
    ? <Clock size={11} className="text-tagma-muted/60 shrink-0" />
    : run.success
      ? <Check size={11} className="text-tagma-success shrink-0" />
      : <X size={11} className="text-tagma-error shrink-0" />;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-full text-left px-5 py-2.5 border-b border-tagma-border/40 transition-colors ${
        selected
          ? 'bg-tagma-surface/80 text-tagma-text'
          : 'hover:bg-tagma-surface/40 text-tagma-text/90'
      }`}
    >
      {selected && (
        <span
          className="absolute left-0 top-1 bottom-1 w-[2px] bg-tagma-accent"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-2">
        {statusIcon}
        <span className="text-[12px] tracking-wide text-tagma-text flex-1 truncate">
          {formatAbsTime(run.startedAt)}
        </span>
        <span className="text-[9px] font-mono tabular-nums text-tagma-muted-dim shrink-0">
          {computeRunDuration(run)}
        </span>
      </div>
      <div className="pl-[18px] mt-1 flex items-center gap-1.5 min-w-0 text-[10px]">
        {run.pipelineName && (
          <>
            <span className="truncate text-tagma-muted">{run.pipelineName}</span>
            <span className="text-tagma-muted-dim shrink-0">·</span>
          </>
        )}
        <span className="shrink-0 text-tagma-muted-dim">{formatRelTime(run.startedAt)}</span>
      </div>
      {run.taskCounts && (
        <div className="flex items-center gap-1 pl-[18px] mt-1.5">
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
        <div className="text-[9px] font-mono text-tagma-muted-dim pl-[18px] mt-1">
          {formatSize(run.sizeBytes)} log
        </div>
      )}
      <div
        className="text-[8.5px] font-mono text-tagma-muted-dim/70 pl-[18px] mt-1 truncate"
        title={run.runId}
      >
        {run.runId}
      </div>
    </button>
  );
}

function EmptyRunList({
  outcome,
  totalRuns,
}: {
  outcome: OutcomeFilter;
  totalRuns: number;
}) {
  const hasFilter = outcome !== 'all';
  if (totalRuns === 0) {
    return (
      <div className="px-5 py-6 text-[10px] text-tagma-muted-dim leading-relaxed">
        No past runs found in <span className="font-mono text-tagma-muted">.tagma/logs/</span>.
        Runs are recorded once you execute a pipeline.
      </div>
    );
  }
  return (
    <div className="px-5 py-6 text-[10px] text-tagma-muted-dim leading-relaxed">
      {hasFilter ? (
        <>No runs match the current filter. Try widening the outcome tab.</>
      ) : (
        <>No runs available.</>
      )}
    </div>
  );
}

// ─── Detail pane ───────────────────────────────────────────────────────
//
// Compact section-toolbar + scroll body. Kept lean because the editorial
// masthead is already visible above; a second big wordmark inside the
// pane would double up on chrome for no gain. The toolbar still owns the
// Summary / Log toggle and the export affordance so everything the user
// needs on a selected run is within one row of their cursor.
function DetailPane({
  selectedRunId,
  summary,
  summaryLoading,
  summaryError,
  logContent,
  logLoading,
  yamlContent,
  yamlLoading,
  viewMode,
  onViewMode,
  onDownload,
  tasksByTrack,
}: {
  selectedRunId: string | null;
  summary: RunSummary | null;
  summaryLoading: boolean;
  summaryError: string | null;
  logContent: string;
  logLoading: boolean;
  yamlContent: string | null;
  yamlLoading: boolean;
  viewMode: 'summary' | 'flow' | 'log' | 'yaml';
  onViewMode: (mode: 'summary' | 'flow' | 'log' | 'yaml') => void;
  onDownload: () => void;
  tasksByTrack: Map<string, RunSummaryTask[]>;
}) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-tagma-bg">
      <div className="shrink-0 h-11 flex items-center gap-2 px-5 border-b border-tagma-border/60">
        <div className="text-[9px] tracking-[0.22em] uppercase text-tagma-muted-dim">
          Run Detail
        </div>
        <div className="flex-1" />
        <FileText size={12} className="text-tagma-muted-dim shrink-0" />
        <span className="text-[11px] font-mono text-tagma-muted truncate max-w-[360px]">
          {selectedRunId ?? 'Select a run'}
        </span>
        {selectedRunId && (
          <>
            <div className="flex items-center border border-tagma-border ml-2">
              <button
                type="button"
                className={`px-2.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
                  viewMode === 'flow'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                onClick={() => onViewMode('flow')}
                title="Pipeline flow chart"
              >
                <GitBranch size={10} />
              </button>
              <button
                type="button"
                className={`px-2.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border-l border-tagma-border ${
                  viewMode === 'summary'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                onClick={() => onViewMode('summary')}
              >
                Summary
              </button>
              <button
                type="button"
                className={`px-2.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border-l border-tagma-border ${
                  viewMode === 'log'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                onClick={() => onViewMode('log')}
              >
                Log
              </button>
              <button
                type="button"
                className={`px-2.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border-l border-tagma-border flex items-center gap-1 ${
                  viewMode === 'yaml'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                onClick={() => onViewMode('yaml')}
                title="Pipeline yaml snapshot"
              >
                <Code2 size={10} />
                Yaml
              </button>
            </div>
            {summary && (
              <button
                type="button"
                onClick={onDownload}
                className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
                title="Export summary.json"
              >
                <Download size={11} />
              </button>
            )}
            {(summaryLoading || logLoading) && (
              <Loader2 size={11} className="animate-spin text-tagma-muted" />
            )}
          </>
        )}
      </div>

      <div className={`flex-1 min-h-0 ${viewMode === 'flow' ? 'overflow-hidden flex' : 'overflow-auto'}`}>
        {!selectedRunId && (
          <div className="px-6 py-10 text-[11px] text-tagma-muted-dim leading-relaxed max-w-md">
            Select a run from the list to see its per-task timeline. Each run
            stores a <span className="font-mono text-tagma-muted">summary.json</span>
            {' '}alongside its raw <span className="font-mono text-tagma-muted">pipeline.log</span>.
          </div>
        )}

        {viewMode === 'summary' && selectedRunId && (
          <div className="px-6 py-5">
            {summaryError && (
              <div className="mb-4 p-3 bg-tagma-warning/5 border border-tagma-warning/20 text-[10px] text-tagma-warning font-mono leading-relaxed">
                {summaryError}. Older runs (pre-summary.json) will only have a
                pipeline.log available.
              </div>
            )}
            {summary && (
              <>
                <div className="mb-5 pb-4 border-b border-tagma-border/60">
                  <div className="flex items-center gap-2 mb-1.5">
                    {summary.success
                      ? <Check size={14} className="text-tagma-success" />
                      : <X size={14} className="text-tagma-error" />}
                    <span className="text-[14px] font-medium text-tagma-text truncate">
                      {summary.pipelineName}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-tagma-muted flex items-center gap-2 flex-wrap">
                    <span>{new Date(summary.startedAt).toLocaleString()}</span>
                    <span className="text-tagma-muted-dim">→</span>
                    <span>{new Date(summary.finishedAt).toLocaleString()}</span>
                    <span className="text-tagma-muted-dim">·</span>
                    <span>
                      {formatDuration(
                        new Date(summary.finishedAt).getTime() -
                        new Date(summary.startedAt).getTime(),
                      )}
                    </span>
                  </div>
                  {summary.error && (
                    <div className="mt-3 text-[10px] font-mono text-tagma-error/90 bg-tagma-error/5 border border-tagma-error/20 px-2.5 py-1.5">
                      {summary.error}
                    </div>
                  )}
                </div>

                {Array.from(tasksByTrack.entries()).map(([trackId, tasks]) => (
                  <div key={trackId} className="mb-5">
                    <div className="text-[9px] font-mono uppercase tracking-[0.18em] text-tagma-muted-dim mb-2">
                      {tasks[0]?.trackName ?? trackId}
                    </div>
                    <div className="border border-tagma-border/60 bg-tagma-bg/40">
                      {tasks.map((task, i) => (
                        <div
                          key={task.taskId}
                          className={`flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono ${
                            i > 0 ? 'border-t border-tagma-border/40' : ''
                          }`}
                        >
                          <span className={`chip-xs shrink-0 uppercase tracking-wider ${STATUS_CHIP[task.status]}`}>
                            {STATUS_ICON[task.status]}
                            {task.status}
                          </span>
                          <span className="flex-1 min-w-0 truncate text-tagma-text">
                            {task.taskName}
                          </span>
                          {task.driver && (
                            <span className="shrink-0 text-tagma-accent/70 text-[9px]">
                              {task.driver}
                            </span>
                          )}
                          {task.model && (
                            <span className="shrink-0 text-tagma-muted text-[9px]">
                              {task.model}
                            </span>
                          )}
                          {task.exitCode != null && (
                            <span
                              className={`shrink-0 text-[9px] ${
                                task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'
                              }`}
                            >
                              exit {task.exitCode}
                            </span>
                          )}
                          <span className="shrink-0 text-tagma-muted tabular-nums w-[42px] text-right">
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
              <div className="text-[10px] font-mono text-tagma-muted-dim">
                Loading summary...
              </div>
            )}
          </div>
        )}

        {viewMode === 'flow' && selectedRunId && (
          summary ? (
            <HistoryFlowView summary={summary} />
          ) : summaryLoading ? (
            <div className="px-6 py-10 text-[11px] text-tagma-muted-dim">
              <Loader2 size={12} className="animate-spin inline mr-2" />
              Loading flow...
            </div>
          ) : (
            <div className="px-6 py-10 text-[11px] text-tagma-muted-dim">
              No summary data available for flow view.
            </div>
          )
        )}

        {viewMode === 'log' && selectedRunId && !logLoading && (
          <pre className="text-[10px] font-mono text-tagma-text whitespace-pre-wrap break-words px-5 py-4">
            {logContent || '(empty)'}
          </pre>
        )}

        {viewMode === 'yaml' && selectedRunId && (
          yamlLoading ? (
            <div className="px-6 py-10 text-[11px] text-tagma-muted-dim">
              <Loader2 size={12} className="animate-spin inline mr-2" />
              Loading yaml snapshot...
            </div>
          ) : yamlContent === null ? null : yamlContent === '' ? (
            <div className="px-6 py-10 text-[11px] text-tagma-muted-dim leading-relaxed max-w-md">
              No yaml snapshot for this run. Older runs (before snapshotting was
              added) only have a <span className="font-mono text-tagma-muted">summary.json</span>
              {' '}and <span className="font-mono text-tagma-muted">pipeline.log</span>.
            </div>
          ) : (
            <pre className="text-[10px] font-mono text-tagma-text whitespace-pre-wrap break-words px-5 py-4">
              {yamlContent}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
