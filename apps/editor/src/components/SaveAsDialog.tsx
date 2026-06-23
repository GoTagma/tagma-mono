import { useState } from 'react';
import { X as XIcon } from 'lucide-react';
import { useModalFocusTrap } from '../hooks/use-modal-focus-trap';

interface SaveAsDialogProps {
  defaultValue: string;
  title?: string;
  inputLabel?: string;
  inputAriaLabel?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function SaveAsDialog({
  defaultValue,
  title = 'Save As',
  inputLabel = 'Pipeline name (saved at .tagma/<name>/<name>.yaml)',
  inputAriaLabel = 'Pipeline name',
  placeholder = 'my-pipeline',
  confirmLabel = 'Save',
  onConfirm,
  onCancel,
}: SaveAsDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        ref={modalRef}
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[min(400px,calc(100vw-32px))] max-h-[min(60vh,calc(100vh-48px))] flex flex-col animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 id="save-as-dialog-title" className="panel-title">
            {title}
          </h2>
          <button
            onClick={onCancel}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div className="px-4 py-4 flex flex-col gap-2">
          <label className="text-[10px] font-mono text-tagma-muted uppercase tracking-wider">
            {inputLabel}
          </label>
          <input
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm(value);
              if (e.key === 'Escape') onCancel();
            }}
            className="text-[11px] font-mono bg-tagma-bg border border-tagma-border focus:border-tagma-accent px-2 py-1 text-tagma-text outline-none"
            placeholder={placeholder}
            aria-label={inputAriaLabel}
          />
        </div>
        <div className="px-4 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
          >
            Cancel
          </button>
          <button onClick={() => onConfirm(value)} className="btn-primary">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
