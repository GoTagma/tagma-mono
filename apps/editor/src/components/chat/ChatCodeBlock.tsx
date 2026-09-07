import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';
import { createLowlight } from 'lowlight';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

const highlighter = createLowlight({
  yaml,
  json,
  bash,
  powershell,
  javascript,
  typescript,
  python,
  xml,
  css,
  sql,
  diff,
});
type HighlightNodes = ReturnType<typeof highlighter.highlight>['children'];

export function highlightChatCode(code: string, language: string): HighlightNodes {
  if (code.length <= 100_000 && highlighter.registered(language)) {
    try {
      return highlighter.highlight(language, code).children;
    } catch {
      /* incomplete streamed code stays readable */
    }
  }
  return [{ type: 'text', value: code }];
}

function renderTokens(nodes: HighlightNodes): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return null;
    const classes = node.properties.className;
    return (
      <span key={index} className={Array.isArray(classes) ? classes.join(' ') : undefined}>
        {renderTokens(node.children)}
      </span>
    );
  });
}

export function ChatCodeBlock({ code, language = '' }: { code: string; language?: string }) {
  const [wrap, setWrap] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const highlighted = useMemo(
    () => renderTokens(highlightChatCode(code, language.toLowerCase())),
    [code, language],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  };
  return (
    <div className="chat-code-block" data-wrap={wrap}>
      <div className="flex min-w-0 items-center gap-2 border-b border-tagma-border px-2 py-1 text-caption font-mono text-tagma-muted select-none">
        <span className="min-w-0 flex-1 truncate" title={language}>
          {language || 'Plain text'}
        </span>
        <button
          type="button"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          className="icon-btn"
          title="Wrap lines"
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={12} />
        </button>
        <button
          type="button"
          aria-label="Copy code"
          className="flex shrink-0 items-center gap-1 hover:text-tagma-text"
          onClick={() => void copy()}
        >
          {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
          <span role="status">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
          </span>
        </button>
      </div>
      <pre tabIndex={0} aria-label={language ? `${language} code` : 'Code'}>
        <code>{highlighted}</code>
      </pre>
    </div>
  );
}
