import { useMemo, useCallback, useState } from 'react';
import yaml from 'js-yaml';
import { Copy, Check, X } from 'lucide-react';
import type { RawPipelineConfig } from '../../api/client';

interface YamlPreviewProps {
  config: RawPipelineConfig;
  onClose: () => void;
}

export function YamlPreview({ config, onClose }: YamlPreviewProps) {
  const [copied, setCopied] = useState(false);

  const yamlContent = useMemo(
    () => yaml.dump({ pipeline: config }, { lineWidth: 120, indent: 2 }),
    [config],
  );

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(yamlContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [yamlContent]);

  return (
    <div className="h-full flex flex-col bg-tagma-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          YAML Preview
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-tagma-muted hover:text-tagma-text transition-colors px-1.5 py-0.5 border border-tagma-border hover:border-tagma-accent/40"
          >
            {copied ? <Check size={10} className="text-tagma-success" /> : <Copy size={10} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <button
            onClick={onClose}
            className="text-tagma-muted hover:text-tagma-text transition-colors p-1"
            title="Close preview"
            aria-label="Close preview"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-[11px] font-mono text-tagma-text/90 leading-relaxed whitespace-pre-wrap break-words select-text">
          {yamlContent}
        </pre>
      </div>
    </div>
  );
}
