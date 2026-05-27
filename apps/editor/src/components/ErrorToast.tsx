import { useEffect } from 'react';
import { AlertCircle, X as XIcon } from 'lucide-react';
import { usePipelineStore } from '../store/pipeline-store';

const AUTO_DISMISS_MS = 6000;

/**
 * Fixed-position toast that surfaces `errorMessage` from the pipeline store.
 * Auto-dismisses after ~6 seconds; also supports explicit close.
 *
 * Rendered once at the App root and is a no-op when there is no error.
 */
export function ErrorToast() {
  const errorMessage = usePipelineStore((s) => s.errorMessage);
  const clearError = usePipelineStore((s) => s.clearError);

  useEffect(() => {
    if (!errorMessage) return;
    const handle = window.setTimeout(() => clearError(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [errorMessage, clearError]);

  if (!errorMessage) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-4 right-4 z-[300] max-w-[420px] bg-tagma-surface border border-tagma-error shadow-panel animate-fade-in overflow-hidden"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div className="w-[3px] self-stretch shrink-0 bg-tagma-error" />
        <AlertCircle size={14} className="text-tagma-error shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 text-[11px] text-tagma-text font-mono break-words">
          {errorMessage}
        </div>
        <button
          onClick={clearError}
          className="p-1 text-tagma-muted hover:text-tagma-text shrink-0"
          aria-label="Dismiss error"
        >
          <XIcon size={12} />
        </button>
      </div>
    </div>
  );
}
