import { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, RotateCcw } from 'lucide-react';
import type { RawPipelineConfig } from '../../api/client';
import {
  buildFullYamlPreviewRows,
  buildYamlPreviewLineTargets,
  serializePreviewYaml,
  type FullYamlPreviewRow,
  type YamlDiffLine,
  type YamlPreviewBlock,
  type YamlPreviewTarget,
} from '../../utils/yaml-preview-diff';

interface YamlPreviewProps {
  config: RawPipelineConfig;
  blocks?: YamlPreviewBlock[];
  onRevertBlock?: (blockId: string) => Promise<boolean>;
  selectedTaskId?: string | null;
  selectedTrackId?: string | null;
  onSelectTask?: (qualifiedId: string) => void;
  onSelectTrack?: (trackId: string) => void;
}

function formatChangeTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function sourceLabel(source: YamlPreviewBlock['source']): string {
  return source === 'chat' ? 'Chat' : 'Editor';
}

function revertTitle(block: YamlPreviewBlock): string {
  return `Revert ${sourceLabel(block.source)} change from ${formatChangeTime(block.changedAt)}`;
}

function lineClass(line: YamlDiffLine): string {
  if (line.kind === 'add') return 'bg-emerald-500/10 text-emerald-300';
  if (line.kind === 'remove') return 'bg-red-500/10 text-red-300';
  return 'text-tagma-text/70';
}

function rowClass(row: FullYamlPreviewRow): string {
  if (row.kind !== 'line') return '';
  if (row.blockId) return lineClass(row.line);
  return 'text-tagma-text/90';
}

function linePrefix(line: YamlDiffLine): string {
  if (line.kind === 'add') return '+';
  if (line.kind === 'remove') return '-';
  return ' ';
}

function rowTarget(
  row: FullYamlPreviewRow,
  targetsByLine: Map<number, YamlPreviewTarget>,
): YamlPreviewTarget | null {
  if (row.kind !== 'line' || row.line.newLine == null) return null;
  return targetsByLine.get(row.line.newLine) ?? null;
}

function selectedTargetKind(
  target: YamlPreviewTarget | null,
  selectedTaskId: string | null | undefined,
  selectedTrackId: string | null | undefined,
): 'task' | 'track' | null {
  if (!target) return null;
  if (target.kind === 'task' && selectedTaskId === target.qualifiedId) return 'task';
  if (selectedTrackId && target.trackId === selectedTrackId) return 'track';
  return null;
}

function selectedClass(kind: 'task' | 'track' | null): string {
  if (kind === 'task') return 'yaml-preview-row-selected-task';
  if (kind === 'track') return 'yaml-preview-row-selected-track';
  return '';
}

interface YamlChangeSegment {
  start: number;
  end: number;
  kind: 'add' | 'remove';
  count: number;
  firstNewLine: number | null;
}

// Run-length encode the rows so each contiguous block of same-kind change rows
// (skipping context, headers, and the +/- divider) becomes one minimap segment.
// Different-kind neighbours stay distinct so the gutter renders clean green and
// red bars instead of ambiguous mixed swatches.
function buildChangeSegments(rows: FullYamlPreviewRow[]): YamlChangeSegment[] {
  const segments: YamlChangeSegment[] = [];
  let current: YamlChangeSegment | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const kind: 'add' | 'remove' | null =
      row.kind === 'line' &&
      row.blockId !== null &&
      (row.line.kind === 'add' || row.line.kind === 'remove')
        ? row.line.kind
        : null;
    if (kind == null) {
      current = null;
      continue;
    }
    if (!current || current.kind !== kind) {
      current = {
        start: i,
        end: i,
        kind,
        count: 1,
        firstNewLine: row.kind === 'line' ? (row.line.newLine ?? null) : null,
      };
      segments.push(current);
    } else {
      current.end = i;
      current.count += 1;
      if (current.firstNewLine == null && row.kind === 'line' && row.line.newLine != null) {
        current.firstNewLine = row.line.newLine;
      }
    }
  }
  return segments;
}

