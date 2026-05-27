import { Children, cloneElement, isValidElement, useState, type ReactElement } from 'react';
import { Check, Copy } from 'lucide-react';

export function copyableTextValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function CopyableField({
  value,
  label,
  children,
  className = '',
  buttonClassName = '',
}: {
  value: unknown;
  label: string;
  children: ReactElement<{ className?: string }>;
  className?: string;
  buttonClassName?: string;
}) {
  const [copied, setCopied] = useState(false);
  const only = Children.only(children);
  const child = isValidElement<{ className?: string }>(only)
    ? cloneElement(only, {
        className: `${only.props.className ?? ''} w-full pr-7`,
      })
    : only;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyableTextValue(value));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      /* Clipboard access can fail in unfocused windows. */
    }
  };

  return (
    <div className={`relative min-w-0 ${className}`}>
      {child}
      <button
        type="button"
        onClick={handleCopy}
        className={`absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-tagma-muted/65 hover:text-tagma-text transition-colors ${buttonClassName}`}
        aria-label={label}
        title={label}
      >
        {copied ? <Check size={10} /> : <Copy size={10} />}
      </button>
    </div>
  );
}
