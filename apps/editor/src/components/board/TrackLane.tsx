import { useState, useRef, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ShieldAlert, SkipForward, Ban } from 'lucide-react';
import type { RawTrackConfig, DiagnosticItem } from '../../api/client';
import { getZoom, viewportW, viewportH } from '../../utils/zoom';
import { usePipelineStore } from '../../store/pipeline-store';
import { findSavedTrack, isTrackOrChildrenModified } from '../../utils/dirty-tracking';

interface TrackLaneProps {
  track: RawTrackConfig;
  taskCount: number;
  hasParallelWarning: boolean;
  errorMessages?: DiagnosticItem[];
}

const FAIL_CFG: Record<string, { icon: React.ReactNode; cls: string; tip: string }> = {
  skip_downstream: {
    icon: <SkipForward size={8} />,
    cls: 'text-tagma-muted/40',
    tip: 'Skip downstream on failure',
  },
  stop_all: {
    icon: <ShieldAlert size={8} />,
    cls: 'text-tagma-error/60',
    tip: 'Stop all on failure',
  },
  ignore: { icon: <Ban size={8} />, cls: 'text-tagma-muted/40', tip: 'Ignore failures' },
};

function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden ${className}`}
    >
      <span className="truncate text-[7.5px] font-mono leading-[14px]">{children}</span>
    </span>
  );
}

/* ── Floating tooltip (portal, same style as TaskCard tooltips) ── */
function TrackTooltip({ track, anchorRect }: { track: RawTrackConfig; anchorRect: DOMRect }) {
  const perms = track.permissions;
  const rows: [string, string][] = [];
  if (track.driver) rows.push(['Driver', track.driver]);
  if (track.model) rows.push(['Model', track.model]);
  if (perms) {
    const parts = [perms.read && 'Read', perms.write && 'Write', perms.execute && 'Execute'].filter(
      Boolean,
    );
    if (parts.length) rows.push(['Permissions', parts.join(', ')]);
  }
  if (track.on_failure) rows.push(['On Failure', track.on_failure]);
  if (track.agent_profile) rows.push(['Profile', track.agent_profile]);
  if (track.cwd) rows.push(['CWD', track.cwd]);
  if (track.middlewares?.length)
    rows.push(['Middleware', track.middlewares.map((m) => m.type).join(', ')]);

  if (rows.length === 0) return null;

  return (
    <FloatingPanel anchorRect={anchorRect} width={240} borderClass="border-tagma-border">
      <div className="px-3 py-1.5 text-[10px] font-semibold text-tagma-text truncate border-b border-tagma-border">
        {track.name}
      </div>
      <div className="px-3 py-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex py-[1.5px] text-[9px] font-mono gap-2 min-w-0">
            <span className="text-tagma-muted/70 w-[72px] shrink-0 truncate">{label}</span>
            <span className="text-tagma-text/80 truncate min-w-0 flex-1">{value}</span>
          </div>
        ))}
      </div>
    </FloatingPanel>
  );
}

function ErrorTooltipPanel({
  messages,
  anchorRect,
}: {
  messages: DiagnosticItem[];
  anchorRect: DOMRect;
}) {
  const hasError = messages.some((m) => m.severity === 'error');
  return (
    <FloatingPanel
      anchorRect={anchorRect}
      width={260}
      borderClass={hasError ? 'border-tagma-error/40' : 'border-tagma-warning/40'}
    >
      <div className="px-3 py-1.5">
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-1.5 py-[2px] text-[9px] font-mono">
            <AlertTriangle
              size={8}
              className={`${msg.severity === 'error' ? 'text-tagma-error' : 'text-tagma-warning'} shrink-0 mt-[2px]`}
            />
            <span
              className={msg.severity === 'error' ? 'text-tagma-error/90' : 'text-tagma-warning/90'}
            >
              {msg.message}
            </span>
          </div>
        ))}
      </div>
    </FloatingPanel>
  );
}

/* ── Shared floating panel with viewport clamping ── */
function FloatingPanel({
  anchorRect,
  width,
  borderClass,
  children,
}: {
  anchorRect: DOMRect;
  width: number;
  borderClass: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = getZoom();
    const gap = 6,
      margin = 8;
    const vw = viewportW(),
      vh = viewportH();
    const tW = el.getBoundingClientRect().width / z;
    const tH = el.getBoundingClientRect().height / z;
    const aR = anchorRect.right / z;
    const aT = anchorRect.top / z;
    const _aH = anchorRect.height / z;
    const aL = anchorRect.left / z;

    // Horizontal: prefer right of anchor, fall back to left
    let left = aR + gap;
    if (left + tW > vw - margin) left = aL - gap - tW;
    left = Math.max(margin, Math.min(left, vw - tW - margin));

    // Vertical: align top of tooltip with top of anchor, clamp to viewport
    let top = aT;
    top = Math.max(margin, Math.min(top, vh - tH - margin));

    setPos({ left, top });
  }, [anchorRect, width]);

  return createPortal(
    <div
      ref={ref}
      className={`fixed pointer-events-none bg-tagma-surface ${borderClass} border shadow-lg animate-fade-in`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width,
        maxHeight: viewportH() - 16,
        overflow: 'hidden',
        zIndex: 9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ── Main ── */
export const TrackLane = memo(function TrackLane({
  track,
  taskCount,
  hasParallelWarning,
  errorMessages,
}: TrackLaneProps) {
  const hasError = errorMessages?.some((d) => d.severity === 'error') ?? false;
  const hasWarningOnly =
    !hasError && (errorMessages?.some((d) => d.severity === 'warning') ?? false);
  const perms = track.permissions;
  const fail = track.on_failure ? FAIL_CFG[track.on_failure] : null;

  // Per-track dirty flag for the canvas MODIFIED chip — flipped when the
  // track itself or any of its tasks has drifted from the on-disk baseline
  // since the last save.
  const savedConfig = usePipelineStore((s) => s.savedConfig);
  const trackIsModified = isTrackOrChildrenModified(findSavedTrack(savedConfig, track.id), track);

  const [hovered, setHovered] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={laneRef}
      className="h-full w-full flex flex-col justify-start px-3 pt-2 select-none"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ─── Row 1 (22px): Name · Badges · Count ─── */}
      {/* The error- and parallel-warning slots are ALWAYS rendered at the
          same fixed size (even when empty) so the row layout — and, in turn,
          anything computed relative to it — is pixel-identical whether or
          not the track has errors. This keeps the left color bar aligned
          across tracks. */}
      <div className="flex items-center h-[22px] gap-[6px] min-w-0 overflow-hidden">
        <span
          aria-hidden
          className="inline-block w-[8px] h-[8px] shrink-0"
          style={{ backgroundColor: track.color || 'transparent' }}
        />
        <span
          className={`text-[11px] font-semibold truncate flex-1 leading-[22px] tracking-tight ${hasError ? 'text-tagma-error' : hasWarningOnly ? 'text-tagma-warning' : track.color ? '' : 'text-tagma-text'}`}
          style={!hasError && !hasWarningOnly && track.color ? { color: track.color } : undefined}
        >
          {track.name}
        </span>

        {trackIsModified && (
          <span
            title="Unsaved change since last save"
            className="inline-block h-[14px] px-[3px] bg-tagma-warning/15 text-tagma-warning/90 shrink-0 leading-[14px] text-[8px] font-mono font-bold uppercase tracking-wider"
          >
            mod
          </span>
        )}

        {/* Single indicator slot — fixed position so error/warn icons align
            across tracks. Error takes precedence over warning, which takes
            precedence over parallel warning. */}
        <span
          className="inline-flex items-center justify-center w-[14px] h-[14px] shrink-0"
          title={
            hasError
              ? 'Validation errors'
              : hasWarningOnly
                ? 'Validation warnings'
                : hasParallelWarning
                  ? 'Tasks without edges run in parallel'
                  : undefined
          }
        >
          {hasError ? (
            <AlertTriangle size={9} className="text-tagma-error" />
          ) : hasWarningOnly || hasParallelWarning ? (
            <AlertTriangle size={9} className="text-tagma-warning" />
          ) : null}
        </span>

        <span className="text-[9px] font-mono text-tagma-muted/50 tabular-nums shrink-0 leading-[22px]">
          {taskCount}
        </span>
      </div>

      {/* ─── Row 2 (16px): Driver chip · Tier chip · R W X · Failure · MW · Profile ───
          Wrapped in a subtle rail so meta elements are perceived as living
          inside a shared container — eliminates cross-track alignment
          nitpicks even if individual chip widths differ. The rail is
          always rendered (even when the track has no meta) so every row
          in the header sidebar has identical vertical structure. */}
      <div className="tagma-rail flex items-center h-[16px] gap-[4px] min-w-0 overflow-hidden px-[4px]">
        {track.driver && (
          <Chip className="bg-tagma-accent/12 text-tagma-accent/70">{track.driver}</Chip>
        )}
        {track.model && (
          <Chip className="bg-tagma-muted/12 text-tagma-muted/80 font-bold">{track.model}</Chip>
        )}
        {perms && (
          <span className="inline-flex items-center h-[14px] gap-[1px] shrink-0">
            {(['read', 'write', 'execute'] as const).map((k) => (
              <span
                key={k}
                className={`text-[7px] font-mono font-bold w-[10px] text-center leading-[14px]
                  ${k === 'read' && perms.read ? 'text-tagma-success' : ''}
                  ${k === 'write' && perms.write ? 'text-tagma-warning' : ''}
                  ${k === 'execute' && perms.execute ? 'text-tagma-error' : ''}
                  ${!perms[k] ? 'text-tagma-muted/20' : ''}
                `}
              >
                {k[0].toUpperCase()}
              </span>
            ))}
          </span>
        )}
        {fail && (
          <span
            className={`inline-flex items-center justify-center w-[14px] h-[14px] shrink-0 ${fail.cls}`}
            title={fail.tip}
          >
            {fail.icon}
          </span>
        )}
        {track.middlewares && track.middlewares.length > 0 && (
          <Chip className="bg-tagma-info/12 text-tagma-info/60 shrink-0">
            mw:{track.middlewares.length}
          </Chip>
        )}
        {track.agent_profile && (
          <span
            className="inline-flex items-center h-[14px] text-[7.5px] font-mono text-tagma-muted/50 truncate max-w-[44px] leading-[14px] shrink-0"
            title={`Profile: ${track.agent_profile}`}
          >
            {track.agent_profile}
          </span>
        )}
      </div>

      {/* ─── Hover tooltip ─── */}
      {hovered &&
        laneRef.current &&
        (hasError || hasWarningOnly ? (
          <ErrorTooltipPanel
            messages={errorMessages!}
            anchorRect={laneRef.current.getBoundingClientRect()}
          />
        ) : (
          <TrackTooltip track={track} anchorRect={laneRef.current.getBoundingClientRect()} />
        ))}
    </div>
  );
});
