import { useEffect } from 'react';
import { AlertCircle, CheckCircle2, X as XIcon } from 'lucide-react';
import { useModalFocusTrap } from '../hooks/use-modal-focus-trap';

export type DialogInfo = { type: 'error' | 'success'; title: string; details: string[] };

interface DialogModalProps {
  info: DialogInfo;
  onClose: () => void;
}

export function DialogModal({ info, onClose }: DialogModalProps) {
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[min(480px,calc(100vw-32px))] max-h-[min(60vh,calc(100vh-48px))] flex flex-col animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            {info.type === 'error' ? (
              <AlertCircle size={14} className="text-tagma-error shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="text-tagma-success shrink-0" />
            )}
            <h2
              id="dialog-modal-title"
              className={`panel-title truncate ${info.type === 'error' ? 'text-tagma-error' : 'text-tagma-success'}`}
            >
              {info.title}
            </h2>
          </div>
          <button
            onClick={onClose}
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
              className="flex items-start gap-2.5 px-4 py-2.5 border-b border-tagma-border/30 last:border-b-0"
            >
              {info.type === 'error' ? (
                <AlertCircle size={11} className="text-tagma-error shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 size={11} className="text-tagma-success shrink-0 mt-0.5" />
              )}
              <div className="text-[11px] text-tagma-text font-mono min-w-0 break-words">
                {detail}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-tagma-border flex justify-end">
          <button onClick={onClose} className="btn-primary">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
