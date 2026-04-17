import { AlertCircle, X as XIcon } from 'lucide-react';

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
  const handleDismiss = () => {
    onClose();
    info.onCancel?.();
  };

  const handleConfirm = () => {
    onClose();
    info.onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60"
      onClick={handleDismiss}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[440px] max-h-[60vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle
              size={14}
              className={`shrink-0 ${info.danger ? 'text-tagma-error' : 'text-tagma-accent'}`}
            />
            <h2
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
        <div className="flex-1 overflow-y-auto">
          {info.details.map((detail, i) => (
            <div
              key={i}
              className="px-4 py-2.5 border-b border-tagma-border/30 last:border-b-0 text-[11px] text-tagma-text font-mono break-words"
            >
              {detail}
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button
            onClick={handleDismiss}
            className="px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
          >
            {info.cancelLabel ?? 'Cancel'}
          </button>
          <button onClick={handleConfirm} className={info.danger ? 'btn-danger' : 'btn-primary'}>
            {info.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
