/**
 * Per-tool visualization for opencode `ToolPart` bodies.
 *
 * The opencode SDK types tool input/output as `Record<string, unknown>` /
 * `string`, so dispatch happens by `part.tool` name and each renderer
 * shape-checks the input it cares about. Renderers return `null` (or `undefined`)
 * to fall through to the generic JSON view in `ChatPanel`'s `ToolPartView`.
 *
 * Add a new tool by registering a renderer in `TOOL_RENDERERS` — `ToolPartView`
 * picks it up automatically.
 */
import {
  Circle,
  CircleDot,
  CheckCircle2,
  Terminal,
  FileText,
  FilePlus2,
  FileEdit,
  Search,
  Folder,
  Globe,
  Bot,
  BookOpen,
} from 'lucide-react';
import type { ToolPart, ToolState } from '../../api/opencode-chat';
import { extractSkillNameFromToolState } from '../../utils/chat-tool-display';

export interface ToolRendererProps {
  part: ToolPart;
  state: ToolState;
}

export type ToolRenderer = (props: ToolRendererProps) => React.ReactNode;

// ---------------------------------------------------------------------------
// Shape helpers — input is `Record<string, unknown>`, so each renderer must
// narrow at runtime. These keep the per-tool components free of casts.
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Todo list (todowrite)
// ---------------------------------------------------------------------------

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  content: string;
  status: TodoStatus;
  id?: string;
}

function extractTodosFromRecord(input: Record<string, unknown>): TodoItem[] | null {
  const raw = asArray(input.todos);
  if (!raw) return null;
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec) return null;
    const content = asString(rec.content) ?? asString(rec.activeForm);
    const status = asString(rec.status);
    if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
      return null;
    }
    items.push({ content, status, id: asString(rec.id) });
  }
  return items;
}

/**
 * `todoread` returns the current todo list as text. Different opencode
 * versions emit different formats — JSON-stringified state, markdown
 * checkboxes (`- [ ]` / `- [x]` / `- [-]`), or status-tagged lines
 * (`[pending] foo`). Try each in order; null means the output isn't a
 * recognizable todo list and the caller should fall back to plain text.
 */
function parseTodoOutput(output: string): TodoItem[] | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed)?.todos);
      if (arr) {
        const fromJson = extractTodosFromRecord({ todos: arr });
        if (fromJson && fromJson.length > 0) return fromJson;
      }
    } catch {
      /* fall through to text parsers */
    }
  }
  const items: TodoItem[] = [];
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let m = t.match(/^[-*]?\s*\[([ xX\-~/])\]\s+(.+)$/);
    if (m) {
      const mark = m[1].toLowerCase();
      const status: TodoStatus =
        mark === 'x'
          ? 'completed'
          : mark === '-' || mark === '/' || mark === '~'
            ? 'in_progress'
            : 'pending';
      items.push({ content: m[2], status });
      continue;
    }
    m = t.match(/^\[(pending|in[_\s]?progress|completed|done|todo)\]\s+(.+)$/i);
    if (m) {
      const tag = m[1].toLowerCase().replace(/\s/g, '_');
      const status: TodoStatus =
        tag === 'completed' || tag === 'done'
          ? 'completed'
          : tag === 'in_progress'
            ? 'in_progress'
            : 'pending';
      items.push({ content: m[2], status });
      continue;
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Resolve the canonical todo list from any place opencode might stash it on
 * a tool call: `input.todos` (todowrite), `metadata.todos` (some 1.14.x
 * variants), or the textual output (todoread). Returns null if nothing
 * matches a known shape — callers should fall through to the default view.
 */
function extractTodosFromState(state: ToolState): TodoItem[] | null {
  const fromInput = extractTodosFromRecord(state.input);
  if (fromInput && fromInput.length > 0) return fromInput;
  const meta = 'metadata' in state ? state.metadata : undefined;
  if (meta) {
    const fromMeta = extractTodosFromRecord(meta);
    if (fromMeta && fromMeta.length > 0) return fromMeta;
  }
  if (state.status === 'completed' && state.output) {
    return parseTodoOutput(state.output);
  }
  return null;
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return <CheckCircle2 size={10} className="text-tagma-ready shrink-0 mt-0.5" />;
  }
  if (status === 'in_progress') {
    return <CircleDot size={10} className="text-tagma-accent shrink-0 mt-0.5" />;
  }
  return <Circle size={10} className="text-tagma-muted/60 shrink-0 mt-0.5" />;
}

