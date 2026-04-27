import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import type { EnvPolicy, SpawnSpec, DriverPlugin, RunOptions, TaskResult } from '@tagma/core';
import { shellArgs } from '@tagma/core';

// Delay before escalating SIGTERM to SIGKILL when killing a timed-out process.
const SIGKILL_DELAY_MS = 3_000;

/**
 * Default cap for the in-memory tail retained for each stream. Picked so that
 * a task producing runaway output (AI agent bug, adversarial input) cannot
 * balloon the sidecar's RSS, while still being large enough that typical AI
 * responses (which top out around low-MB of text) are returned whole. Callers
 * that need different limits supply `RunOptions.maxStdoutTailBytes` /
 * `.maxStderrTailBytes`.
 */
const DEFAULT_STDOUT_TAIL_BYTES = 8 * 1024 * 1024; // 8 MB
const DEFAULT_STDERR_TAIL_BYTES = 4 * 1024 * 1024; // 4 MB

const MINIMAL_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USER',
  'USERNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

function pickEnv(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function buildChildEnv(
  overrides: Readonly<Record<string, string>> | undefined,
  policy: EnvPolicy | undefined,
): Record<string, string> {
  const effective = policy ?? { mode: 'minimal' as const };
  const base =
    effective.mode === 'inherit'
      ? pickEnv(Object.keys(process.env))
      : effective.mode === 'allowlist'
        ? { ...pickEnv(MINIMAL_ENV_KEYS), ...pickEnv(effective.keys) }
        : pickEnv(MINIMAL_ENV_KEYS);
  return { ...base, ...(overrides ?? {}) };
}

/**
 * On Windows, proc.kill('SIGTERM') / proc.kill('SIGKILL') only terminate the
 * direct child process. When the child is a .cmd/.bat wrapper (e.g. claude.cmd),
 * cmd.exe spawns the real process as a grandchild — proc.kill misses it entirely.
 * `taskkill /F /T /PID` kills the entire process tree rooted at the given PID.
 */
function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    const result = Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      // Exit code 128 = process not found (already exited) — not worth warning about
      if (result.exitCode !== 128) {
        console.error(
          `[killProcessTree] taskkill exited ${result.exitCode} for PID ${pid}: ${stderr.trim()}`,
        );
      }
    }
  } catch {
    /* best-effort — process may have already exited */
  }
}

function killUnixProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a stream to completion, persisting every chunk to `filePath` (when
 * provided) while keeping only the last `maxTailBytes` bytes in memory.
 *
 * Why the split: large child outputs (multi-MB AI responses, verbose debug
 * dumps) used to accumulate entirely in memory via `new Response(s).text()`,
 * which let a runaway task balloon the sidecar's RSS. Streaming to disk +
 * bounded tail gives callers: (a) unbounded data fidelity on disk, (b) fixed
 * memory footprint, (c) the tail — which is almost always what callers
 * actually consume (final AI answer, error summary, last N lines).
 *
 * Backpressure: we `await fh.write(chunk)` per chunk, so if disk is slow we
 * naturally slow the reader — but we do NOT stop reading the pipe, so the
 * child never blocks on a full stdout pipe. Disk errors don't abort the
 * stream; we close the handle, null it, and keep consuming into the tail
 * buffer only (with a breadcrumb in the returned text).
 *
 * Tail eviction: drops whole chunks from the front until total retained is
 * at or below the cap. If a single chunk alone exceeds the cap (rare — would
 * require a >cap-bytes chunkless burst from the child), we slice its tail.
 * UTF-8 boundaries at the slice point may emit replacement characters when
 * decoded — acceptable (the trailing/leading codepoint is a cosmetic loss).
 */
