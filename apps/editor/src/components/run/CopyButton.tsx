import { useCallback, useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  size?: number;
  className?: string;
  title?: string;
}

export function CopyButton({ value, size = 11, className = '', title }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard
        .writeText(value)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {
          /* noop — clipboard write can fail in unfocused windows */
        });
    },
    [value],
  );
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`shrink-0 p-0.5 transition-colors ${
        copied ? 'text-tagma-success' : 'text-tagma-muted hover:text-tagma-text'
      } ${className}`}
      title={title ?? (copied ? 'Copied!' : 'Copy')}
      aria-label={title ?? 'Copy'}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
