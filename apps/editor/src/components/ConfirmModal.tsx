import { useCallback, useEffect } from 'react';
import { AlertCircle, X as XIcon } from 'lucide-react';
import { useModalFocusTrap } from '../hooks/use-modal-focus-trap';

export type ConfirmInfo = {
  title: string;
  details: string[];
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
};

interface ConfirmModalProps {
  info: ConfirmInfo;
  onClose: () => void;
}

export function ConfirmModal({ info, onClose }: ConfirmModalProps) {
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  const handleDismiss = useCallback(() => {
    onClose();
    info.onCancel?.();
  }, [info, onClose]);

  const handleConfirm = useCallback(() => {
    onClose();
    info.onConfirm();
  }, [info, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDismiss]);

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-[210] flex items-center justify-center bg-black/60"
      onClick={handleDismiss}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell w-full max-w-[440px] flex flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle
              size={14}
              className={`shrink-0 ${info.danger ? 'text-tagma-error' : 'text-tagma-accent'}`}
            />
            <h2
              id="confirm-modal-title"
              className={`panel-title truncate ${info.danger ? 'text-tagma-error' : 'text-tagma-text'}`}
            >
              {info.title}
            </h2>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="modal-viewport-body">
          {info.details.map((detail, i) => (
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
            onClick={handleDismiss}
            className="min-w-[120px] px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors text-center"
          >
            {info.cancelLabel ?? 'Cancel'}
          </button>
          <button
            onClick={handleConfirm}
            className={`${info.danger ? 'btn-danger' : 'btn-primary'} w-auto min-w-[120px] justify-center text-center`}
          >
            {info.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
