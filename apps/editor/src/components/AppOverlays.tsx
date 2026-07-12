import { useEffect, type ReactNode } from 'react';
import { Loader2, X as XIcon, ShieldCheck } from 'lucide-react';
import type { PlatformExportStage, PlatformExportTarget } from '../api/client';
import { useUIStore } from '../store/ui-store';
import { ConfirmModal } from './ConfirmModal';
import { useModalFocusTrap } from '../hooks/use-modal-focus-trap';

export const PLATFORM_EXPORT_TARGETS: readonly PlatformExportTarget[] = ['windows', 'linux', 'mac'];

export const PLATFORM_EXPORT_LABELS: Record<PlatformExportTarget, string> = {
  windows: 'Windows',
  linux: 'Linux',
  mac: 'macOS',
};

export const PLATFORM_EXPORT_STAGES: readonly PlatformExportStage[] = [
  'preparing',
  'syncing',
  'opencode',
  'model',
  'generating',
  'validating',
  'repairing',
  'writing',
];

export const PLATFORM_EXPORT_STAGE_LABELS: Record<PlatformExportStage, string> = {
  preparing: 'Preparing',
  syncing: 'Saving YAML',
  opencode: 'Starting OpenCode',
  model: 'Selecting model',
  generating: 'Converting YAML',
  validating: 'Validating YAML',
  repairing: 'Repairing YAML',
  writing: 'Writing files',
};

export type PlatformExportProgressState = {
  targetPlatform: PlatformExportTarget;
  stage: PlatformExportStage;
  detail: string;
  messages: string[];
};

export type UnsavedAction = {
  title: string;
  details: string[];
  run: () => void | Promise<void>;
};

export const VIEWPORT_NOTIFICATION_STACK_CLASSES =
  'pointer-events-none fixed inset-x-2 bottom-2 z-[310] flex max-h-[calc(100dvh-1rem)] flex-col gap-2 overflow-y-auto overscroll-contain sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[420px] sm:max-h-[calc(100dvh-2rem)]';

export function ViewportNotificationStack({ children }: { children: ReactNode }) {
  return <div className={VIEWPORT_NOTIFICATION_STACK_CLASSES}>{children}</div>;
}

export function PlatformExportProgressToast({
  progress,
  contained = false,
}: {
  progress: PlatformExportProgressState;
  contained?: boolean;
}) {
  const stageIndex = Math.max(0, PLATFORM_EXPORT_STAGES.indexOf(progress.stage));
  const width = `${Math.round(((stageIndex + 1) / PLATFORM_EXPORT_STAGES.length) * 100)}%`;
  const targetLabel = PLATFORM_EXPORT_LABELS[progress.targetPlatform];
  const stageLabel = PLATFORM_EXPORT_STAGE_LABELS[progress.stage];

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        contained
          ? 'pointer-events-auto max-h-[min(18rem,45dvh)] w-full shrink-0 overflow-x-hidden overflow-y-auto border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in'
          : 'fixed inset-x-2 bottom-2 z-[290] max-h-[calc(100dvh-1rem)] overflow-x-hidden overflow-y-auto border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[380px] sm:max-h-[calc(100dvh-2rem)]'
      }
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Loader2 size={15} className="mt-0.5 shrink-0 text-tagma-accent animate-spin" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-tagma-text">
            <span className="truncate">Exporting for {targetLabel}</span>
            <span className="shrink-0 text-[10px] text-tagma-muted">
              {stageIndex + 1}/{PLATFORM_EXPORT_STAGES.length}
            </span>
          </div>
          <div className="mt-1 break-words text-[10px] font-mono text-tagma-muted">
            <span className="text-tagma-text">{stageLabel}</span>
            {progress.detail ? ` - ${progress.detail}` : ''}
          </div>
          <div
            className="mt-2 h-[3px] w-full bg-tagma-border/50 overflow-hidden"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={PLATFORM_EXPORT_STAGES.length}
            aria-valuenow={stageIndex + 1}
            aria-label="Platform export progress"
          >
            <div
              className="h-full bg-tagma-accent transition-[width] duration-300"
              style={{ width }}
            />
          </div>
          {progress.messages.length > 0 && (
            <div className="mt-2 border-t border-tagma-border/40 pt-2 space-y-1">
              {progress.messages.map((message, index) => (
                <div
                  key={`${index}-${message}`}
                  className="flex items-start gap-1.5 text-[9px] font-mono leading-snug text-tagma-muted"
                >
                  <span className="mt-[5px] h-[3px] w-[3px] shrink-0 bg-tagma-muted/60" />
                  <span className="min-w-0 break-words">{message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function UnsavedChangesModal({
  action,
  onSave,
  onDiscard,
  onCancel,
}: {
  action: UnsavedAction;
  onSave: () => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-[215] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell w-full max-w-[460px] flex flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck size={14} className="text-tagma-accent shrink-0" />
            <h2 id="unsaved-changes-modal-title" className="panel-title truncate">
              {action.title}
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="modal-viewport-body">
          {action.details.map((detail, i) => (
            <div
              key={i}
              className="px-4 py-2.5 border-b border-tagma-border/30 last:border-b-0 text-[11px] text-tagma-text font-mono break-words"
            >
              {detail}
            </div>
          ))}
        </div>
        <div className="modal-viewport-footer px-4 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="min-w-[96px] px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors text-center"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              void onDiscard();
            }}
            className="min-w-[96px] px-3 py-1 text-[11px] text-tagma-warning border border-tagma-warning/50 hover:bg-tagma-warning/10 transition-colors text-center"
          >
            Discard
          </button>
          <button
            onClick={() => {
              void onSave();
            }}
            className="btn-primary w-auto min-w-[96px] justify-center text-center"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export function GlobalConfirmModal() {
  const confirm = useUIStore((s) => s.confirm);
  const dismiss = useUIStore((s) => s.dismissConfirm);
  if (!confirm) return null;
  return <ConfirmModal info={confirm} onClose={dismiss} />;
}