function TodoList({ items }: { items: TodoItem[] }) {
  return (
    <ul className="select-text space-y-1 py-0.5">
      {items.map((t, i) => (
        <li key={t.id ?? `${i}-${t.content}`} className="flex items-start gap-1.5 text-[10px]">
          <TodoStatusIcon status={t.status} />
          <span
            className={
              t.status === 'completed'
                ? 'line-through text-tagma-muted/70'
                : t.status === 'in_progress'
                  ? 'text-tagma-text font-medium'
                  : 'text-tagma-text/90'
            }
          >
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

const TodoWriteRenderer: ToolRenderer = ({ state }) => {
  const items = extractTodosFromState(state);
  if (!items || items.length === 0) return null;
  return <TodoList items={items} />;
};

const TodoReadRenderer: ToolRenderer = ({ state }) => {
  const items = extractTodosFromState(state);
  if (!items || items.length === 0) return null;
  return <TodoList items={items} />;
};

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

const BashRenderer: ToolRenderer = ({ state }) => {
  const command = asString(state.input.command);
  if (!command) return null;
  const description = asString(state.input.description);
  const output = state.status === 'completed' ? state.output : undefined;
  return (
    <div className="space-y-1">
      {description && <div className="text-[9px] text-tagma-muted/80 italic">{description}</div>}
      <div className="flex gap-1.5 items-start">
        <Terminal size={10} className="text-tagma-muted/70 shrink-0 mt-0.5" />
        <pre className="select-text flex-1 text-[10px] text-tagma-text/90 whitespace-pre-wrap break-all">
          <span className="text-tagma-muted/60">$ </span>
          {command}
        </pre>
      </div>
      {output && (
        <pre className="select-text text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto pl-3 border-l border-tagma-border/40">
          {output}
        </pre>
      )}
      {state.status === 'error' && (
        <pre className="select-text text-[9px] text-tagma-error/90 whitespace-pre-wrap break-all pl-3 border-l border-tagma-error/40">
          {state.error}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Read / Write / Edit
// ---------------------------------------------------------------------------

function FileHeader({
  icon,
  filePath,
  meta,
}: {
  icon: React.ReactNode;
  filePath: string;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      {icon}
      <span className="select-text font-mono text-tagma-text/90 truncate">{filePath}</span>
      {meta && <span className="text-tagma-muted/60 text-[9px] shrink-0">{meta}</span>}
    </div>
  );
}

const ReadRenderer: ToolRenderer = ({ state }) => {
  const filePath = asString(state.input.filePath) ?? asString(state.input.path);
  if (!filePath) return null;
  const offset = asNumber(state.input.offset);
  const limit = asNumber(state.input.limit);
  const meta =
    offset != null || limit != null
      ? `lines ${offset ?? 1}${limit ? `–${(offset ?? 0) + limit}` : '+'}`
      : undefined;
  const output = state.status === 'completed' ? state.output : undefined;
  return (
    <div className="space-y-1">
      <FileHeader
        icon={<FileText size={10} className="text-tagma-muted/70 shrink-0" />}
        filePath={filePath}
        meta={meta}
      />
      {output && (
        <pre className="select-text text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto pl-3 border-l border-tagma-border/40">
          {output}
        </pre>
      )}
    </div>
  );
};

const WriteRenderer: ToolRenderer = ({ state }) => {
  const filePath = asString(state.input.filePath) ?? asString(state.input.path);
  if (!filePath) return null;
  const content = asString(state.input.content);
  return (
    <div className="space-y-1">
      <FileHeader
        icon={<FilePlus2 size={10} className="text-tagma-ready shrink-0" />}
        filePath={filePath}
        meta={content ? `${content.split('\n').length} lines` : undefined}
      />
      {content && (
        <pre className="select-text text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto pl-3 border-l border-tagma-ready/40">
          {content}
        </pre>
      )}
    </div>
  );
};

const EditRenderer: ToolRenderer = ({ state }) => {
  const filePath = asString(state.input.filePath) ?? asString(state.input.path);
  if (!filePath) return null;
  const oldStr = asString(state.input.oldString) ?? asString(state.input.old_string);
  const newStr = asString(state.input.newString) ?? asString(state.input.new_string);
  return (
    <div className="space-y-1">
      <FileHeader
        icon={<FileEdit size={10} className="text-tagma-accent shrink-0" />}
        filePath={filePath}
      />
      {oldStr != null && (
        <pre className="select-text text-[9px] whitespace-pre-wrap break-all overflow-hidden max-h-[160px] overflow-y-auto pl-3 border-l border-tagma-error/50 text-tagma-error/85">
          {oldStr || '(empty)'}
        </pre>
      )}
      {newStr != null && (
        <pre className="select-text text-[9px] whitespace-pre-wrap break-all overflow-hidden max-h-[160px] overflow-y-auto pl-3 border-l border-tagma-ready/50 text-tagma-ready">
          {newStr || '(empty)'}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Grep / Glob / List — all output a list of paths or path:line:match lines
// ---------------------------------------------------------------------------

const GrepRenderer: ToolRenderer = ({ state }) => {
  const pattern = asString(state.input.pattern);
  if (!pattern) return null;
  const path = asString(state.input.path);
  const output = state.status === 'completed' ? state.output : '';
  const lines = output.split('\n').filter(Boolean);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <Search size={10} className="text-tagma-muted/70 shrink-0" />
        <code className="select-text font-mono text-tagma-text/90 truncate">/{pattern}/</code>
        {path && <span className="text-tagma-muted/60 text-[9px] shrink-0">in {path}</span>}
        {lines.length > 0 && (
          <span className="text-tagma-muted/60 text-[9px] shrink-0">
            {lines.length} match{lines.length === 1 ? '' : 'es'}
          </span>
        )}
      </div>
      {lines.length > 0 && (
        <ul className="select-text space-y-px pl-3 border-l border-tagma-border/40 max-h-[240px] overflow-y-auto">
          {lines.map((line, i) => (
            <li
              key={i}
              className="text-[9px] font-mono text-tagma-text/85 whitespace-pre-wrap break-all"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const PathListRenderer: ToolRenderer = ({ state }) => {
  const output = state.status === 'completed' ? state.output : '';
  const pattern = asString(state.input.pattern) ?? asString(state.input.path) ?? '';
  const lines = output.split('\n').filter(Boolean);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <Folder size={10} className="text-tagma-muted/70 shrink-0" />
        <code className="select-text font-mono text-tagma-text/90 truncate">
          {pattern || '(root)'}
        </code>
        {lines.length > 0 && (
          <span className="text-tagma-muted/60 text-[9px] shrink-0">{lines.length} entries</span>
        )}
      </div>
      {lines.length > 0 && (
        <ul className="select-text space-y-px pl-3 border-l border-tagma-border/40 max-h-[240px] overflow-y-auto">
          {lines.map((line, i) => (
            <li
              key={i}
              className="text-[9px] font-mono text-tagma-text/85 whitespace-pre-wrap break-all"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Webfetch
// ---------------------------------------------------------------------------

const WebfetchRenderer: ToolRenderer = ({ state }) => {
  const url = asString(state.input.url);
  if (!url) return null;
  const prompt = asString(state.input.prompt) ?? asString(state.input.format);
  const output = state.status === 'completed' ? state.output : undefined;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <Globe size={10} className="text-tagma-muted/70 shrink-0" />
        <span className="select-text font-mono text-tagma-text/90 truncate">{url}</span>
      </div>
      {prompt && (
        <div className="text-[9px] text-tagma-muted/80 italic pl-3.5 truncate">{prompt}</div>
      )}
      {output && (
        <pre className="select-text text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto pl-3 border-l border-tagma-border/40">
          {output}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Subagent task
// ---------------------------------------------------------------------------

const TaskRenderer: ToolRenderer = ({ state }) => {
  const description = asString(state.input.description);
  const subagent = asString(state.input.subagent_type) ?? asString(state.input.agent);
  const prompt = asString(state.input.prompt);
  if (!description && !prompt) return null;
  const output = state.status === 'completed' ? state.output : undefined;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <Bot size={10} className="text-tagma-accent shrink-0" />
        <span className="select-text font-mono text-tagma-text/90 truncate">
          {description ?? '(subagent)'}
        </span>
        {subagent && <span className="text-tagma-muted/60 text-[9px] shrink-0">@{subagent}</span>}
      </div>
      {prompt && (
        <pre className="select-text text-[9px] text-tagma-muted/80 whitespace-pre-wrap break-all overflow-hidden max-h-[120px] overflow-y-auto pl-3 border-l border-tagma-border/40">
          {prompt}
        </pre>
      )}
      {output && (
        <pre className="select-text text-[9px] text-tagma-text/85 whitespace-pre-wrap break-all overflow-hidden max-h-[240px] overflow-y-auto pl-3 border-l border-tagma-accent/40">
          {output}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

const SkillRenderer: ToolRenderer = ({ state }) => {
  const skillName = extractSkillNameFromToolState(state);
  const label =
    state.status === 'completed'
      ? 'Loaded skill'
      : state.status === 'running'
        ? 'Loading skill'
        : state.status === 'error'
          ? 'Skill failed'
          : 'Skill';
  const description = asString(state.input.description);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <BookOpen size={10} className="text-tagma-accent shrink-0" />
        <span className="text-tagma-muted/80">{label}</span>
        <code className="select-text font-mono text-tagma-text truncate">
          {skillName ?? 'unknown'}
        </code>
      </div>
      {description && <div className="text-[9px] text-tagma-muted/80 italic">{description}</div>}
      {state.status === 'error' && (
        <pre className="select-text text-[9px] text-tagma-error/90 whitespace-pre-wrap break-all pl-3 border-l border-tagma-error/40">
          {state.error}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Registry — opencode tool names are lowercase; lookup is case-insensitive
// to absorb any future renames.
// ---------------------------------------------------------------------------

const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  todowrite: TodoWriteRenderer,
  todoread: TodoReadRenderer,
  bash: BashRenderer,
  read: ReadRenderer,
  write: WriteRenderer,
  edit: EditRenderer,
  grep: GrepRenderer,
  glob: PathListRenderer,
  list: PathListRenderer,
  ls: PathListRenderer,
  webfetch: WebfetchRenderer,
  task: TaskRenderer,
  skill: SkillRenderer,
};

export function pickToolRenderer(tool: string): ToolRenderer | undefined {
  return TOOL_RENDERERS[tool] ?? TOOL_RENDERERS[tool.toLowerCase()];
}
