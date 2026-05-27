import { useMemo, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Clock,
  Check,
  AlertCircle,
  Loader2,
  SkipForward,
  Ban,
  FileText,
  ExternalLink,
  Hash,
  Link2,
  Lock,
  FileSearch,
  CheckCircle2,
  Layers,
  Terminal,
  MessageSquare,
  Activity,
} from 'lucide-react';
import type {
  RunTaskState,
  TaskStatus,
  RawPipelineConfig,
  RawTaskConfig,
  RawTrackConfig,
  Permissions,
  TaskLogLevel,
} from '../../api/client';
import { api, formatCommand } from '../../api/client';
import { TASK_LOG_CAP } from '../../store/run-event-reducer';
import { useChatStore } from '../../store/chat-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { formatTaskErrorAttachment } from '../../utils/format-error-prompt';
import { CopyButton } from './CopyButton';
import { MissingBinaryHelp } from './MissingBinaryHelp';
import { JsonOutputView } from './JsonOutputView';

interface RunTaskPanelProps {
  task: RunTaskState;
  config: RawPipelineConfig;
  onClose: () => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  idle: 'Idle',
  waiting: 'Waiting',
  running: 'Running',
  success: 'Success',
  failed: 'Failed',
  timeout: 'Timeout',
  skipped: 'Skipped',
  blocked: 'Blocked',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// Color-code process log lines by severity. Debug/section/quiet are the
// common "verbose diagnostics" levels and share a muted tone so the eye is
// drawn to info/warn/error transitions.
const LOG_LEVEL_COLOR: Record<TaskLogLevel, string> = {
  info: 'text-tagma-text/80',
  warn: 'text-tagma-warning/90',
  error: 'text-tagma-error/90',
  debug: 'text-tagma-muted/70',
  section: 'text-tagma-accent/80',
  quiet: 'text-tagma-muted/60',
};

function resolveTask(
  task: RunTaskState,
  config: RawPipelineConfig,
): { track: RawTrackConfig; taskConfig: RawTaskConfig } | null {
  const [trackId, ...rest] = task.taskId.split('.');
  const taskId = rest.join('.');
  const track = config.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const taskConfig = track.tasks.find((t) => t.id === taskId);
  if (!taskConfig) return null;
  return { track, taskConfig };
}

function permsLabel(perms: Permissions | undefined | null): string | null {
  if (!perms) return null;
  const parts: string[] = [];
  if (perms.read) parts.push('R');
  if (perms.write) parts.push('W');
  if (perms.execute) parts.push('X');
  return parts.length ? parts.join('+') : null;
}

const ASK_CHAT_TASK_STATUSES = new Set<TaskStatus>(['failed', 'timeout', 'blocked']);

export function canAskChatForTaskError(
  task: Pick<RunTaskState, 'status' | 'stderr' | 'stderrPath'>,
): boolean {
  return (
    ASK_CHAT_TASK_STATUSES.has(task.status) || task.stderr.trim().length > 0 || !!task.stderrPath
  );
}

export async function openTaskOutputPath(
  path: string | null,
  opts: {
    reveal: (path: string) => Promise<unknown>;
    onError: (message: string) => void;
  },
): Promise<void> {
  if (!path) return;
  try {
    await opts.reveal(path);
  } catch (err) {
    opts.onError(err instanceof Error ? err.message : String(err));
  }
}

// Shared <pre> styling for the Output / Normalized Output panes. Hoisted so
// the JSON-formatted view and its plain fallback stay byte-for-byte visually
// identical to how these panes rendered before this feature.
const OUTPUT_PRE_CLASS =
  'select-text text-[10px] font-mono text-tagma-text bg-tagma-bg border border-tagma-border px-2.5 py-2 overflow-auto max-h-[300px] whitespace-pre-wrap break-words';
const NORMALIZED_PRE_CLASS =
  'select-text text-[10px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-2 overflow-auto max-h-[200px] whitespace-pre-wrap break-words';

/**
 * Whether the Output pane should swap the plain <pre> for the pretty/raw
 * JSON view. Prompt (AI) tasks only — a command task's stdout is shell
 * logs, not JSON — and only once terminal: while running, stdout is an
 * incomplete stream that won't parse, and the live tail-follow <pre> must
 * keep ownership of auto-scroll. (`JsonOutputView` still falls back to a
 * plain <pre> when a finished prompt task's stdout isn't actually JSON.)
 */
export function shouldFormatTaskOutput(
  task: Pick<RunTaskState, 'status'>,
  isCommand: boolean,
): boolean {
  return !isCommand && task.status !== 'running';
}

/** Compact key/value row used throughout the read-only config section. */
function ConfigRow({
  label,
  children,
  mono = true,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 py-[2px] text-[10px]">
      <span
        className="text-tagma-muted/70 w-[68px] shrink-0 font-mono tracking-tight truncate"
        title={label}
      >
        {label}
      </span>
      <span className={`flex-1 min-w-0 break-words ${mono ? 'font-mono' : ''} text-tagma-text/80`}>
        {children}
      </span>
    </div>
  );
}

export function RunTaskPanel({ task, config, onClose }: RunTaskPanelProps) {
  const resolved = useMemo(() => resolveTask(task, config), [task, config]);
  const taskConfig = resolved?.taskConfig;
  const track = resolved?.track;

  // Auto-scroll the process log pane to the bottom when new lines arrive so
  // the user always sees the latest state without having to scroll manually.
  // Skip the scroll-follow when the user has scrolled up — that's a signal
  // they want to read earlier lines and we shouldn't yank them back.
  const logRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (!el || !followTailRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [task.logs.length]);
  const handleLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    // "Near bottom" tolerance — account for fractional pixels under HiDPI.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    followTailRef.current = nearBottom;
  };

