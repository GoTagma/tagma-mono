import { AlertCircle, CheckCircle2, X as XIcon } from 'lucide-react';

export type DialogInfo = { type: 'error' | 'success'; title: string; details: string[] };

interface DialogModalProps {
  info: DialogInfo;
  onClose: () => void;
}

export function DialogModal({ info, onClose }: DialogModalProps) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-tagma-surface border border-tagma-border shadow-panel w-[480px] max-h-[60vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            {info.type === 'error'
              ? <AlertCircle size={14} className="text-tagma-error shrink-0" />
              : <CheckCircle2 size={14} className="text-tagma-success shrink-0" />}
            <h2 className={`panel-title truncate ${info.type === 'error' ? 'text-tagma-error' : 'text-tagma-success'}`}>{info.title}</h2>
          </div>
          <button onClick={onClose} className="p-1 text-tagma-muted hover:text-tagma-text" aria-label="Close dialog">
            <XIcon size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {info.details.map((detail, i) => (
            <div key={i} className="flex items-start gap-2.5 px-4 py-2.5 border-b border-tagma-border/30 last:border-b-0">
              {info.type === 'error'
                ? <AlertCircle size={11} className="text-tagma-error shrink-0 mt-0.5" />
                : <CheckCircle2 size={11} className="text-tagma-success shrink-0 mt-0.5" />}
              <div className="text-[11px] text-tagma-text font-mono min-w-0 break-words">{detail}</div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-tagma-border flex justify-end">
          <button onClick={onClose} className="btn-primary">OK</button>
        </div>
      </div>
    </div>
  );
}