async function collectStream(
  stream: ReadableStream<Uint8Array> | undefined,
  filePath: string | undefined,
  maxTailBytes: number,
): Promise<{ text: string; totalBytes: number; path: string | null }> {
  if (!stream) return { text: '', totalBytes: 0, path: null };

  let fh: FileHandle | null = null;
  let diskWriteFailed = false;
  if (filePath) {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      fh = await open(filePath, 'w');
    } catch (err) {
      console.error(
        `[runner] failed to open ${filePath} for output streaming: ${err instanceof Error ? err.message : String(err)}`,
      );
      diskWriteFailed = true;
    }
  }

  const chunks: Uint8Array[] = [];
  let tailBytes = 0;
  let totalBytes = 0;
  let streamError: Error | null = null;

  try {
    // Use for await...of to avoid Bun bug where getReader() returns an
    // incomplete reader missing releaseLock() under concurrent spawn.
    // https://github.com/oven-sh/bun/issues/28952
    //
    // Bun 1.3.x also has sporadic failures iterating a spawned process's
    // stream under concurrent Bun.spawn — the iterator throws mid-drain even
    // when the child exited 0. We record the error as a breadcrumb instead
    // of propagating, so the caller still sees the real exitCode from
    // proc.exited and a task that the OS considered successful doesn't get
    // marked failed over a runtime stream glitch.
    for await (const value of stream as AsyncIterable<Uint8Array>) {
      totalBytes += value.length;

      // Disk: persist every byte. Failure here degrades to tail-only mode
      // without interrupting the stream (child must not block on pipe fill).
      if (fh) {
        try {
          await fh.write(value);
        } catch (err) {
          console.error(
            `[runner] disk write failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            await fh.close();
          } catch {
            /* ignore */
          }
          fh = null;
          diskWriteFailed = true;
        }
      }

      // Tail: append then evict whole chunks from the head while the total
      // retained exceeds the cap. Keep at least one chunk so short outputs
      // aren't lost entirely. Post-condition: tailBytes <= maxTailBytes OR
      // only one chunk remains (handled by the next block).
      chunks.push(value);
      tailBytes += value.length;
      while (chunks.length > 1 && tailBytes > maxTailBytes) {
        tailBytes -= chunks.shift()!.length;
      }
      // Pathological: a single chunk larger than the cap. Slice its tail.
      if (chunks.length === 1 && chunks[0]!.length > maxTailBytes) {
        const only = chunks[0]!;
        chunks[0] = only.slice(only.length - maxTailBytes);
        tailBytes = chunks[0]!.length;
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[runner] stream read failed: ${streamError.message} — returning partial output`,
    );
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Decode retained chunks. `stream: true` lets the decoder buffer partial
  // code points across chunks, handling all boundaries except the very first
  // chunk (which may itself start mid-codepoint after eviction) — that
  // boundary gets a U+FFFD replacement, which is preferable to throwing.
  const decoder = new TextDecoder();
  let text = '';
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  text += decoder.decode();

  if (totalBytes > tailBytes) {
    const dropped = totalBytes - tailBytes;
    const pathHint = filePath
      ? diskWriteFailed
        ? `${filePath} (partial — disk write failed mid-stream)`
        : filePath
      : 'not persisted (no path configured)';
    text = `[…${dropped} bytes truncated from head — full output at: ${pathHint}]\n${text}`;
  }

  if (streamError) {
    text = text + `\n[runner] stream read aborted: ${streamError.message}`;
  }

  return {
    text,
    totalBytes,
    // Return the path even on partial-write failure so operators can still
    // inspect the head bytes we managed to persist.
    path: filePath ?? null,
  };
}

/**
 * On Windows, Bun.spawn does NOT auto-append PATHEXT extensions like
 * CreateProcess does. A bare command like `claude` fails with ENOENT if the
 * actual file on disk is `claude.cmd` / `claude.bat` / `claude.ps1`. We
 * manually resolve the command against PATH + PATHEXT here so Drivers can
 * keep using short names (`claude`, `npx`, etc.) cross-platform.
 *
 * We also auto-unwrap npm-generated .cmd shims into direct `node <js>`
 * invocations. Spawning the .cmd routes argv through cmd.exe, which silently
 * truncates any argv element at the first newline — a multi-line prompt
 * reaches the child as just its first line. By targeting the underlying JS
 * entry point directly we bypass cmd.exe entirely and newlines survive.
 *
 * Results are cached by (cmd, envPath) key so repeated spawns of the same
 * command don't block the event loop with synchronous PATH/shim scans.
 *
 * Returns the original name if resolution fails; Bun will raise the same
 * ENOENT it would have otherwise.
 */
const RESOLVED_EXE_CACHE_MAX = 128;
// A cache entry is the replacement argv head for the command:
//   - [path]            — a single resolved executable (e.g. `foo.exe`)
//   - [node, jsEntry]   — an npm-shim unwrapped into `node <js>`
//   - null              — resolution failed, leave the original name
const resolvedExeCache = new Map<string, readonly string[] | null>();

/** Evict the oldest entry when the cache is at capacity. */
function evictIfFull(): void {
  if (resolvedExeCache.size >= RESOLVED_EXE_CACHE_MAX) {
    // Map iteration order is insertion order — delete the first (oldest) key.
    const oldest = resolvedExeCache.keys().next().value;
    if (oldest !== undefined) resolvedExeCache.delete(oldest);
  }
}

/**
 * Parse an npm-generated .cmd shim and return the underlying JS entry path.
 *
 * npm's shim has the shape:
 *   "%_prog%"  "%dp0%\node_modules\<pkg>\bin\<script>" %*
 *
 * We extract the second double-quoted path, substitute `%dp0%` with the
 * wrapper's own directory, and return the absolute JS path. Returns null for
 * anything that doesn't match the npm-shim pattern (user-written .cmd
 * scripts, non-node tools, etc.), which keeps the caller on the .cmd path.
 */
function parseNpmCmdShim(wrapperPath: string): string | null {
  let contents: string;
  try {
    contents = readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }
  const execLine = contents
    .split(/\r?\n/)
    .find((l) => l.includes('%*') && l.includes('%dp0%'));
  if (!execLine) return null;
  const quoted = execLine.match(/"([^"]+)"/g);
  if (!quoted || quoted.length < 2) return null;
  const rawTarget = quoted[1]!.slice(1, -1); // strip surrounding quotes
  const wrapperDir = dirname(wrapperPath);
  // %dp0% expands to wrapper dir with a trailing backslash; strip either form.
  const expanded = rawTarget.replace(/%dp0%\\?/i, '').replace(/\//g, '\\');
  const abs = isAbsolute(expanded) ? expanded : pathResolve(wrapperDir, expanded);
  return existsSync(abs) ? abs : null;
}

/**
 * Given a resolved .cmd/.bat path, return the argv prefix that should be
 * spawned instead. For npm shims this is `[node, js-entry]`; for everything
 * else it's `[wrapperPath]` (unchanged, caller keeps using the wrapper).
 */
function unwrapCmdShim(wrapperPath: string): readonly string[] {
  if (!/\.(cmd|bat)$/i.test(wrapperPath)) return [wrapperPath];
  const jsEntry = parseNpmCmdShim(wrapperPath);
  if (!jsEntry) return [wrapperPath];
  // Prefer node colocated with the wrapper (npm global bin often ships one).
  const colocated = join(dirname(wrapperPath), 'node.exe');
  const nodeExe = existsSync(colocated) ? colocated : 'node';
  return [nodeExe, jsEntry];
}

function resolveWindowsExe(args: readonly string[], envPath: string): readonly string[] {
  if (process.platform !== 'win32' || args.length === 0) return args;
  const cmd = args[0]!;
  // Already a full path or has an extension → trust caller. We still attempt
  // shim unwrapping when the caller handed us a bare .cmd/.bat so drivers
  // that resolve the shim themselves still benefit from the cmd.exe bypass.
  if (isAbsolute(cmd) || /\.[a-z0-9]+$/i.test(cmd)) {
    if (/\.(cmd|bat)$/i.test(cmd) && existsSync(cmd)) {
      const unwrapped = unwrapCmdShim(cmd);
      if (unwrapped.length === 2) return [...unwrapped, ...args.slice(1)];
    }
    return args;
  }

  const cacheKey = `${cmd}\x00${envPath}`;
  if (resolvedExeCache.has(cacheKey)) {
    // ?? null coerces undefined→null so the subsequent guard narrows cleanly.
    const cached = resolvedExeCache.get(cacheKey) ?? null;
    return cached !== null ? [...cached, ...args.slice(1)] : args;
  }

  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC')
    .split(';')
    .filter(Boolean);
  const dirs = envPath.split(';').filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          const head = unwrapCmdShim(candidate);
          evictIfFull();
          resolvedExeCache.set(cacheKey, head);
          return [...head, ...args.slice(1)];
        }
      } catch {
        /* stat race — skip */
      }
    }
  }
  evictIfFull();
  resolvedExeCache.set(cacheKey, null);
  return args;
}

