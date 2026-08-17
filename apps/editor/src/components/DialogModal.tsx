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
      className="modal-viewport-backdrop fixed inset-0 z-[200] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className={`modal-viewport-shell ${info.type === 'error' ? 'modal-tone-danger' : 'modal-tone-success'} w-full max-w-[440px] flex flex-col border`}
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
          <button onClick={onClose} className="icon-btn" aria-label="Close dialog">
            <XIcon size={14} />
          </button>
        </div>
        <div className="modal-viewport-body">
          {info.details.map((detail, i) => (
            <div
              key={i}
              className="flex items-start gap-2.5 px-4 py-3 border-b border-tagma-border/30 last:border-b-0"
            >
              {info.type === 'error' ? (
                <AlertCircle size={11} className="text-tagma-error shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 size={11} className="text-tagma-success shrink-0 mt-0.5" />
              )}
              <div className="text-body text-tagma-text font-mono min-w-0 break-words">
                {detail}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-viewport-footer px-4 py-3 border-t border-tagma-border flex justify-end">
          <button onClick={onClose} className="btn-primary min-w-24 justify-center">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
