import { useState, useRef, useEffect, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Terminal,
  MessageSquare,
  Lock,
  FileSearch,
  Clock,
  CheckCircle2,
  Layers,
  Loader2,
  Check,
  X as XIcon,
  SkipForward,
  Ban,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import type {
  PortDef,
  RawTaskConfig,
  RawPipelineConfig,
  TaskStatus,
  DiagnosticItem,
} from '../../api/client';
import { formatCommand } from '../../api/client';
import { getZoom, viewportW, viewportH } from '../../utils/zoom';
import {
  buildInferredPromptPorts,
  inputBindingsToPorts,
  outputBindingsToPorts,
} from '../../utils/ports';
import { isCommandTaskConfig } from '@tagma/types';
import { usePipelineStore } from '../../store/pipeline-store';
import { findSavedTask, isTaskModified } from '../../utils/dirty-tracking';

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
  errorMessages?: DiagnosticItem[];
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
   * Resolved input port values for the current run (from SDK
   * task_update events via the run-event-reducer). Keyed by port name.
   * Rendered in the hover tooltip so users can inspect what the task
   * actually received without re-reading the log file. Null when no
   * run is active or the engine hasn't produced an update yet.
   */
  runtimeInputs?: Readonly<Record<string, unknown>> | null;
  /** Extracted output port values — see runtimeInputs for the contract. */
  runtimeOutputs?: Readonly<Record<string, unknown>> | null;
  /**
   * Click handler used by Run view. Only fired when `readOnly` is true;
   * in edit mode the primary interaction is drag, so clicks are routed
   * through `onPointerDown` instead.
   */
  onClickRun?: (taskId: string) => void;
}

const RUNTIME_CFG: Record<
  TaskStatus,
  { bar: string; bg: string; icon: typeof Check; iconColor: string; label: string }
> = {
  idle: { bar: '', bg: '', icon: Clock, iconColor: '', label: '' },
  waiting: {
    bar: 'bg-tagma-muted/50',
    bg: '',
    icon: Clock,
    iconColor: 'text-tagma-muted/60',
    label: 'waiting',
  },
  running: {
    bar: 'bg-tagma-ready',
    bg: 'bg-tagma-ready/8',
    icon: Loader2,
    iconColor: 'text-tagma-ready',
    label: 'running',
  },
  success: {
    bar: 'bg-tagma-success',
    bg: 'bg-tagma-success/8',
    icon: Check,
    iconColor: 'text-tagma-success',
    label: 'done',
  },
  failed: {
    bar: 'bg-tagma-error',
    bg: 'bg-tagma-error/8',
    icon: XIcon,
    iconColor: 'text-tagma-error',
    label: 'failed',
  },
  timeout: {
    bar: 'bg-tagma-warning',
    bg: 'bg-tagma-warning/8',
    icon: Clock,
    iconColor: 'text-tagma-warning',
    label: 'timeout',
  },
  skipped: {
    bar: 'bg-tagma-muted/40',
    bg: '',
    icon: SkipForward,
    iconColor: 'text-tagma-muted/50',
    label: 'skipped',
  },
  blocked: {
    bar: 'bg-tagma-warning',
    bg: 'bg-tagma-warning/8',
    icon: Ban,
    iconColor: 'text-tagma-warning',
    label: 'blocked',
  },
};

function formatRuntimeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveField<K extends 'driver' | 'model'>(
  task: RawTaskConfig,
  trackId: string,
  config: RawPipelineConfig,
  field: K,
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
    <span
      className={`inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden ${className}`}
    >
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
function ErrorTooltip({
  messages,
  anchorRect,
}: {
  messages: DiagnosticItem[];
  anchorRect: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const hasError = messages.some((m) => m.severity === 'error');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = getZoom();
    const gap = 8,
      margin = 8;
    const vw = viewportW(),
      vh = viewportH();
    const tW = el.getBoundingClientRect().width / z;
    const tH = el.getBoundingClientRect().height / z;
    const aL = anchorRect.left / z,
      aT = anchorRect.top / z;
    const aW = anchorRect.width / z,
      aB = anchorRect.bottom / z;

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
      className={`fixed pointer-events-none bg-tagma-surface shadow-lg ${hasError ? 'border border-tagma-error/40' : 'border border-tagma-warning/40'}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: 260,
        maxHeight: viewportH() - 16,
        overflow: 'hidden',
        zIndex: 9999,
        opacity: pos && visible ? 1 : 0,
        transition: 'opacity 150ms ease-out',
      }}
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
    </div>,
    document.body,
  );
}

/**
 * Render one line inside a port summary block.
 *
 * When a run is active and the engine has echoed back the resolved
 * value for this port, the user wants to see the value — the declared
 * type/description is static and already visible in the panel. When
 * no value is available we fall back to the contract.
 */
function formatPortForTooltip(
  port: PortDef,
  runtimeValues: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const hasRuntime = runtimeValues && port.name in runtimeValues;
  if (hasRuntime) {
    const v = runtimeValues![port.name];
    const rendered = renderRuntimePortValue(v);
    return `${port.name} = ${rendered}`;
  }
  const enumPart =
    port.type === 'enum' && port.enum?.length ? `(${port.enum.join('|')})` : port.type;
  const descrPart = port.description ? ` — ${port.description}` : '';
  return `${port.name}: ${enumPart}${descrPart}`;
}

/**
 * Cap rendered values at ~4 tooltip lines worth of characters before
 * the CSS line-clamp takes over. Prevents pathological JSON blobs from
 * forcing the browser to lay out thousands of glyphs we'd never show.
 */
const PORT_VALUE_MAX_CHARS = 240;

function renderRuntimePortValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') {
    const s =
      value.length > PORT_VALUE_MAX_CHARS ? value.slice(0, PORT_VALUE_MAX_CHARS) + '…' : value;
    return JSON.stringify(s);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > PORT_VALUE_MAX_CHARS ? s.slice(0, PORT_VALUE_MAX_CHARS) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}

/* ── Config Tooltip ── */
function TaskTooltip({
  task,
  trackId,
  config,
  anchorRect,
  runtimeInputs,
  runtimeOutputs,
}: {
  task: RawTaskConfig;
  trackId: string;
  config: RawPipelineConfig;
  anchorRect: DOMRect;
  runtimeInputs?: Readonly<Record<string, unknown>> | null;
  runtimeOutputs?: Readonly<Record<string, unknown>> | null;
}) {
  const driver = resolveField(task, trackId, config, 'driver');
  const model = resolveField(task, trackId, config, 'model');
  const track = config.tracks.find((t) => t.id === trackId);
  const perms = task.permissions ?? track?.permissions;

  const isCmd = isCommandTaskConfig(task);
  // Row values are usually a single string. Inputs/Outputs use an array
  // so each port becomes its own clamp-able block in the rendered list
  // (each port gets up to 4 lines before being truncated).
  const rows: [string, string | string[]][] = [];
  // AI-specific fields only for prompt tasks
  if (!isCmd && driver) rows.push(['Driver', driver]);
  if (!isCmd && model) rows.push(['Model', model]);
  if (!isCmd && perms) {
    const parts = [perms.read && 'Read', perms.write && 'Write', perms.execute && 'Execute'].filter(
      Boolean,
    );
    if (parts.length) rows.push(['Permissions', parts.join(', ')]);
  }
  if (task.timeout) rows.push(['Timeout', task.timeout]);
  if (task.trigger)
    rows.push([
      'Trigger',
      `${task.trigger.type}${task.trigger.message ? ` — ${task.trigger.message}` : ''}`,
    ]);
  if (task.completion) rows.push(['Completion', task.completion.type]);
  if (task.middlewares?.length)
    rows.push(['Middleware', task.middlewares.map((m) => m.type).join(', ')]);
  if (task.continue_from) rows.push(['Continue', task.continue_from]);
  if (task.cwd) rows.push(['CWD', task.cwd]);
  if (!isCmd && task.agent_profile) rows.push(['Profile', task.agent_profile]);

  // Port summary: for each port, prefer showing the live resolved
  // runtime value when a run is active; fall back to the port's
  // type/description so editors can see what the contract is before a
  // run has ever happened.
  //
  // Prompt Tasks have no declared bindings — their I/O is inferred from
  // direct-neighbor Commands (matches the engine's runtime view). The
  // tooltip uses the same inference helper the Task Inspector uses so
  // the two views never drift.
  let inputs: readonly PortDef[] = inputBindingsToPorts(task.inputs);
  let outputs: readonly PortDef[] = outputBindingsToPorts(task.outputs);
  if (!isCmd) {
    const qid = `${trackId}.${task.id}`;
    const inferred = buildInferredPromptPorts(config, qid);
    // `inferPromptPorts` returns SDK-flavoured `PortDef` with readonly
    // enum arrays; the editor's mirror type has mutable enum arrays.
    // Structurally identical for the read-only tooltip use case, so
    // cast through the narrow shape each side needs.
    inputs = (inferred.ports.inputs ?? []) as unknown as readonly PortDef[];
    outputs = (inferred.ports.outputs ?? []) as unknown as readonly PortDef[];
  }
  if (inputs.length > 0) {
    rows.push(['Inputs', inputs.map((p) => formatPortForTooltip(p, runtimeInputs))]);
  }
  if (outputs.length > 0) {
    rows.push(['Outputs', outputs.map((p) => formatPortForTooltip(p, runtimeOutputs))]);
  }

  if (task.prompt)
    rows.push(['Prompt', task.prompt.length > 60 ? task.prompt.slice(0, 60) + '…' : task.prompt]);
  if (task.command) {
    const label = formatCommand(task.command);
    rows.push(['Command', label.length > 60 ? label.slice(0, 60) + '…' : label]);
  }

  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const z = getZoom();
    const gap = 6,
      margin = 8;
    const vw = viewportW(),
      vh = viewportH();
    const tW = el.getBoundingClientRect().width / z;
    const tH = el.getBoundingClientRect().height / z;
    const aL = anchorRect.left / z,
      aT = anchorRect.top / z;
    const aW = anchorRect.width / z,
      aB = anchorRect.bottom / z;

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
      className="fixed pointer-events-none bg-tagma-surface border border-tagma-border shadow-lg animate-fade-in"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: 260,
        maxHeight: viewportH() - 16,
        overflow: 'hidden',
        zIndex: 9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <div className="px-3 py-1.5 text-[10px] font-semibold text-tagma-text truncate border-b border-tagma-border">
        {task.name || task.id}
      </div>
      <div className="px-3 py-1.5">
        {rows.map(([label, value]) => {
          // Inputs/Outputs come through as string[] — render each port as
          // its own block so wrapping/clamping is per-port, not for the
          // whole list. Each port gets up to 4 lines before ellipsis
          // (CSS line-clamp on a -webkit-box). Single-string rows keep
          // the original compact truncated layout.
          if (Array.isArray(value)) {
            return (
              <div key={label} className="flex py-[1.5px] text-[9px] font-mono gap-2 min-w-0">
                <span className="text-tagma-muted/70 w-[72px] shrink-0 truncate">{label}</span>
                <div className="text-tagma-text/80 min-w-0 flex-1 space-y-1">
                  {value.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-words line-clamp-4">
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <div key={label} className="flex py-[1.5px] text-[9px] font-mono gap-2 min-w-0">
              <span className="text-tagma-muted/70 w-[72px] shrink-0 truncate">{label}</span>
              <span className="text-tagma-text/80 truncate min-w-0 flex-1">{value}</span>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/* ── Main ── */
export const TaskCard = memo(function TaskCard({
  task,
  trackId,
  pipelineConfig,
  x,
  y,
  w,
  h,
  isSelected,
  isInvalid,
  errorMessages,
  isDragging,
  isTrackDragging,
  isEdgeTarget,
  onPointerDown,
  onHandlePointerDown,
  onTargetPointerUp,
  onContextMenu,
  readOnly = false,
  runtimeStatus,
  runtimeDurationMs,
  runtimeInputs,
  runtimeOutputs,
  onClickRun,
}: TaskCardProps) {
  const [hovered, setHovered] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const isCommand = isCommandTaskConfig(task);
  // Per-task dirty flag for the on-canvas MODIFIED chip. We subscribe to
  // savedConfig directly here (rather than threading it through every
  // TaskCard prop) so the canvas integration stays a one-line change.
  // memo() still applies — savedConfig only swaps on save/load, so cards
  // re-render only when the diff state actually changes.
  const savedConfig = usePipelineStore((s) => s.savedConfig);
  const savedTask = findSavedTask(savedConfig, trackId, task.id);
  const taskIsModified = !readOnly && isTaskModified(savedTask, task);

  const handleMouseEnter = () => {
    hoverTimerRef.current = window.setTimeout(() => setHovered(true), 150);
  };
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHovered(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

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
  const hasWarningOnly = !isInvalid && !!errorMessages?.some((d) => d.severity === 'warning');

  const borderColor = isDragging
    ? 'border-tagma-accent'
    : isInvalid
      ? 'border-tagma-error/60'
      : hasWarningOnly
        ? 'border-tagma-warning/50'
        : isSelected
          ? 'border-tagma-accent'
          : isEdgeTarget
            ? 'border-tagma-accent/60'
            : 'border-tagma-border/70';

  // Selected state keeps the opaque `bg-tagma-elevated` so the canvas
  // grid behind it doesn't bleed through — the accent border + left
  // indicator bar already signal selection strongly enough. Transient
  // states (dragging, invalid, edge-target) stay translucent because
  // they're short-lived and the bleed-through is visually expected.
  const bgColor = isDragging
    ? 'bg-tagma-accent/10'
    : isInvalid
      ? 'bg-tagma-error/8'
      : hasWarningOnly
        ? 'bg-tagma-warning/8'
        : isSelected
          ? 'bg-tagma-elevated'
          : isEdgeTarget
            ? 'bg-tagma-accent/4'
            : runtimeCfg?.bg
              ? runtimeCfg.bg
              : 'bg-tagma-elevated hover:bg-tagma-elevated/80';

  // Status indicators — each wrapped in a fixed 10x10 slot so badges
  // land on the same horizontal grid regardless of which icons appear.
  const BadgeSlot = ({ children }: { children: React.ReactNode }) => (
    <span className="inline-flex items-center justify-center w-[10px] h-[10px] shrink-0">
      {children}
    </span>
  );
  const badges: React.ReactNode[] = [];
  // Surface a per-node MODIFIED chip for tasks whose config drifted from
  // the on-disk baseline since the last save. Suppressed in `readOnly`
  // (Run mode) — there's no edit going on, so the badge would be noise.
  if (!readOnly && taskIsModified) {
    badges.push(
      <span
        key="modified"
        title="Unsaved change since last save"
        className="inline-block h-[14px] px-[3px] bg-tagma-warning/15 text-tagma-warning/90 shrink-0 leading-[14px] text-[8px] font-mono font-bold tabular-nums whitespace-nowrap uppercase tracking-wider"
      >
        mod
      </span>,
    );
  }
  if (task.trigger) {
    const I = task.trigger.type === 'file' ? FileSearch : Lock;
    badges.push(
      <BadgeSlot key="trg">
        <I size={7} className="text-tagma-warning/80" />
      </BadgeSlot>,
    );
  }
  if (task.timeout)
    badges.push(
      <BadgeSlot key="to">
        <Clock size={7} className="text-tagma-ready/70" />
      </BadgeSlot>,
    );
  if (task.completion)
    badges.push(
      <BadgeSlot key="ck">
        <CheckCircle2 size={7} className="text-tagma-success/70" />
      </BadgeSlot>,
    );
  if (task.middlewares?.length)
    badges.push(
      <BadgeSlot key="mw">
        <Layers size={7} className="text-tagma-info/70" />
      </BadgeSlot>,
    );
  // Badge counter: for Prompt tasks, count inferred bindings so the badge
  // reflects what the runtime will see — otherwise a Prompt would
  // always show "0/0" even when it has real I/O through neighbors.
  const portSummary = (() => {
    if (isCommand) {
      return {
        inputCount: Object.keys(task.inputs ?? {}).length,
        outputCount: Object.keys(task.outputs ?? {}).length,
      };
    }
    const inferred = buildInferredPromptPorts(pipelineConfig, `${trackId}.${task.id}`);
    return {
      inputCount: inferred.ports.inputs?.length ?? 0,
      outputCount: inferred.ports.outputs?.length ?? 0,
    };
  })();
  const { inputCount, outputCount } = portSummary;
  if (inputCount > 0) {
    badges.push(
      <span
        key="port-in"
        className="inline-block h-[14px] px-[3px] bg-tagma-info/12 text-tagma-info/90 shrink-0 leading-[14px] text-[8px] font-mono font-bold tabular-nums whitespace-nowrap"
        title={`${inputCount} input port${inputCount !== 1 ? 's' : ''}`}
      >
        <ArrowDownToLine size={8} strokeWidth={2.5} className="inline-block align-middle" />
        <span className="inline-block align-middle ml-[2px]">{inputCount}</span>
      </span>,
    );
  }
  if (outputCount > 0) {
    badges.push(
      <span
        key="port-out"
        className="inline-block h-[14px] px-[3px] bg-tagma-accent/12 text-tagma-accent/90 shrink-0 leading-[14px] text-[8px] font-mono font-bold tabular-nums whitespace-nowrap"
        title={`${outputCount} output port${outputCount !== 1 ? 's' : ''}`}
      >
        <span className="inline-block align-middle mr-[2px]">{outputCount}</span>
        <ArrowUpFromLine size={8} strokeWidth={2.5} className="inline-block align-middle" />
      </span>,
    );
  }

  const cursorClass = readOnly
    ? 'cursor-pointer'
    : isDragging
      ? 'cursor-grabbing'
      : 'cursor-grab active:cursor-grabbing';

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
        left: x,
        top: y,
        width: w,
        height: h,
        transition:
          isDragging || isTrackDragging ? 'none' : 'left 100ms ease-out, top 100ms ease-out',
      }}
      onMouseDown={(e) => {
        // In read-only mode the parent canvas also listens for
        // mousedown to start a pan drag. Pointer events and mouse
        // events are dispatched independently — stopPropagation on
        // pointerdown does NOT suppress mousedown — so without this
        // handler, clicking a task in Run/History would pan the
        // canvas and make the task appear draggable.
        if (readOnly && e.button === 0) e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (readOnly) {
          e.stopPropagation();
          return;
        }
        onPointerDown?.(`${trackId}.${task.id}`, e);
      }}
      onClick={(e) => {
        if (!readOnly) return;
        e.stopPropagation();
        onClickRun?.(`${trackId}.${task.id}`);
      }}
      onPointerUp={() => {
        if (!readOnly) onTargetPointerUp?.(`${trackId}.${task.id}`);
      }}
      onContextMenu={(e) => {
        if (!readOnly && onContextMenu) onContextMenu(`${trackId}.${task.id}`, e);
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Connection handles — hidden in read-only mode since they are
          purely for drag-to-link interactions. A larger invisible hit area
          (16x16) wraps the 8x8 visual dot so the target is easier to grab. */}
      {!readOnly && (
        <>
          <div className="absolute -left-[8px] top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center">
            <div
              className={`w-2 h-2 border bg-tagma-bg transition-all duration-75
              ${isEdgeTarget ? 'border-tagma-accent bg-tagma-accent scale-125' : 'border-tagma-border hover:border-tagma-accent'}
            `}
            />
          </div>
          <div
            className="absolute -right-[8px] top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center cursor-crosshair"
            onPointerDown={(e) => {
              if (e.button === 0) {
                e.stopPropagation();
                onHandlePointerDown?.(`${trackId}.${task.id}`, e);
              }
            }}
          >
            <div
              className="w-2 h-2 border border-tagma-border bg-tagma-bg
                hover:border-tagma-accent hover:bg-tagma-accent/20 transition-all duration-75"
            />
          </div>
        </>
      )}
      {/* Left indicator bar: selection (edit mode) or runtime status (run mode). */}
      {isSelected ? (
        <div
          className={`absolute left-0 top-0 bottom-0 w-[2px] ${isInvalid ? 'bg-tagma-error' : hasWarningOnly ? 'bg-tagma-warning' : 'bg-tagma-accent'}`}
        />
      ) : runtimeCfg?.bar ? (
        <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${runtimeCfg.bar}`} />
      ) : null}

      {/* ─── Row 1: Type icon · Name · Status badges · Runtime status ─── */}
      <div className="flex items-center h-[24px] gap-[6px] pointer-events-none min-w-0 overflow-hidden">
        <span
          className={`inline-flex items-center justify-center w-[16px] h-[16px] shrink-0
          ${isCommand ? 'bg-tagma-ready/10' : 'bg-tagma-muted/8'}`}
        >
          {isCommand ? (
            <Terminal size={9} className="text-tagma-ready" />
          ) : (
            <MessageSquare size={9} className="text-tagma-muted/60" />
          )}
        </span>

        <span
          className={`text-[10px] font-medium truncate flex-1 leading-[24px] ${isSkipped ? 'text-tagma-muted/50 line-through' : 'text-tagma-text'}`}
        >
          {task.name || task.id}
        </span>

        {badges.length > 0 && (
          <span className="flex items-center gap-[3px] shrink-0">{badges}</span>
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
            if (!isInvalid && !hasWarningOnly) return;
            // Stop the card drag from swallowing this click; dispatch a
            // focus-task event that BoardCanvas listens for and scrolls the
            // card into view. Also select the task so the panel opens.
            e.stopPropagation();
            e.preventDefault();
            const qid = `${trackId}.${task.id}`;
            window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qid }));
          }}
          style={{ cursor: isInvalid || hasWarningOnly ? 'pointer' : 'default' }}
          title={
            isInvalid ? 'Validation errors' : hasWarningOnly ? 'Validation warnings' : undefined
          }
        >
          {isInvalid ? (
            <AlertTriangle size={8} className="text-tagma-error" />
          ) : hasWarningOnly ? (
            <AlertTriangle size={8} className="text-tagma-warning" />
          ) : null}
        </span>
      </div>

      {/* ─── Row 2: Driver chip · Tier chip · Permissions (prompt only) ─── */}
      {!isCommand && (
        <div className="tagma-rail flex items-center h-[16px] gap-[4px] pointer-events-none min-w-0 overflow-hidden px-[3px]">
          {driver && <Chip className="bg-tagma-accent/12 text-tagma-accent/80">{driver}</Chip>}
          {model && (
            <Chip className="bg-tagma-muted/12 text-tagma-muted/80 font-bold">{model}</Chip>
          )}
          {perms && (
            <span className="flex items-center h-[14px] gap-[1px] ml-auto shrink-0">
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
        </div>
      )}

      {/* Hover tooltip */}
      {hovered &&
        !isDragging &&
        cardRef.current &&
        ((isInvalid || hasWarningOnly) && errorMessages?.length ? (
          <ErrorTooltip
            messages={errorMessages}
            anchorRect={cardRef.current.getBoundingClientRect()}
          />
        ) : (
          <TaskTooltip
            task={task}
            trackId={trackId}
            config={pipelineConfig}
            anchorRect={cardRef.current.getBoundingClientRect()}
            runtimeInputs={runtimeInputs}
            runtimeOutputs={runtimeOutputs}
          />
        ))}
    </div>
  );
});