/**
 * H2: Build a "failed before spawn" result. Tagged as 'spawn_error' so the
 * engine can show a useful classification ("driver tried to launch X but
 * the binary wasn't found") rather than the misleading "timeout".
 *
 * Pre-spawn failures never opened the output files, so stdoutPath /
 * stderrPath are null regardless of what the caller passed in opts — there
 * is nothing on disk to point at.
 */
function failResult(stderr: string, durationMs: number): TaskResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr,
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: stderr.length,
    durationMs,
    sessionId: null,
    normalizedOutput: null,
    failureKind: 'spawn_error',
  };
}

/**
 * R2: Validate a SpawnSpec returned by a third-party driver. Returns null on
 * success or a human-readable error message describing the first violation.
 *
 * Catching this here is critical: an undetected bad spec ends up calling
 * Bun.spawn with garbage and the resulting TypeError leaks into engine
 * processTask's catch block as "Cannot read properties of undefined". By
 * validating here we surface a clear "Driver X returned invalid args" message
 * instead, and short-circuit before holding any process resources.
 */
export function validateSpawnSpec(spec: unknown, driverName: string): string | null {
  if (!spec || typeof spec !== 'object') {
    return `Driver "${driverName}".buildCommand returned ${spec === null ? 'null' : typeof spec}, expected SpawnSpec object`;
  }
  const s = spec as Record<string, unknown>;
  if (!Array.isArray(s.args)) {
    return `Driver "${driverName}".buildCommand returned spec.args of type ${typeof s.args}, expected string[]`;
  }
  if (s.args.length === 0) {
    return `Driver "${driverName}".buildCommand returned an empty spec.args array`;
  }
  for (let i = 0; i < s.args.length; i++) {
    if (typeof s.args[i] !== 'string') {
      return `Driver "${driverName}".buildCommand returned spec.args[${i}] of type ${typeof s.args[i]}, expected string`;
    }
  }
  if (typeof s.args[0] !== 'string' || s.args[0].length === 0) {
    return `Driver "${driverName}".buildCommand returned an empty executable name in spec.args[0]`;
  }
  if (s.cwd !== undefined && typeof s.cwd !== 'string') {
    return `Driver "${driverName}".buildCommand returned spec.cwd of type ${typeof s.cwd}, expected string or undefined`;
  }
  if (s.stdin !== undefined && typeof s.stdin !== 'string') {
    return `Driver "${driverName}".buildCommand returned spec.stdin of type ${typeof s.stdin}, expected string or undefined`;
  }
  if (s.env !== undefined) {
    if (!s.env || typeof s.env !== 'object' || Array.isArray(s.env)) {
      return `Driver "${driverName}".buildCommand returned spec.env that is not a plain object`;
    }
    for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        return `Driver "${driverName}".buildCommand returned spec.env.${k} of type ${typeof v}, expected string`;
      }
    }
  }
  return null;
}

