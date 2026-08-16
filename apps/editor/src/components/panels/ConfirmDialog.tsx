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
      className="modal-viewport-backdrop fixed inset-0 z-[60] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        ref={modalRef}
        className={`modal-viewport-shell ${danger ? 'modal-tone-danger' : 'modal-tone-accent'} flex w-full max-w-[420px] flex-col border`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="panel-confirm-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 id="panel-confirm-dialog-title" className="panel-title flex items-center gap-1.5">
            {danger && <AlertTriangle size={13} className="text-tagma-error" />}
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
        <div className="modal-viewport-body space-y-2 px-4 py-3 text-[12px] text-tagma-text">
          {message}
        </div>
        <div className="modal-viewport-footer flex justify-end gap-2 border-t border-tagma-border px-4 py-3">
          <button type="button" onClick={onCancel} className="btn-secondary">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
            }}
            className={danger ? 'btn-danger-inline' : 'btn-primary min-w-24 justify-center'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
