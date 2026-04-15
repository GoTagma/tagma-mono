import { useState, useRef, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Terminal, MessageSquare, Lock, FileSearch,
  Clock, CheckCircle2, Layers, FileOutput, Package,
  Loader2, Check, X as XIcon, SkipForward, Ban,
} from 'lucide-react';
import type { RawTaskConfig, RawPipelineConfig, TaskStatus } from '../../api/client';
import { getZoom, viewportW, viewportH } from '../../utils/zoom';

interface TaskCardProps {
  task: RawTaskConfig;
  trackId: string;
  pipelineConfig: RawPipelineConfig;
  x: number;
  y: number;
  w: number;
  h: number;
  isSelected: boolean;
  isInvalid: boolean;
  errorMessages?: string[];
  isDragging: boolean;
  isTrackDragging: boolean;
  isEdgeTarget: boolean;
  onPointerDown?: (taskId: string, e: React.PointerEvent) => void;
  onHandlePointerDown?: (taskId: string, e: React.PointerEvent) => void;
  onTargetPointerUp?: (taskId: string) => void;
  onContextMenu?: (taskId: string, e: React.MouseEvent) => void;
  /**
   * Read-only mode: disables drag/edge handles and pointer interactions so
   * the same component can be rendered inside the Run view (where the
   * pipeline is being executed, not edited).
   */
  readOnly?: boolean;
  /**
   * Runtime status to overlay on top of the card (Run view). When provided,
   * the card renders a status bar + optional duration label reflecting the
   * live task state from the SDK event stream.
   */
  runtimeStatus?: TaskStatus;
  runtimeDurationMs?: number | null;
  /**
   * Click handler used by Run view. Only fired when `readOnly` is true;
   * in edit mode the primary interaction is drag, so clicks are routed
   * through `onPointerDown` instead.
   */
  onClickRun?: (taskId: string) => void;
}

const RUNTIME_CFG: Record<TaskStatus, { bar: string; bg: string; icon: typeof Check; iconColor: string; label: string }> = {
  idle:    { bar: '',                   bg: '',                     icon: Clock,       iconColor: '',                     label: '' },
  waiting: { bar: 'bg-tagma-muted/50',  bg: '',                     icon: Clock,       iconColor: 'text-tagma-muted/60',  label: 'waiting' },
  running: { bar: 'bg-tagma-ready',     bg: 'bg-tagma-ready/8',     icon: Loader2,     iconColor: 'text-tagma-ready',     label: 'running' },
  success: { bar: 'bg-tagma-success',   bg: 'bg-tagma-success/8',   icon: Check,       iconColor: 'text-tagma-success',   label: 'done' },
  failed:  { bar: 'bg-tagma-error',     bg: 'bg-tagma-error/8',     icon: XIcon,       iconColor: 'text-tagma-error',     label: 'failed' },
  timeout: { bar: 'bg-tagma-warning',   bg: 'bg-tagma-warning/8',   icon: Clock,       iconColor: 'text-tagma-warning',   label: 'timeout' },
  skipped: { bar: 'bg-tagma-muted/40',  bg: '',                     icon: SkipForward, iconColor: 'text-tagma-muted/50',  label: 'skipped' },
  blocked: { bar: 'bg-tagma-warning',   bg: 'bg-tagma-warning/8',   icon: Ban,         iconColor: 'text-tagma-warning',   label: 'blocked' },
};

function formatRuntimeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveField<K extends 'driver' | 'model'>(
  task: RawTaskConfig, trackId: string, config: RawPipelineConfig, field: K,
): string | undefined {
  if (task[field]) return task[field];
  const track = config.tracks.find((t) => t.id === trackId);
  if (track?.[field]) return track[field];
  if (field === 'driver') return config.driver;
  return undefined;
}

/* ── Tiny pill chip for meta items ──
 * Shrinkable by default so long driver/model names truncate with an
 * ellipsis instead of hard-clipping against the parent's overflow box.
 * Call sites that must stay a fixed width should pass `shrink-0` via
 * className. */
