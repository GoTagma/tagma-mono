import { useMemo } from 'react';
import { ShieldCheck, X, Check, Terminal, MessageSquare } from 'lucide-react';
import type { ApprovalRequestInfo, RawPipelineConfig } from '../../api/client';
import { formatCommand } from '../../api/client';
import { isCommandTaskConfig } from '@tagma/types';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';

interface ApprovalDialogProps {
  request: ApprovalRequestInfo;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  /**
   * The pipeline snapshot used to render task context around the approval
   * request (track name, task name, prompt preview, etc). Optional so the
   * dialog still renders when the snapshot is unavailable.
   */
  config?: RawPipelineConfig;
}

interface ResolvedTaskContext {
  trackName: string;
  taskName: string;
  driver?: string;
  model?: string;
  prompt?: string;
  command?: string;
  isCommand: boolean;
}

function resolveTaskContext(
  qualifiedId: string,
  config: RawPipelineConfig,
): ResolvedTaskContext | null {
  const [trackId, ...rest] = qualifiedId.split('.');
  const taskId = rest.join('.');
  const track = config.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const task = track.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const driver = task.driver ?? track.driver ?? config.driver;
  const model = task.model ?? track.model;
  return {
    trackName: track.name,
    taskName: task.name || task.id,
    driver,
    model,
    prompt: task.prompt,
    command: formatCommand(task.command),
    isCommand: isCommandTaskConfig(task),
  };
}

/**
 * Modal-ish dialog that lets the user respond to an `ApprovalRequest`
 * emitted by a manual trigger. Rendered inside RunView as an overlay
 * when one or more approvals are pending.
 */
export function ApprovalDialog({ request, onApprove, onReject, config }: ApprovalDialogProps) {
  // Resolve the task context from the pipeline snapshot so the user can see
  // what task is actually asking for approval — just showing the qualified
  // id (track_1.task_3) is not enough to make an informed decision.
  const taskContext = useMemo<ResolvedTaskContext | null>(() => {
    if (!config) return null;
    return resolveTaskContext(request.taskId, config);
  }, [config, request.taskId]);

  const promptPreview = useMemo(() => {
    if (!taskContext) return null;
    const body = taskContext.isCommand ? taskContext.command : taskContext.prompt;
    if (!body) return null;
    const trimmed = body.trim();
    return trimmed.length > 220 ? trimmed.slice(0, 220) + '...' : trimmed;
  }, [taskContext]);
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  return (
    <div className="modal-viewport-backdrop absolute inset-0 z-30 flex items-center justify-center">
      <div
        ref={modalRef}
        className="modal-viewport-shell modal-tone-warning flex w-full max-w-[480px] flex-col border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-dialog-title"
        tabIndex={-1}
      >
        <div className="modal-viewport-header flex shrink-0 min-w-0 items-center gap-2 border-b px-4 py-2.5">
          <ShieldCheck size={14} className="shrink-0 text-tagma-warning" />
          <span
            id="approval-dialog-title"
            className="min-w-0 flex-1 truncate text-label font-medium text-tagma-text"
          >
            Approval Required
          </span>
          <span
            className="max-w-[45%] shrink-0 truncate text-caption font-mono text-tagma-muted"
            title={request.taskId}
          >
            {request.taskId}
          </span>
        </div>

        <div className="modal-viewport-body">
          {/* Task context row — surfaces the task's human-readable identity so
            the reviewer can decide without context-switching back to the
            canvas. Only shown when the snapshot resolves the task. */}
          {taskContext && (
            <div className="px-4 py-2.5 border-b border-tagma-border/60 bg-tagma-bg/40">
              <div className="flex items-center gap-2 min-w-0">
                {taskContext.isCommand ? (
                  <Terminal size={11} className="text-tagma-accent shrink-0" />
                ) : (
                  <MessageSquare size={11} className="text-tagma-muted/70 shrink-0" />
                )}
                <span className="text-label font-medium text-tagma-text truncate flex-1">
                  {taskContext.taskName}
                </span>
                <span className="text-tiny font-mono text-tagma-muted shrink-0 truncate max-w-[140px]">
                  {taskContext.trackName}
                </span>
              </div>
              {(taskContext.driver || taskContext.model) && !taskContext.isCommand && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-tiny font-mono">
                  {taskContext.driver && (
                    <span className="min-w-0 break-all text-tagma-accent/80">
                      driver: {taskContext.driver}
                    </span>
                  )}
                  {taskContext.model && (
                    <span className="min-w-0 break-all text-tagma-muted">
                      model: {taskContext.model}
                    </span>
                  )}
                </div>
              )}
              {promptPreview && (
                <pre className="mt-2 text-caption font-mono text-tagma-muted/90 bg-tagma-bg border border-tagma-border/60 px-2 py-1.5 max-h-[100px] overflow-auto whitespace-pre-wrap break-words">
                  {promptPreview}
                </pre>
              )}
            </div>
          )}

          <div className="px-4 py-3 space-y-3">
            <div>
              <label className="field-label">Message</label>
              <div className="text-label text-tagma-text whitespace-pre-wrap break-words">
                {request.message || '(no message)'}
              </div>
            </div>

            {request.metadata && Object.keys(request.metadata).length > 0 && (
              <div>
                <label className="field-label">Metadata</label>
                <pre className="text-caption font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2 py-1.5 overflow-auto max-h-[140px]">
                  {JSON.stringify(request.metadata, null, 2)}
                </pre>
              </div>
            )}

            <div className="text-caption font-mono text-tagma-muted">
              Timeout: {Math.round(request.timeoutMs / 1000)}s · Created{' '}
              {new Date(request.createdAt).toLocaleTimeString()}
            </div>
          </div>
        </div>

        <div className="modal-viewport-footer flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <button type="button" onClick={() => onReject()} className="btn-danger-inline">
            <X size={11} />
            <span>Reject</span>
          </button>
          <button type="button" onClick={() => onApprove()} className="btn-success-inline">
            <Check size={11} />
            <span>Approve</span>
          </button>
        </div>
      </div>
    </div>
  );
}
