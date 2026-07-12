import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BarChart3,
  RefreshCw,
  Activity,
  Gauge,
  Layers,
  MessageSquare,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { api, type UsageRecord } from '../../api/client';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';

interface UsagePageProps {
  onBack: () => void;
}

type GroupKey = 'hour' | 'day';

/**
 * One bucket on the chart's X axis. Each model gets its own numeric column on
 * top of the shared `bucket` key so recharts can stack the areas without us
 * pivoting per-render. Keys are model IDs as written in usage.jsonl.
 */
interface ChartPoint {
  bucket: number;
  label: string;
  [model: string]: number | string;
}

const COLORS = [
  '#d97757',
  '#7faeff',
  '#a8d672',
  '#e8c14d',
  '#c79bf0',
  '#f08fb5',
  '#5fcfd6',
  '#9eb8d6',
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function totalTokens(r: UsageRecord): number {
  return r.tokensIn + r.tokensOut + r.tokensReasoning + r.cacheRead + r.cacheWrite;
}

/**
 * Round-down a timestamp to the start of its hour or day bucket. Returns the
 * bucket boundary as ms-epoch — used both as the chart's numeric X coordinate
 * (so spacing is real-time-proportional) and as the table-time label key.
 */
function bucketStart(ts: number, mode: GroupKey): number {
  const d = new Date(ts);
  if (mode === 'hour') {
    d.setMinutes(0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function bucketLabel(ts: number, mode: GroupKey): string {
  const d = new Date(ts);
  if (mode === 'hour') {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:00`;
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function UsagePage({ onBack }: UsagePageProps) {
  const [records, setRecords] = useState<UsageRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupKey>('hour');
  const [modelFilter, setModelFilter] = useState<string>('all');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { records } = await api.listUsage();
      setRecords(records);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage stats');
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedRecords = useMemo(() => {
    const list = records ?? [];
    return [...list].sort((a, b) => b.ts - a.ts);
  }, [records]);

  const visibleRecords = useMemo(() => {
    if (modelFilter === 'all') return sortedRecords;
    return sortedRecords.filter((r) => r.modelID === modelFilter);
  }, [sortedRecords, modelFilter]);

  // Distinct models present in the data — sorted by total tokens so the
  // legend / table dropdown leads with the heaviest hitters.
  const models = useMemo(() => {
    const tally = new Map<string, number>();
    for (const r of records ?? []) {
      tally.set(
        r.modelID || '(unknown)',
        (tally.get(r.modelID || '(unknown)') ?? 0) + totalTokens(r),
      );
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [records]);

  const summary = useMemo(() => {
    const list = visibleRecords;
    const turns = list.length;
    let tokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const r of list) {
      tokens += totalTokens(r);
      inputTokens += r.tokensIn + r.cacheRead;
      outputTokens += r.tokensOut + r.tokensReasoning;
    }
    const avgPerTurn = turns > 0 ? Math.round(tokens / turns) : 0;
    return { turns, tokens, inputTokens, outputTokens, avgPerTurn };
  }, [visibleRecords]);

  // Per-model rollup powering the right-hand "By model" panel. Sorted by
  // total tokens so the heaviest model is on top, matching the chart legend
  // order. Color index aligns with the chart by intersecting with `models`
  // below at render time.
  const modelBreakdown = useMemo(() => {
    const tally = new Map<string, { turns: number; tokens: number }>();
    for (const r of visibleRecords) {
      const key = r.modelID || '(unknown)';
      const cur = tally.get(key) ?? { turns: 0, tokens: 0 };
      cur.turns += 1;
      cur.tokens += totalTokens(r);
      tally.set(key, cur);
    }
    return [...tally.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [visibleRecords]);

  // Pivot records → one ChartPoint per (bucket, modelSet). Each model column
  // holds the bucket's total tokens for that model so AreaChart can stack
  // them naturally without per-render pivoting.
  const chartData = useMemo(() => {
    const buckets = new Map<number, ChartPoint>();
    for (const r of visibleRecords) {
      const bucket = bucketStart(r.ts, groupBy);
      let point = buckets.get(bucket);
      if (!point) {
        point = { bucket, label: bucketLabel(r.ts, groupBy) };
        buckets.set(bucket, point);
      }
      const key = r.modelID || '(unknown)';
      point[key] = ((point[key] as number | undefined) ?? 0) + totalTokens(r);
    }
    return [...buckets.values()].sort((a, b) => a.bucket - b.bucket);
  }, [visibleRecords, groupBy]);

  const chartModels = useMemo(() => {
    const present = new Set<string>();
    for (const point of chartData) {
      for (const k of Object.keys(point)) {
        if (k !== 'bucket' && k !== 'label') present.add(k);
      }
    }
    return [...present];
  }, [chartData]);

  // With only 1–2 real buckets, recharts pins them to the chart edges and they
  // visually disappear. Pad both sides with empty buckets (extrapolated from
  // the groupBy interval) so the real data lands near the center.
  const displayChartData = useMemo(() => {
    const MIN_BUCKETS = 5;
    if (chartData.length === 0 || chartData.length >= MIN_BUCKETS) return chartData;
    const intervalMs = groupBy === 'hour' ? 3_600_000 : 86_400_000;
    const padNeeded = MIN_BUCKETS - chartData.length;
    const padBefore = Math.ceil(padNeeded / 2);
    const padAfter = padNeeded - padBefore;
    const first = chartData[0]!;
    const last = chartData[chartData.length - 1]!;
    const before: ChartPoint[] = [];
    for (let i = padBefore; i > 0; i--) {
      const ts = first.bucket - i * intervalMs;
      before.push({ bucket: ts, label: bucketLabel(ts, groupBy) });
    }
    const after: ChartPoint[] = [];
    for (let i = 1; i <= padAfter; i++) {
      const ts = last.bucket + i * intervalMs;
      after.push({ bucket: ts, label: bucketLabel(ts, groupBy) });
    }
    return [...before, ...chartData, ...after];
  }, [chartData, groupBy]);

  const isDesktop = hasDesktopBridge();

  return (
    <div className="h-full flex flex-col bg-tagma-bg text-tagma-text">
      <header className="shrink-0 bg-tagma-surface/60 border-b border-tagma-border">
        <div
          className={`h-9 flex items-stretch border-b border-tagma-border/60 ${isDesktop ? 'app-drag-region pl-2 pr-0' : 'px-2'}`}
          onDoubleClick={(e) => {
            if (!isDesktop) return;
            if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
          }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0 h-full">
            <button
              onClick={onBack}
              title="Back to Editor"
              className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 shrink-0"
            >
              <ArrowLeft size={12} />
              <span className="hidden md:inline">Back to Editor</span>
            </button>
            <div className="w-px h-5 bg-tagma-border shrink-0" />
            <div className="flex items-center gap-1.5 px-2 shrink-0">
              <BarChart3 size={13} className="text-tagma-accent" />
              <span className="text-xs font-medium text-tagma-text truncate max-w-[200px]">
                Usage Stats
              </span>
            </div>
            <div className="flex-1 min-w-[32px]" />
            <button
              onClick={() => void refresh()}
              title="Refresh"
              className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 shrink-0"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
              <span className="hidden md:inline">Refresh</span>
            </button>
          </div>
          {isDesktop && <DesktopWindowControls />}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto px-2 pb-3 pt-3 sm:px-4">
        {error && (
          <div className="border border-tagma-accent/40 bg-tagma-accent/8 px-3 py-2 text-[11px] font-mono text-tagma-text shrink-0">
            {error}
          </div>
        )}

        {/* ── Summary cards: full-width strip ─────────────────────────────── */}
        <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
          <SummaryCard
            icon={<MessageSquare size={13} />}
            label="Turns"
            value={summary.turns.toString()}
          />
          <SummaryCard
            icon={<Layers size={13} />}
            label="Total tokens"
            value={formatTokens(summary.tokens)}
            hint={`in ${formatTokens(summary.inputTokens)} / out ${formatTokens(summary.outputTokens)}`}
          />
          <SummaryCard
            icon={<Gauge size={13} />}
            label="Avg / turn"
            value={summary.avgPerTurn > 0 ? formatTokens(summary.avgPerTurn) : '—'}
          />
          <SummaryCard
            icon={<Activity size={13} />}
            label="Models used"
            value={String(models.length)}
            hint={models[0] ?? undefined}
          />
        </div>

        {/* ── Chart + Models breakdown side-by-side on wide screens ──────── */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-3 shrink-0">
          <section className="border border-tagma-border bg-tagma-surface/30 flex flex-col min-w-0">
            <div className="flex items-center justify-between px-3 h-9 border-b border-tagma-border/60 shrink-0">
              <div className="flex min-w-0 items-center gap-2">
                <BarChart3 size={12} className="text-tagma-muted" />
                <span className="truncate text-[11px] font-mono text-tagma-muted uppercase tracking-wider">
                  Tokens over time
                </span>
              </div>
              <div className="flex items-center gap-1">
                <PillToggle
                  active={groupBy === 'hour'}
                  onClick={() => setGroupBy('hour')}
                  label="Hour"
                />
                <PillToggle
                  active={groupBy === 'day'}
                  onClick={() => setGroupBy('day')}
                  label="Day"
                />
              </div>
            </div>
            <div className="h-[clamp(180px,32vh,280px)] p-2">
              {chartData.length === 0 ? (
                <EmptyChart loading={loading} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={displayChartData}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10, fill: '#7c7872' }}
                      stroke="rgba(255,255,255,0.1)"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#7c7872' }}
                      stroke="rgba(255,255,255,0.1)"
                      tickFormatter={formatTokens}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#1a1816',
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontSize: 11,
                      }}
                      labelStyle={{ color: '#d4cfc4' }}
                      formatter={(v) => formatTokens(typeof v === 'number' ? v : Number(v) || 0)}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {chartModels.map((m, i) => (
                      <Area
                        key={m}
                        type="monotone"
                        dataKey={m}
                        stackId="1"
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={2}
                        fill={COLORS[i % COLORS.length]}
                        fillOpacity={0.45}
                        dot={{
                          r: 3,
                          fill: COLORS[i % COLORS.length],
                          stroke: COLORS[i % COLORS.length],
                        }}
                        activeDot={{ r: 5 }}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          {/* ── Per-model breakdown panel ──────────────────────────────── */}
          <section className="max-h-[280px] min-w-0 border border-tagma-border bg-tagma-surface/30 flex flex-col xl:max-h-none">
            <div className="flex items-center px-3 h-9 border-b border-tagma-border/60 shrink-0">
              <span className="text-[11px] font-mono text-tagma-muted uppercase tracking-wider">
                By model
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {modelBreakdown.length === 0 ? (
                <div className="px-3 py-6 text-[11px] font-mono text-tagma-muted text-center">
                  {loading ? 'Loading…' : 'No data'}
                </div>
              ) : (
                <ul className="divide-y divide-tagma-border/30">
                  {modelBreakdown.map((row, i) => {
                    const pct =
                      summary.tokens > 0 ? Math.round((row.tokens / summary.tokens) * 100) : 0;
                    return (
                      <li key={row.model} className="px-3 py-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className="w-2 h-2 shrink-0 rounded-sm"
                            style={{ background: COLORS[i % COLORS.length] }}
                          />
                          <span className="flex-1 min-w-0 text-[11px] font-mono text-tagma-text truncate">
                            {row.model}
                          </span>
                          <span className="text-[10px] font-mono text-tagma-muted shrink-0">
                            {pct}%
                          </span>
                        </div>
                        <div className="ml-4 flex items-center justify-between text-[10px] font-mono text-tagma-muted-dim">
                          <span>
                            {row.turns} turn{row.turns === 1 ? '' : 's'}
                          </span>
                          <span>{formatTokens(row.tokens)}</span>
                        </div>
                        <div className="ml-4 mt-1 h-0.5 bg-tagma-border/40 overflow-hidden">
                          <div
                            className="h-full"
                            style={{
                              width: `${pct}%`,
                              background: COLORS[i % COLORS.length],
                              opacity: 0.7,
                            }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        </div>

        {/* ── Records table: fills remaining height with sticky header ─── */}
        <section className="flex min-h-[220px] flex-1 flex-col border border-tagma-border bg-tagma-surface/30">
          <div className="flex items-center justify-between px-3 h-9 border-b border-tagma-border/60 shrink-0">
            <span className="text-[11px] font-mono text-tagma-muted uppercase tracking-wider">
              Records ({visibleRecords.length})
            </span>
            <select
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              className="bg-tagma-bg border border-tagma-border text-[11px] font-mono text-tagma-text px-2 py-1 outline-none focus:border-tagma-accent"
            >
              <option value="all">All models</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {visibleRecords.length === 0 ? (
              <div className="px-4 py-10 text-center text-[11px] font-mono text-tagma-muted">
                {loading
                  ? 'Loading…'
                  : records && records.length === 0
                    ? 'No chat usage recorded yet. Send a message in the chat panel to populate this view.'
                    : 'No records match the current filter.'}
              </div>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead className="text-tagma-muted uppercase tracking-wider text-[9px] sticky top-0 bg-tagma-surface z-10">
                  <tr className="border-b border-tagma-border/60">
                    <Th>Time</Th>
                    <Th>Model</Th>
                    <Th>Provider</Th>
                    <Th align="right">In</Th>
                    <Th align="right">Out</Th>
                    <Th align="right">Reasoning</Th>
                    <Th align="right">Cache R/W</Th>
                    <Th align="right">Total</Th>
                    <Th>Finish</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.map((r) => (
                    <tr
                      key={r.messageID}
                      className="border-b border-tagma-border/30 hover:bg-tagma-surface/40"
                    >
                      <Td>{formatTs(r.ts)}</Td>
                      <Td>
                        <span className="text-tagma-text">{r.modelID || '—'}</span>
                      </Td>
                      <Td>
                        <span className="text-tagma-muted">{r.providerID || '—'}</span>
                      </Td>
                      <Td align="right">{formatTokens(r.tokensIn)}</Td>
                      <Td align="right">{formatTokens(r.tokensOut)}</Td>
                      <Td align="right">
                        {r.tokensReasoning > 0 ? formatTokens(r.tokensReasoning) : '—'}
                      </Td>
                      <Td align="right">
                        {r.cacheRead + r.cacheWrite > 0
                          ? `${formatTokens(r.cacheRead)} / ${formatTokens(r.cacheWrite)}`
                          : '—'}
                      </Td>
                      <Td align="right">
                        <span className="text-tagma-text">{formatTokens(totalTokens(r))}</span>
                      </Td>
                      <Td>
                        <span
                          className={
                            r.finish && r.finish !== 'stop'
                              ? 'text-tagma-accent'
                              : 'text-tagma-muted'
                          }
                        >
                          {r.finish || '—'}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="border border-tagma-border bg-tagma-surface/30 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-tagma-muted">
        {icon}
        <span className="text-[10px] font-mono uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1 text-lg font-medium text-tagma-text">{value}</div>
      {hint && (
        <div className="mt-0.5 break-words text-[10px] font-mono text-tagma-muted-dim">{hint}</div>
      )}
    </div>
  );
}

function PillToggle({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 transition-colors ${
        active ? 'bg-tagma-accent/15 text-tagma-accent' : 'text-tagma-muted hover:text-tagma-text'
      }`}
    >
      {label}
    </button>
  );
}

function EmptyChart({ loading }: { loading: boolean }) {
  return (
    <div className="h-full flex items-center justify-center text-[11px] font-mono text-tagma-muted">
      {loading ? 'Loading…' : 'Nothing to chart yet.'}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-3 py-1.5 font-normal ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={`px-3 py-1.5 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
    </td>
  );
}