function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden ${className}`}>
      <span className="truncate text-[7.5px] font-mono leading-[14px]">{children}</span>
    </span>
  );
}

/* ── Error Tooltip ──
 * Positioned relative to the card (above by default, below if clipped).
 * Recomputes once on mount based on the captured anchorRect; does NOT
 * follow the mouse — this is the U13 fix for flicker. A short opacity
 * transition smooths the appearance.
 */
function ErrorTooltip({ messages, anchorRect }: { messages: string[]; anchorRect: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = getZoom();
    const gap = 8, margin = 8;
    const vw = viewportW(), vh = viewportH();
    const tW = el.getBoundingClientRect().width / z;
    const tH = el.getBoundingClientRect().height / z;
    const aL = anchorRect.left / z, aT = anchorRect.top / z;
    const aW = anchorRect.width / z, aB = anchorRect.bottom / z;

    // Anchor above the card centered horizontally; fall back to below if
    // there's not enough room above.
    let left = aL + aW / 2 - tW / 2;
    left = Math.max(margin, Math.min(left, vw - tW - margin));
    let top = aT - gap - tH;
    if (top < margin) top = aB + gap;
    top = Math.max(margin, Math.min(top, vh - tH - margin));
    setPos({ left, top });
    // Kick opacity transition on next frame.
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
    // anchorRect is captured once per hover-in; intentionally not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="fixed pointer-events-none bg-[#1a1a1e] border border-tagma-error/40 shadow-lg"
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        width: 260, maxHeight: viewportH() - 16,
        overflow: 'hidden', zIndex: 9999,
        opacity: pos && visible ? 1 : 0,
        transition: 'opacity 150ms ease-out',
      }}
    >
      <div className="px-3 py-1.5">
        {messages.map((msg, i) => (
          <div key={i} className="flex items-start gap-1.5 py-[2px] text-[9px] font-mono">
            <AlertTriangle size={8} className="text-tagma-error shrink-0 mt-[2px]" />
            <span className="text-tagma-error/90">{msg}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ── Config Tooltip ── */
function TaskTooltip({ task, trackId, config, anchorRect }: {
  task: RawTaskConfig; trackId: string; config: RawPipelineConfig; anchorRect: DOMRect;
}) {
  const driver = resolveField(task, trackId, config, 'driver');
  const model = resolveField(task, trackId, config, 'model');
  const track = config.tracks.find((t) => t.id === trackId);
  const perms = task.permissions ?? track?.permissions;

  const isCmd = task.command !== undefined;
  const rows: [string, string][] = [];
  // AI-specific fields only for prompt/template tasks
  if (!isCmd && driver) rows.push(['Driver', driver]);
  if (!isCmd && model) rows.push(['Model', model]);
  if (!isCmd && perms) {
    const parts = [perms.read && 'Read', perms.write && 'Write', perms.execute && 'Execute'].filter(Boolean);
    if (parts.length) rows.push(['Permissions', parts.join(', ')]);
  }
  if (task.timeout) rows.push(['Timeout', task.timeout]);
  if (task.trigger) rows.push(['Trigger', `${task.trigger.type}${task.trigger.message ? ` — ${task.trigger.message}` : ''}`]);
  if (task.completion) rows.push(['Completion', task.completion.type]);
  if (task.middlewares?.length) rows.push(['Middleware', task.middlewares.map((m) => m.type).join(', ')]);
  if (task.output) rows.push(['Output', task.output]);
  if (task.continue_from) rows.push(['Continue', task.continue_from]);
  if (task.cwd) rows.push(['CWD', task.cwd]);
  if (!isCmd && task.agent_profile) rows.push(['Profile', task.agent_profile]);
  if (task.use) rows.push(['Template', task.use]);
  if (task.prompt) rows.push(['Prompt', task.prompt.length > 60 ? task.prompt.slice(0, 60) + '…' : task.prompt]);
  if (task.command) rows.push(['Command', task.command.length > 60 ? task.command.slice(0, 60) + '…' : task.command]);

  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const z = getZoom();
    const gap = 6, margin = 8;
    const vw = viewportW(), vh = viewportH();
    const tW = el.getBoundingClientRect().width / z;
    const tH = el.getBoundingClientRect().height / z;
    const aL = anchorRect.left / z, aT = anchorRect.top / z;
    const aW = anchorRect.width / z, aB = anchorRect.bottom / z;

    let left = aL + aW / 2 - tW / 2;
    left = Math.max(margin, Math.min(left, vw - tW - margin));
    let top = aT - gap - tH >= margin ? aT - gap - tH : aB + gap;
    top = Math.max(margin, Math.min(top, vh - tH - margin));
    setPos({ left, top });
  }, [anchorRect]);

  if (rows.length === 0) return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className="fixed pointer-events-none bg-[#1a1a1e] border border-[#2a2a30] shadow-lg animate-fade-in"
      style={{
        left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        width: 260, maxHeight: viewportH() - 16,
        overflow: 'hidden', zIndex: 9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="px-3 py-1.5 text-[10px] font-semibold text-tagma-text truncate border-b border-[#2a2a30]">
        {task.name || task.id}
      </div>
      <div className="px-3 py-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex py-[1.5px] text-[9px] font-mono gap-2 min-w-0">
            <span className="text-tagma-muted/70 w-[72px] shrink-0 truncate">{label}</span>
            <span className="text-tagma-text/80 truncate min-w-0 flex-1">{value}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/* ── Main ── */
export const TaskCard = memo(function TaskCard({
  task, trackId, pipelineConfig, x, y, w, h,
  isSelected, isInvalid, errorMessages, isDragging, isTrackDragging, isEdgeTarget,
  onPointerDown, onHandlePointerDown, onTargetPointerUp, onContextMenu,
  readOnly = false, runtimeStatus, runtimeDurationMs, onClickRun,
}: TaskCardProps) {
  const [hovered, setHovered] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const isCommand = task.command !== undefined;
  const isTemplate = !!task.use;

  const driver = resolveField(task, trackId, pipelineConfig, 'driver');
  const model = resolveField(task, trackId, pipelineConfig, 'model');
  const track = pipelineConfig.tracks.find((t) => t.id === trackId);
  const perms = task.permissions ?? track?.permissions;

  // Resolve runtime status bar / background (only populated in Run mode when
  // runtimeStatus is provided). In edit mode this stays empty so the existing
  // look is unchanged.
  const runtimeCfg = runtimeStatus ? RUNTIME_CFG[runtimeStatus] : null;
  const isSkipped = runtimeStatus === 'skipped';
  const RuntimeIcon = runtimeCfg?.icon ?? null;

  const borderColor = isDragging
    ? 'border-tagma-accent'
    : isInvalid ? 'border-tagma-error/60'
    : isSelected ? 'border-tagma-accent'
    : isEdgeTarget ? 'border-tagma-accent/60'
    : 'border-tagma-border/70';

  const bgColor = isDragging
    ? 'bg-tagma-accent/10'
    : isInvalid ? 'bg-tagma-error/8'
    : isSelected ? 'bg-tagma-accent/6'
    : isEdgeTarget ? 'bg-tagma-accent/4'
    : (runtimeCfg?.bg ? runtimeCfg.bg : 'bg-tagma-elevated hover:bg-tagma-elevated/80');

  // Status indicators — each wrapped in a fixed 10x10 slot so badges
  // land on the same horizontal grid regardless of which icons appear.
  const BadgeSlot = ({ children }: { children: React.ReactNode }) => (
    <span className="inline-flex items-center justify-center w-[10px] h-[10px] shrink-0">
      {children}
    </span>
  );
  const badges: React.ReactNode[] = [];
  if (task.trigger) {
    const I = task.trigger.type === 'file' ? FileSearch : Lock;
    badges.push(<BadgeSlot key="trg"><I size={7} className="text-amber-400/80" /></BadgeSlot>);
  }
  if (task.timeout) badges.push(<BadgeSlot key="to"><Clock size={7} className="text-sky-400/70" /></BadgeSlot>);
  if (task.completion) badges.push(<BadgeSlot key="ck"><CheckCircle2 size={7} className="text-emerald-400/70" /></BadgeSlot>);
  if (task.middlewares?.length) badges.push(<BadgeSlot key="mw"><Layers size={7} className="text-purple-400/70" /></BadgeSlot>);
  if (task.output) badges.push(<BadgeSlot key="out"><FileOutput size={7} className="text-tagma-muted/50" /></BadgeSlot>);

  const cursorClass = readOnly
    ? 'cursor-pointer'
    : (isDragging ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing');

  return (
    <div
      ref={cardRef}
      data-task-card="true"
      data-task-id={`${trackId}.${task.id}`}
      className={`
        absolute border select-none flex flex-col justify-center px-2.5
        ${borderColor} ${bgColor}
        ${isDragging ? 'z-30 shadow-glow-accent' : ''}
        ${cursorClass}
      `}
      style={{
        left: x, top: y, width: w, height: h,
        transition: (isDragging || isTrackDragging) ? 'none' : 'left 100ms ease-out, top 100ms ease-out',
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (readOnly) {
          // Swallow the pointerdown so no parent pan / drag handler fires,
          // but don't call onClickRun here — we handle that in onClick so
          // the click bubbling chain up to the canvas body (which would
          // otherwise clear selection on background-click) is stopped by
          // onClick's stopPropagation, not by a side-effect of pointerdown
          // that leaves the click free to deselect us again.
          e.stopPropagation();
          return;
        }
        onPointerDown?.(task.id, e);
      }}
      onClick={(e) => {
        if (!readOnly) return;
        e.stopPropagation();
        onClickRun?.(task.id);
      }}
      onPointerUp={() => { if (!readOnly) onTargetPointerUp?.(task.id); }}
      onContextMenu={(e) => { if (!readOnly && onContextMenu) onContextMenu(task.id, e); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Connection handles — hidden in read-only mode since they are
          purely for drag-to-link interactions. */}
      {!readOnly && (
        <>
          <div className={`
            absolute -left-[4px] top-1/2 -translate-y-1/2 w-[8px] h-[8px]
            border bg-tagma-bg transition-all duration-75
            ${isEdgeTarget ? 'border-tagma-accent bg-tagma-accent scale-125' : 'border-tagma-border hover:border-tagma-accent'}
          `} />
          <div
            className="absolute -right-[4px] top-1/2 -translate-y-1/2 w-[8px] h-[8px]
              border border-tagma-border bg-tagma-bg cursor-crosshair
              hover:border-tagma-accent hover:bg-tagma-accent/20 transition-all duration-75"
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onHandlePointerDown?.(task.id, e); } }}
          />
        </>
      )}
      {/* Left indicator bar: selection (edit mode) or runtime status (run mode). */}
      {isSelected
        ? <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${isInvalid ? 'bg-tagma-error' : 'bg-tagma-accent'}`} />
        : runtimeCfg?.bar
          ? <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${runtimeCfg.bar}`} />
          : null}

      {/* ─── Row 1: Type icon · Name · Status badges · Runtime status ─── */}
      <div className="flex items-center h-[24px] gap-[6px] pointer-events-none min-w-0 overflow-hidden">
        <span className={`inline-flex items-center justify-center w-[16px] h-[16px] shrink-0
          ${isTemplate ? 'bg-purple-500/10' : isCommand ? 'bg-sky-500/10' : 'bg-tagma-muted/8'}`}>
          {isTemplate
            ? <Package size={9} className="text-purple-400" />
            : isCommand
              ? <Terminal size={9} className="text-sky-400" />
              : <MessageSquare size={9} className="text-tagma-muted/60" />}
        </span>

        <span className={`text-[10px] font-medium truncate flex-1 leading-[24px] ${isSkipped ? 'text-tagma-muted/50 line-through' : 'text-tagma-text'}`}>
          {task.name || task.id}
        </span>

        {badges.length > 0 && (
          <span className="flex items-center gap-[3px] shrink-0">
            {badges}
          </span>
        )}

        {/* Runtime status icon + duration (Run mode only). Mutually exclusive
            with the error indicator below — a task that validated cleanly
            won't be invalid while running, and an invalid task never runs. */}
        {runtimeCfg && RuntimeIcon && runtimeCfg.label && (
          <span className="flex items-center gap-[3px] shrink-0" title={runtimeCfg.label}>
            <RuntimeIcon
              size={9}
              className={`${runtimeCfg.iconColor} ${runtimeStatus === 'running' ? 'animate-spin' : ''}`}
            />
            {runtimeDurationMs != null && (
              <span className={`text-[8px] font-mono tabular-nums ${runtimeCfg.iconColor}`}>
                {formatRuntimeDuration(runtimeDurationMs)}
              </span>
            )}
          </span>
        )}
        <span
          className="inline-flex items-center justify-center w-[10px] h-[10px] shrink-0 pointer-events-auto"
          onPointerDown={(e) => {
            if (!isInvalid) return;
            // Stop the card drag from swallowing this click; dispatch a
            // focus-task event that BoardCanvas listens for and scrolls the
            // card into view. Also select the task so the panel opens.
            e.stopPropagation();
            e.preventDefault();
            const qid = `${trackId}.${task.id}`;
            window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qid }));
          }}
          style={{ cursor: isInvalid ? 'pointer' : 'default' }}
          title={isInvalid ? 'Jump to this task' : undefined}
        >
          {isInvalid && <AlertTriangle size={8} className="text-tagma-error" />}
        </span>
      </div>

      {/* ─── Row 2: Driver chip · Tier chip · Permissions (prompt/template only) ─── */}
      {!isCommand && (
        <div className="flex items-center h-[16px] gap-[4px] pointer-events-none min-w-0 overflow-hidden bg-black/20 px-[3px]">
          {driver && (
            <Chip className="bg-tagma-accent/12 text-tagma-accent/80">{driver}</Chip>
          )}
          {model && (
            <Chip className="bg-tagma-muted/12 text-tagma-muted/80 font-bold">{model}</Chip>
          )}
          {perms && (
            <span className="flex items-center h-[14px] gap-[1px] ml-auto shrink-0">
              {(['read', 'write', 'execute'] as const).map((k) => (
                <span key={k} className={`text-[7px] font-mono font-bold w-[10px] text-center leading-[14px]
                  ${k === 'read' && perms.read ? 'text-emerald-400' : ''}
                  ${k === 'write' && perms.write ? 'text-amber-400' : ''}
                  ${k === 'execute' && perms.execute ? 'text-tagma-error' : ''}
                  ${!perms[k] ? 'text-tagma-muted/20' : ''}
                `}>
                  {k[0].toUpperCase()}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {/* Hover tooltip */}
      {hovered && !isDragging && cardRef.current && (
        isInvalid && errorMessages?.length
          ? <ErrorTooltip messages={errorMessages} anchorRect={cardRef.current.getBoundingClientRect()} />
          : <TaskTooltip task={task} trackId={trackId} config={pipelineConfig} anchorRect={cardRef.current.getBoundingClientRect()} />
      )}
    </div>
  );
});
