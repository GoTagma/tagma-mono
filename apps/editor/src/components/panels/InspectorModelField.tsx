import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { copyableTextValue } from './CopyableField';
import { ModelPickerDropdown, parseModelPickerValue } from '../chat/ModelPickerDropdown';

export function isBuiltinOpencodeDriver(driver: string | null | undefined): boolean {
  return driver === 'opencode';
}

export function InspectorModelField({
  value,
  onChange,
  onBlur,
  copyLabel,
  placeholder,
  enableOpencodeModels,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  copyLabel: string;
  placeholder: string;
  enableOpencodeModels: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const providersFromHook = useChatStore((s) => s.providers);
  const providers =
    providersFromHook.length > 0 ? providersFromHook : useChatStore.getState().providers;
  const selectedModel = useMemo(() => parseModelPickerValue(value), [value]);

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
    <>
      <div className="relative min-w-0 flex items-center">
        {enableOpencodeModels ? (
          <ModelPickerDropdown
            providers={providers}
            value={selectedModel}
            onSelect={(selection) => {
              onChange(`${selection.providerID}/${selection.modelID}`);
              onBlur();
            }}
            placeholder="Pick model"
            fallbackLabel={value}
            buttonClassName="field-input inspector-model-input w-full pr-7 justify-between font-mono text-[11px]"
          />
        ) : (
          <input
            type="text"
            className="inspector-model-input field-input font-mono text-[11px] pr-7"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            placeholder={placeholder}
          />
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-tagma-muted/65 hover:text-tagma-text transition-colors"
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
        </button>
      </div>
    </>
  );
}
