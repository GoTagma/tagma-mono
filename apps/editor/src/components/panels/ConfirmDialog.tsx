import { AlertTriangle, X } from 'lucide-react';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';

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
 * Kept intentionally small to match the existing lightweight modal pattern used
 * by the editor's modal surfaces.
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
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell flex w-full max-w-[420px] flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="panel-confirm-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 id="panel-confirm-dialog-title" className="panel-title flex items-center gap-1.5">
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
        <div className="modal-viewport-body space-y-2 px-5 py-4 text-[12px] text-tagma-text">
          {message}
        </div>
        <div className="modal-viewport-footer flex justify-end gap-2 border-t border-tagma-border px-5 py-3">
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
