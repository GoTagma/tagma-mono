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
      className="modal-viewport-backdrop fixed inset-0 z-[220] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell w-full max-w-[440px] flex flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <h2 id="save-as-dialog-title" className="panel-title truncate">
              {title}
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
        <div className="modal-viewport-body px-4 py-3 flex flex-col gap-2">
          <label className="field-label">{inputLabel}</label>
          <input
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirm(value);
              if (e.key === 'Escape') onCancel();
            }}
            className="field-input font-mono"
            placeholder={placeholder}
            aria-label={inputAriaLabel}
          />
        </div>
        <div className="modal-viewport-footer px-4 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
          <button onClick={() => onConfirm(value)} className="btn-primary min-w-24 justify-center">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