  // Same tail-follow behaviour for the stdout pane, but only while the task
  // is still running — that's when `task.stdout` grows incrementally from
  // the live `task_output` stream. Once terminal it's a static tail and
  // yanking the user's scroll position would be hostile.
  const stdoutRef = useRef<HTMLPreElement>(null);
  const stdoutFollowRef = useRef(true);
  useEffect(() => {
    const el = stdoutRef.current;
    if (!el || task.status !== 'running' || !stdoutFollowRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [task.stdout, task.status]);
  const handleStdoutScroll = () => {
    const el = stdoutRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    stdoutFollowRef.current = nearBottom;
  };

  const isCommand = !!taskConfig?.command;

  // Fallback-aware resolution for runtime-relevant fields: prefer the
  // authoritative values emitted by the SDK (when present on RunTaskState),
  // then the raw snapshot's task-level value, then the track-level value,
  // then the pipeline default.
  const driver =
    task.resolvedDriver ?? taskConfig?.driver ?? track?.driver ?? config.driver ?? null;
  const model = task.resolvedModel ?? taskConfig?.model ?? track?.model ?? config.model ?? null;
  const permissions =
    task.resolvedPermissions ?? taskConfig?.permissions ?? track?.permissions ?? null;
  const cwd = taskConfig?.cwd ?? track?.cwd ?? null;
  const agentProfile = taskConfig?.agent_profile ?? track?.agent_profile ?? null;
  const timeout = taskConfig?.timeout ?? null;

  const promptBody = taskConfig?.prompt?.trim();
  const commandBody = formatCommand(taskConfig?.command).trim();

  const handleOpenPath = (path: string | null) => {
    void openTaskOutputPath(path, {
      reveal: api.reveal,
      onError: (message) =>
        usePipelineStore.setState({
          errorMessage: `Failed to open output file: ${message}`,
        }),
    });
  };
  const canAskChat = canAskChatForTaskError(task);
  const handleAskChatForTaskError = useCallback(() => {
    useChatStore.getState().attachErrorContext(formatTaskErrorAttachment(task, config));
  }, [task, config]);

  return (
    <div className="w-80 h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
      <div className="panel-header-sm">
        <h2 className="panel-title-sm truncate">{task.taskName}</h2>
        <button
          onClick={onClose}
          className="p-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* ─── Section 1: Runtime state ─── */}
        <section>
          <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
            Runtime
          </div>
          <div className="pt-2.5 space-y-3">
            {/* Task ID */}
            <div>
              <label className="field-label">Task ID</label>
              <div className="flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5">
                <span className="flex-1 min-w-0 truncate select-text" title={task.taskId}>
                  {task.taskId}
                </span>
                <CopyButton value={task.taskId} title="Copy task ID" />
              </div>
            </div>

            {/* Status */}
            <div>
              <label className="field-label">Status</label>
              <div
                className={`chip-md ${
                  task.status === 'running'
                    ? 'bg-tagma-ready/10 border-tagma-ready/20 text-tagma-ready'
                    : task.status === 'success'
                      ? 'bg-tagma-success/10 border-tagma-success/20 text-tagma-success'
                      : task.status === 'failed'
                        ? 'bg-tagma-error/10 border-tagma-error/20 text-tagma-error'
                        : task.status === 'timeout'
                          ? 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning'
                          : task.status === 'blocked'
                            ? 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning'
                            : 'bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted'
                }`}
              >
                {task.status === 'running' && <Loader2 size={11} className="animate-spin" />}
                {task.status === 'success' && <Check size={11} />}
                {task.status === 'failed' && <AlertCircle size={11} />}
                {task.status === 'timeout' && <Clock size={11} />}
                {task.status === 'skipped' && <SkipForward size={11} />}
                {task.status === 'blocked' && <Ban size={11} />}
                {STATUS_LABEL[task.status]}
              </div>
            </div>

            {/* Timing */}
            {task.startedAt && (
              <div>
                <label className="field-label">Started</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {new Date(task.startedAt).toLocaleTimeString()}
                </div>
              </div>
            )}
            {task.finishedAt && (
              <div>
                <label className="field-label">Finished</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {new Date(task.finishedAt).toLocaleTimeString()}
                </div>
              </div>
            )}
            {task.durationMs != null && (
              <div>
                <label className="field-label">Duration</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {formatDuration(task.durationMs)}
                </div>
              </div>
            )}

            {/* Exit code */}
            {task.exitCode != null && (
              <div>
                <label className="field-label">Exit Code</label>
                <div
                  className={`text-[11px] font-mono ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}
                >
                  {task.exitCode}
                </div>
              </div>
            )}

            {/* Session id (for drivers that support session resume) */}
            {task.sessionId && (
              <div>
                <label className="field-label flex items-center gap-1">
                  <Hash size={9} /> Session
                </label>
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5">
                  <span className="flex-1 min-w-0 truncate select-text" title={task.sessionId}>
                    {task.sessionId}
                  </span>
                  <CopyButton value={task.sessionId} title="Copy session ID" />
                </div>
              </div>
            )}

            {/* Log file paths — the inline panes below are only a bounded
                tail; these open the complete streams on disk. */}
            {task.stdoutPath && (
              <div>
                <label className="field-label flex items-center gap-1">
                  <FileText size={9} /> Output file
                </label>
                <button
                  type="button"
                  onClick={() => handleOpenPath(task.stdoutPath)}
                  className="w-full flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text bg-tagma-bg border border-tagma-border hover:border-tagma-accent px-2.5 py-1.5 truncate transition-colors"
                >
                  <ExternalLink size={9} className="shrink-0" />
                  <span className="truncate">{task.stdoutPath}</span>
                </button>
              </div>
            )}
            {task.stderrPath && (
              <div>
                <label className="field-label flex items-center gap-1">
                  <FileText size={9} /> Error file
                </label>
                <button
                  type="button"
                  onClick={() => handleOpenPath(task.stderrPath)}
                  className="w-full flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text bg-tagma-bg border border-tagma-border hover:border-tagma-accent px-2.5 py-1.5 truncate transition-colors"
                >
                  <ExternalLink size={9} className="shrink-0" />
                  <span className="truncate">{task.stderrPath}</span>
                </button>
              </div>
            )}

            {/* Stdout — streams live while the task is running (the engine
                emits task_output chunks before the process exits), then
                settles to the canonical disk-backed tail on completion. */}
            {(task.stdout || task.status === 'running') &&
              (shouldFormatTaskOutput(task, isCommand) && task.stdout ? (
                // Finished prompt task: pretty/raw JSON view (falls back to a
                // plain <pre> internally when stdout isn't actually JSON).
                <JsonOutputView label="Output" raw={task.stdout} preClassName={OUTPUT_PRE_CLASS} />
              ) : (
                // Command tasks and still-running tasks: unchanged plain pane.
                // The running branch keeps the tail-follow ref so live
                // stdout auto-scrolls exactly as before.
                <div>
                  <label className="field-label flex items-center gap-1.5">
                    <span>Output</span>
                    {task.status === 'running' && (
                      <span className="inline-flex items-center gap-1 text-tagma-ready normal-case">
                        <span className="w-1.5 h-1.5 rounded-full bg-tagma-ready animate-pulse" />
                        <span className="text-[9px] font-mono uppercase tracking-wider">live</span>
                      </span>
                    )}
                  </label>
                  {task.stdout ? (
                    <pre ref={stdoutRef} onScroll={handleStdoutScroll} className={OUTPUT_PRE_CLASS}>
                      {task.stdout}
                    </pre>
                  ) : (
                    <div className="text-[10px] font-mono text-tagma-muted/60 bg-tagma-bg border border-tagma-border px-2.5 py-2">
                      Waiting for output…
                    </div>
                  )}
                </div>
              ))}

            {/* Missing CLI install hints — surfaced above stderr because the
                raw ENOENT line below is opaque, and the install table is the
                actionable thing the user actually wants. */}
            {task.failureKind === 'binary_missing' && task.missingBinary && (
              <MissingBinaryHelp binary={task.missingBinary} />
            )}

            {/* Stderr */}
            {task.stderr && (
              <div>
                <label className="field-label">Errors</label>
                <pre className="select-text text-[10px] font-mono text-tagma-error/80 bg-tagma-error/5 border border-tagma-error/20 px-2.5 py-2 overflow-auto max-h-[200px] whitespace-pre-wrap break-words">
                  {task.stderr}
                </pre>
              </div>
            )}

            {canAskChat && (
              <button
                type="button"
                onClick={handleAskChatForTaskError}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium text-tagma-accent border border-tagma-accent/30 hover:bg-tagma-accent/10 px-2.5 py-1.5 transition-colors"
                title="Ask AI to fix this task error"
              >
                <MessageSquare size={11} />
                <span>Ask AI</span>
              </button>
            )}

            {/* Normalized output (when SDK-normalized — e.g. AI-parsed JSON) */}
            {task.normalizedOutput &&
              (!isCommand ? (
                <JsonOutputView
                  label="Normalized Output"
                  raw={task.normalizedOutput}
                  preClassName={NORMALIZED_PRE_CLASS}
                />
              ) : (
                <div>
                  <label className="field-label">Normalized Output</label>
                  <pre className={NORMALIZED_PRE_CLASS}>{task.normalizedOutput}</pre>
                </div>
              ))}
          </div>
        </section>

        {/* ─── Section 2: Process log (live stream from SDK Logger) ─── */}
        {task.logs.length > 0 && (
          <section>
            <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40 flex items-center gap-1.5">
              <Activity size={9} />
              <span>Process</span>
              <span className="text-tagma-muted/40 font-normal normal-case tracking-normal">
                (
                {task.totalLogCount > task.logs.length
                  ? `${task.logs.length} of ${task.totalLogCount} lines — oldest truncated`
                  : `${task.logs.length} lines`}
                )
              </span>
              {task.totalLogCount > TASK_LOG_CAP && (
                <span className="text-tagma-warning/70 font-normal normal-case tracking-normal ml-1">
                  (capped at {TASK_LOG_CAP})
                </span>
              )}
            </div>
            <div
              ref={logRef}
              onScroll={handleLogScroll}
              className="select-text mt-2 text-[10px] font-mono bg-tagma-bg border border-tagma-border max-h-[320px] overflow-auto"
            >
              {task.logs.map((line, i) => (
                <div
                  key={i}
                  className={`px-2.5 py-[2px] whitespace-pre-wrap break-words leading-snug ${LOG_LEVEL_COLOR[line.level]}`}
                >
                  {line.text}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ─── Section 3: Task configuration (read-only snapshot) ─── */}
        {taskConfig && (
          <section>
            <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
              Configuration (read-only)
            </div>
            <div className="pt-2.5 space-y-3">
              {/* Type banner */}
              <div className="flex items-center gap-2 text-[10px] text-tagma-muted">
                {isCommand ? (
                  <>
                    <Terminal size={11} className="text-tagma-ready" /> Shell command
                  </>
                ) : (
                  <>
                    <MessageSquare size={11} className="text-tagma-muted/70" /> AI prompt
                  </>
                )}
              </div>

              {/* Prompt or Command body */}
              {promptBody && (
                <div>
                  <label className="field-label">Prompt</label>
                  <pre className="select-text text-[10px] font-mono text-tagma-text/90 bg-tagma-bg border border-tagma-border px-2.5 py-2 overflow-auto max-h-[200px] whitespace-pre-wrap break-words">
                    {promptBody}
                  </pre>
                </div>
              )}
              {commandBody && (
                <div>
                  <label className="field-label">Command</label>
                  <pre className="select-text text-[10px] font-mono text-tagma-text/90 bg-tagma-bg border border-tagma-border px-2.5 py-2 overflow-auto max-h-[160px] whitespace-pre-wrap break-words">
                    {commandBody}
                  </pre>
                </div>
              )}

              {/* Core metadata grid */}
              <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5">
                {track && (
                  <ConfigRow label="Track">
                    <span className="inline-flex items-center gap-1.5">
                      {track.color && (
                        <span
                          className="w-2 h-2 shrink-0"
                          style={{ backgroundColor: track.color }}
                        />
                      )}
                      <span className="truncate">{track.name}</span>
                    </span>
                  </ConfigRow>
                )}
                {driver && <ConfigRow label="Driver">{driver}</ConfigRow>}
                {model && <ConfigRow label="Model">{model}</ConfigRow>}
                {permsLabel(permissions) && (
                  <ConfigRow label="Perms">{permsLabel(permissions)}</ConfigRow>
                )}
                {timeout && <ConfigRow label="Timeout">{timeout}</ConfigRow>}
                {cwd && <ConfigRow label="CWD">{cwd}</ConfigRow>}
                {agentProfile && <ConfigRow label="Profile">{agentProfile}</ConfigRow>}
                {taskConfig.continue_from && (
                  <ConfigRow label="Continue">{taskConfig.continue_from}</ConfigRow>
                )}
              </div>

              {/* Trigger */}
              {taskConfig.trigger &&
                (() => {
                  const tr = taskConfig.trigger;
                  const message = typeof tr.message === 'string' ? tr.message : undefined;
                  const path = typeof tr.path === 'string' ? tr.path : undefined;
                  const timeout = typeof tr.timeout === 'string' ? tr.timeout : undefined;
                  return (
                    <div>
                      <label className="field-label flex items-center gap-1">
                        {tr.type === 'file' ? <FileSearch size={9} /> : <Lock size={9} />}
                        Trigger
                      </label>
                      <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5">
                        <ConfigRow label="Type">{tr.type}</ConfigRow>
                        {message && (
                          <ConfigRow label="Message" mono={false}>
                            {message}
                          </ConfigRow>
                        )}
                        {path && <ConfigRow label="Path">{path}</ConfigRow>}
                        {timeout && <ConfigRow label="Timeout">{timeout}</ConfigRow>}
                      </div>
                    </div>
                  );
                })()}

              {/* Completion */}
              {taskConfig.completion &&
                (() => {
                  const cp = taskConfig.completion;
                  const path = typeof cp.path === 'string' ? cp.path : undefined;
                  const kind = typeof cp.kind === 'string' ? cp.kind : undefined;
                  const check = typeof cp.check === 'string' ? cp.check : undefined;
                  return (
                    <div>
                      <label className="field-label flex items-center gap-1">
                        <CheckCircle2 size={9} /> Completion
                      </label>
                      <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5">
                        <ConfigRow label="Type">{cp.type}</ConfigRow>
                        {cp.expect != null && (
                          <ConfigRow label="Expect">{JSON.stringify(cp.expect)}</ConfigRow>
                        )}
                        {path && <ConfigRow label="Path">{path}</ConfigRow>}
                        {kind && <ConfigRow label="Kind">{kind}</ConfigRow>}
                        {cp.min_size != null && (
                          <ConfigRow label="Min size">{String(cp.min_size)}</ConfigRow>
                        )}
                        {check && <ConfigRow label="Check">{check}</ConfigRow>}
                      </div>
                    </div>
                  );
                })()}

              {/* Middlewares */}
              {taskConfig.middlewares && taskConfig.middlewares.length > 0 && (
                <div>
                  <label className="field-label flex items-center gap-1">
                    <Layers size={9} /> Middlewares ({taskConfig.middlewares.length})
                  </label>
                  <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5 space-y-0.5">
                    {taskConfig.middlewares.map((mw, i) => {
                      const label = typeof mw.label === 'string' ? mw.label : undefined;
                      const file = typeof mw.file === 'string' ? mw.file : undefined;
                      return (
                        <ConfigRow key={`${mw.type}-${i}`} label={mw.type}>
                          {label ?? file ?? '—'}
                        </ConfigRow>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Dependencies */}
              {taskConfig.depends_on && taskConfig.depends_on.length > 0 && (
                <div>
                  <label className="field-label flex items-center gap-1">
                    <Link2 size={9} /> Depends on
                  </label>
                  <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5 space-y-0.5">
                    {taskConfig.depends_on.map((dep) => (
                      <div key={dep} className="text-[10px] font-mono text-tagma-muted truncate">
                        {dep}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
