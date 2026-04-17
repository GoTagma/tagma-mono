import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';

/**
 * Structured record emitted for every log line. Consumers (e.g. the editor
 * server) use this to stream process-level detail into UIs alongside the
 * on-disk pipeline.log. `taskId` is extracted from a `[task:<id>]` prefix
 * when the call site passes one, or overridden explicitly via the optional
 * `taskId` argument on `section`/`quiet` (which carry no prefix).
 */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet';

export interface LogRecord {
  readonly level: LogLevel;
  readonly taskId: string | null;
  readonly timestamp: string;
  readonly text: string;
}

export type LogListener = (record: LogRecord) => void;

const TASK_PREFIX_RE = /\[task:([^\]]+)\]/;

function taskIdFromPrefix(prefix: string): string | null {
  const m = TASK_PREFIX_RE.exec(prefix);
  return m ? m[1] : null;
}

/**
 * Dual-channel logger.
 *
 *   - `info/warn/error` → console AND file (brief, user-visible events)
 *   - `debug`           → file ONLY (verbose diagnostics)
 *   - `section`         → file ONLY (visual separators)
 *   - `quiet`           → file ONLY (bulk payload like full stdout dumps)
 *
 * Log file path: <workDir>/.tagma/logs/<runId>/pipeline.log (one file per pipeline run,
 * truncated on construction). Every line is also forwarded to the optional
 * `onLine` callback as a structured `LogRecord`, so callers that want to
 * stream the run process over IPC/SSE don't need to tail the file.
 */
export class Logger {
  private readonly filePath: string;
  private readonly runDir: string;
  private readonly onLine: LogListener | null;
  /** Persistent file descriptor for append writes (avoids open/close per line). */
  private fd: number | null;

  constructor(workDir: string, runId: string, onLine?: LogListener) {
    this.runDir = resolve(workDir, '.tagma', 'logs', runId);
    this.filePath = resolve(this.runDir, 'pipeline.log');
    this.onLine = onLine ?? null;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const header =
      `# Pipeline run ${runId} @ ${new Date().toISOString()}\n` +
      `# Host: ${process.platform} ${process.arch}  Bun: ${process.versions.bun ?? 'n/a'}\n` +
      `# Work dir: ${workDir}\n\n`;
    writeFileSync(this.filePath, header);
    // Open once for all subsequent appends (O_APPEND is implied by 'a' flag)
    this.fd = openSync(this.filePath, 'a');
  }

  info(prefix: string, message: string): void {
    const ts = timestamp();
    const line = `${ts} ${prefix} ${message}`;
    // eslint-disable-next-line no-console
    console.log(line);
    this.emit('info', ts, line, taskIdFromPrefix(prefix));
    this.append(line);
  }

  warn(prefix: string, message: string): void {
    const ts = timestamp();
    const line = `${ts} ${prefix} WARN: ${message}`;
    console.warn(line);
    this.emit('warn', ts, line, taskIdFromPrefix(prefix));
    this.append(line);
  }

  error(prefix: string, message: string): void {
    const ts = timestamp();
    const line = `${ts} ${prefix} ERROR: ${message}`;
    console.error(line);
    this.emit('error', ts, line, taskIdFromPrefix(prefix));
    this.append(line);
  }

  /** File-only diagnostic log line. */
  debug(prefix: string, message: string): void {
    const ts = timestamp();
    const line = `${ts} ${prefix} DEBUG: ${message}`;
    this.emit('debug', ts, line, taskIdFromPrefix(prefix));
    this.append(line);
  }

  /** File-only visual separator with title. */
  section(title: string, taskId?: string | null): void {
    const ts = timestamp();
    const text = `\n━━━ ${title} ━━━`;
    this.emit('section', ts, text, taskId ?? null);
    this.append(text);
  }

  /** File-only bulk payload (e.g. full stdout / stderr dumps). */
  quiet(message: string, taskId?: string | null): void {
    const ts = timestamp();
    this.emit('quiet', ts, message, taskId ?? null);
    this.append(message);
  }

  private append(line: string): void {
    if (this.fd === null) return;
    try {
      const data = line.endsWith('\n') ? line : line + '\n';
      writeSync(this.fd, data);
    } catch {
      // Swallow log write failures; engine correctness shouldn't depend on logging.
    }
  }

  /** Close the persistent file handle. Called by the engine at run completion. */
  close(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }

  private emit(level: LogLevel, ts: string, text: string, taskId: string | null): void {
    if (!this.onLine) return;
    try {
      this.onLine({ level, taskId, timestamp: ts, text });
    } catch {
      // Never let a listener error derail the pipeline.
    }
  }

  get path(): string {
    return this.filePath;
  }

  /** Directory that holds all artifacts for this run (pipeline.log, *.stderr, etc.). */
  get dir(): string {
    return this.runDir;
  }
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/** Return the last `n` non-empty lines of `text`, joined with newlines. */
export function tailLines(text: string, n: number): string {
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  return lines.slice(-n).join('\n');
}

/**
 * Truncate a blob to at most `maxBytes` UTF-8 bytes for log embedding,
 * appending a marker when truncation occurred.
 * Uses TextEncoder so CJK and emoji (multi-byte) characters are counted correctly.
 */
export function clip(text: string, maxBytes = 16 * 1024): string {
  if (!text) return '';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const omittedBytes = bytes.length - maxBytes;
  // TextDecoder handles partial code-point boundaries safely (replacement char insertion)
  const truncated = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return truncated + `\n…[truncated ${omittedBytes} bytes]`;
}