// Remove segments don't carry a newLine, so anchor the title using the
// preceding context row — the next visible line in the current YAML.
function segmentLineHint(rows: FullYamlPreviewRow[], segment: YamlChangeSegment): number | null {
  if (segment.firstNewLine != null) return segment.firstNewLine;
  for (let i = segment.start - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.kind === 'line' && row.line.newLine != null) return row.line.newLine + 1;
  }
  return null;
}

function segmentTitle(rows: FullYamlPreviewRow[], segment: YamlChangeSegment): string {
  const tag = `${segment.kind === 'add' ? '+' : '−'}${segment.count}`;
  const line = segmentLineHint(rows, segment);
  return line != null ? `${tag} at line ${line}` : tag;
}

function segmentColor(segment: YamlChangeSegment): string {
  return segment.kind === 'add' ? 'bg-emerald-500/80' : 'bg-red-500/80';
}

export function YamlPreview({
  config,
  blocks = [],
  onRevertBlock,
  selectedTaskId,
  selectedTrackId,
  onSelectTask,
  onSelectTrack,
}: YamlPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const yamlContent = useMemo(() => serializePreviewYaml(config), [config]);
  const rows = useMemo(() => buildFullYamlPreviewRows(yamlContent, blocks), [blocks, yamlContent]);
  const targetsByLine = useMemo(() => buildYamlPreviewLineTargets(config), [config]);
  const changeSegments = useMemo(() => buildChangeSegments(rows), [rows]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(yamlContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [yamlContent]);

  // Removed rows are user-select:none so drag-selection skips them entirely —
  // they visualize deleted content, not the current YAML. For the rows that are
  // still selectable, strip the +/space diff prefix on copy so the clipboard
  // contains clean YAML.
  const handleCopyEvent = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString();
    if (!text) return;
    const cleaned = text
      .split('\n')
      .map((line) =>
        line.length > 0 && (line[0] === '+' || line[0] === ' ') ? line.slice(1) : line,
      )
      .join('\n');
    e.clipboardData.setData('text/plain', cleaned);
    e.preventDefault();
  }, []);

  const handleRevert = useCallback(
    async (blockId: string) => {
      if (!onRevertBlock || revertingId) return;
      setRevertingId(blockId);
      try {
        await onRevertBlock(blockId);
      } finally {
        setRevertingId(null);
      }
    },
    [onRevertBlock, revertingId],
  );

  const handleSelectTarget = useCallback(
    (target: YamlPreviewTarget | null) => {
      if (!target) return;
      if (target.kind === 'task') {
        onSelectTask?.(target.qualifiedId);
        window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: target.qualifiedId }));
        return;
      }
      onSelectTrack?.(target.trackId);
      window.dispatchEvent(new CustomEvent('tagma:focus-track', { detail: target.trackId }));
    },
    [onSelectTask, onSelectTrack],
  );

  const handleJumpToSegment = useCallback(
    (segment: YamlChangeSegment) => {
      const container = contentRef.current;
      if (!container) return;
      const scrollable = container.scrollHeight - container.clientHeight;
      if (scrollable <= 0) return;
      // Map row-index ratio to scroll position. Block headers are slightly
      // taller than line rows, so this is approximate — fine for a minimap.
      // Bias the target up by a third of the viewport so the change lands
      // near the top of view rather than scrolled off to the bottom edge.
      const ratio = segment.start / Math.max(1, rows.length);
      const target = ratio * container.scrollHeight - container.clientHeight / 3;
      container.scrollTo({
        top: Math.max(0, Math.min(target, scrollable)),
        behavior: 'smooth',
      });
    },
    [rows.length],
  );

  useEffect(() => {
    const container = contentRef.current;
    if (!container || (!selectedTaskId && !selectedTrackId)) return;
    const selected = container.querySelector('[data-yaml-selected="true"]') as HTMLElement | null;
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [rows, selectedTaskId, selectedTrackId]);

  return (
    <div className="h-full flex flex-col bg-tagma-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          YAML Preview
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-tagma-muted hover:text-tagma-text transition-colors px-1.5 py-0.5 border border-tagma-border hover:border-tagma-accent/40"
          >
            {copied ? <Check size={10} className="text-tagma-success" /> : <Copy size={10} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 flex min-h-0">
        <div ref={contentRef} className="flex-1 overflow-auto p-4 min-w-0" onCopy={handleCopyEvent}>
          <div className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words select-text">
            {rows.map((row) => {
              if (row.kind === 'block-header') {
                const block = row.block;
                const blockIndex = blocks.findIndex((candidate) => candidate.id === block.id);
                return (
                  <div
                    key={row.key}
                    className="mt-2 first:mt-0 flex items-center justify-between gap-2 px-2 py-1 border-y border-tagma-border bg-tagma-surface"
                  >
                    <div className="min-w-0 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-tagma-muted">
                      <span>{sourceLabel(block.source)}</span>
                      <span className="text-tagma-muted/60">
                        #{blockIndex >= 0 ? blockIndex + 1 : '?'}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRevert(block.id)}
                      disabled={!onRevertBlock || revertingId !== null}
                      title={revertTitle(block)}
                      aria-label={revertTitle(block)}
                      className="shrink-0 inline-flex items-center justify-center size-5 text-tagma-muted border border-tagma-border hover:text-tagma-text hover:border-tagma-accent/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <RotateCcw
                        size={11}
                        className={revertingId === block.id ? 'animate-spin' : ''}
                      />
                    </button>
                  </div>
                );
              }

              const target = rowTarget(row, targetsByLine);
              const selectionKind = selectedTargetKind(target, selectedTaskId, selectedTrackId);
              const clickable =
                !!target && (target.kind === 'task' ? !!onSelectTask : !!onSelectTrack);
              const isRemoved = row.line.kind === 'remove';

              return (
                <div
                  key={row.key}
                  data-yaml-selected={selectionKind ? 'true' : undefined}
                  aria-selected={selectionKind ? true : undefined}
                  onClick={() => {
                    if (clickable) handleSelectTarget(target);
                  }}
                  className={`grid grid-cols-[1.25rem_minmax(0,1fr)] px-2 ${rowClass(row)} ${clickable ? 'yaml-preview-row-clickable' : ''} ${selectedClass(selectionKind)} ${isRemoved ? 'select-none' : ''}`}
                >
                  <span className="text-tagma-muted/70" aria-hidden="true">
                    {row.blockId ? linePrefix(row.line) : ' '}
                  </span>
                  <span>{row.line.text || ' '}</span>
                </div>
              );
            })}
          </div>
        </div>
        {changeSegments.length > 0 && (
          <div
            className="relative w-1.5 shrink-0 border-l border-tagma-border/60 bg-tagma-bg"
            aria-label="YAML change minimap"
          >
            {changeSegments.map((segment) => {
              const denom = Math.max(1, rows.length);
              const top = (segment.start / denom) * 100;
              const length = segment.end - segment.start + 1;
              // Floor at ~0.5% so single-line changes stay visible without
              // shrinking to a sub-pixel sliver on tall preview panes.
              const heightPct = Math.max(0.5, (length / denom) * 100);
              const title = segmentTitle(rows, segment);
              return (
                <button
                  key={`yaml-change-${segment.start}-${segment.end}`}
                  type="button"
                  onClick={() => handleJumpToSegment(segment)}
                  title={title}
                  aria-label={`Jump to ${title}`}
                  className={`absolute inset-x-0 ${segmentColor(segment)} opacity-70 hover:opacity-100 transition-opacity`}
                  style={{ top: `${top}%`, height: `${heightPct}%` }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
