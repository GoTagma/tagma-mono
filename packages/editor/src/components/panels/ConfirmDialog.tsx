import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared confirmation modal for destructive operations (delete task / track, etc.).
 * Kept intentionally small — no focus trap, no portals — to match the existing
 * lightweight modal pattern used in PipelineConfigPanel.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[420px] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 className="panel-title flex items-center gap-1.5">
            {danger && <AlertTriangle size={13} className="text-tagma-warning" />}
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 text-[12px] text-tagma-text space-y-2">{message}</div>
        <div className="px-5 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-[11px] border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-text/40 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
            }}
            className={danger ? 'btn-danger' : 'btn-primary'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