export async function runSpawn(
  spec: SpawnSpec,
  driver: DriverPlugin | null,
  opts: RunOptions = {},
): Promise<TaskResult> {
  const { timeoutMs, signal } = opts;
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);

  if (signal?.aborted) {
    return failResult('Pipeline aborted before spawn', 0);
  }

  // R2: validate the spec before touching it. A third-party driver that
  // returns a malformed SpawnSpec used to crash deep inside Bun.spawn with
  // an opaque TypeError; now we report a clear "Driver X returned …" message.
  const validationError = validateSpawnSpec(spec, driver?.name ?? '<unknown>');
  if (validationError !== null) {
    return failResult(validationError, elapsed());
  }

  const mergedEnv = buildChildEnv(spec.env, opts.envPolicy);
  const resolvedArgs = resolveWindowsExe(
    spec.args,
    mergedEnv.PATH ?? mergedEnv.Path ?? process.env.PATH ?? process.env.Path ?? '',
  );

  // ── 1. Spawn (catch ENOENT / bad-cwd up front) ────────────────────────
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(resolvedArgs as string[], {
      cwd: spec.cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: spec.stdin ? 'pipe' : undefined,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    return failResult(String(err), elapsed());
  }

  // ── 2. Write stdin ─────────────────────────────────────────────────────
  // Child may exit before reading (e.g. quick-fail commands that don't
  // touch stdin) → swallow EPIPE rather than surfacing it as an
  // engine-level error.
  if (spec.stdin && proc.stdin && typeof proc.stdin !== 'number') {
    try {
      await proc.stdin.write(spec.stdin);
      await proc.stdin.end();
    } catch {
      /* ignore EPIPE / closed-pipe errors */
    }
  }

  // ── 3. Timeout & abort handling ────────────────────────────────────────
  let killedByUs = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const killGracefully = () => {
    if (killedByUs) return;
    killedByUs = true;

    if (process.platform === 'win32') {
      // On Windows, kill the entire process tree via taskkill. This handles
      // .cmd wrappers and nested child processes that proc.kill() misses.
      killProcessTree(proc.pid);
    } else {
      if (!killUnixProcessGroup(proc.pid, 'SIGTERM')) {
        proc.kill('SIGTERM');
      }
      // If the child ignores SIGTERM, escalate to SIGKILL after 3 s.
      forceTimer = setTimeout(() => {
        try {
          if (!killUnixProcessGroup(proc.pid, 'SIGKILL')) {
            proc.kill('SIGKILL');
          }
        } catch {
          /* already exited */
        }
      }, SIGKILL_DELAY_MS);
    }
  };

  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      killGracefully();
    }, timeoutMs);
  }

  const onAbort = () => killGracefully();
  if (signal) {
    if (signal.aborted) {
      killGracefully();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // ── 4. Collect output & wait ──────────────────────────────────────────
  // Both streams are drained concurrently with `proc.exited` to avoid the
  // classic pipe-buffer deadlock (child blocks on a full stdout pipe, parent
  // is blocked waiting on exit which the child can't reach). Each stream is
  // persisted to disk via `collectStream` as it arrives so we never hold the
  // full output in memory — only the bounded tail.
  const stdoutStream = typeof proc.stdout === 'object' ? proc.stdout : undefined;
  const stderrStream = typeof proc.stderr === 'object' ? proc.stderr : undefined;
  const stdoutCap = opts.maxStdoutTailBytes ?? DEFAULT_STDOUT_TAIL_BYTES;
  const stderrCap = opts.maxStderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;

  const [exitCode, stdoutResult, stderrResult] = await Promise.all([
    proc.exited,
    collectStream(stdoutStream, opts.stdoutPath, stdoutCap),
    collectStream(stderrStream, opts.stderrPath, stderrCap),
  ]);
  const stdout = stdoutResult.text;
  const stderr = stderrResult.text;
  const stdoutPath = stdoutResult.path;
  const stderrPath = stderrResult.path;
  const stdoutBytes = stdoutResult.totalBytes;
  const stderrBytes = stderrResult.totalBytes;

  // ── 5. Cleanup timers & listeners ──────────────────────────────────────
  if (timer) clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (signal) signal.removeEventListener('abort', onAbort);

  const durationMs = elapsed();

  // We initiated the kill (timeout or abort) — always treat as non-success
  // regardless of exit code. A process that catches SIGTERM and exits 0 still
  // hit the timeout; letting it pass as success would unblock downstream tasks
  // incorrectly. The `timedOut` flag guards against the narrow race where the
  // process exits naturally at the exact moment the timeout fires — even if
  // killedByUs wasn't set in time, the timeout intention still applies.
  if (killedByUs || timedOut) {
    return {
      exitCode: -1,
      stdout,
      stderr,
      stdoutPath,
      stderrPath,
      stdoutBytes,
      stderrBytes,
      durationMs,
      sessionId: null,
      normalizedOutput: null,
      // H2: explicit kind so engine.ts no longer has to guess "is exitCode -1
      // a timeout or a spawn-failure?" Both used to share the same code.
      failureKind: 'timeout',
    };
  }

  // ── 6. Let driver extract metadata ─────────────────────────────────────
  // R1: parseResult is third-party code — wrap it in try/catch so a buggy
  // extractor doesn't discard a perfectly good spawn result. R5: even on
  // success, type-guard sessionId/normalizedOutput so a mistyped return
  // value doesn't poison sessionMap/normalizedMap downstream.
  let sessionId: string | null = null;
  let normalizedOutput: string | null = null;
  // M12: drivers can flip a task's terminal status to failed even when the
  // process exited 0 (e.g. opencode returning `{type:"error"}` JSON). When
  // the flag is set, we synthesize a non-zero exit code and append a reason
  // line to stderr so engine.ts marks the task as failed with a useful
  // explanation instead of letting the error JSON pass through as success.
  let forcedFailureMessage: string | null = null;
  if (driver?.parseResult) {
    try {
      const meta = await driver.parseResult(stdout, stderr);
      if (meta && typeof meta === 'object') {
        if (typeof meta.sessionId === 'string' && /^[\w.-]{1,256}$/.test(meta.sessionId)) {
          sessionId = meta.sessionId;
        }
        if (typeof meta.normalizedOutput === 'string') {
          normalizedOutput = meta.normalizedOutput;
        }
        if (meta.forceFailure === true) {
          forcedFailureMessage =
            typeof meta.forceFailureReason === 'string'
              ? meta.forceFailureReason
              : 'Driver flagged task as failed (forceFailure)';
        }
      }
    } catch (err) {
      // The spawn itself succeeded; only metadata extraction failed.
      // Fall through with sessionId/normalizedOutput = null and append a
      // breadcrumb to stderr so the user can see WHY continue_from broke.
      const msg = err instanceof Error ? err.message : String(err);
      const note = `\n[runner] driver "${driver.name}".parseResult threw: ${msg}`;
      return {
        exitCode,
        stdout,
        stderr: stderr + note,
        stdoutPath,
        stderrPath,
        stdoutBytes,
        stderrBytes,
        durationMs,
        sessionId: null,
        normalizedOutput: null,
        failureKind: 'parse_error',
      };
    }
  }

  // M12: when the driver forced a failure, treat as exit_nonzero with the
  // reason appended to stderr so users see WHY the task failed without
  // having to dig through driver-specific JSON.
  if (forcedFailureMessage !== null) {
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      stdout,
      stderr: stderr + (stderr.endsWith('\n') ? '' : '\n') + `[driver] ${forcedFailureMessage}`,
      stdoutPath,
      stderrPath,
      stdoutBytes,
      stderrBytes,
      durationMs,
      sessionId,
      normalizedOutput,
      failureKind: 'exit_nonzero',
    };
  }
  return {
    exitCode,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    stdoutBytes,
    stderrBytes,
    durationMs,
    sessionId,
    normalizedOutput,
    // H2: success vs nonzero exit. Engine uses this to short-circuit the
    // timeout branch even if a third-party driver returns -1 by mistake.
    failureKind: exitCode === 0 ? null : 'exit_nonzero',
  };
}

export async function runCommand(
  command: string,
  cwd: string,
  opts: RunOptions = {},
): Promise<TaskResult> {
  const spec: SpawnSpec = {
    args: shellArgs(command),
    cwd,
  };
  return runSpawn(spec, null, opts);
}
