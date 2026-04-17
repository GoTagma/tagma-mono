import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SpawnSpec, DriverPlugin, TaskResult } from './types';
import { shellArgs } from './utils';

// Delay before escalating SIGTERM to SIGKILL when killing a timed-out process.
const SIGKILL_DELAY_MS = 3_000;

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

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal; // pipeline-level abort
}

/**
 * On Windows, Bun.spawn does NOT auto-append PATHEXT extensions like
 * CreateProcess does. A bare command like `claude` fails with ENOENT if the
 * actual file on disk is `claude.cmd` / `claude.bat` / `claude.ps1`. We
 * manually resolve the command against PATH + PATHEXT here so Drivers can
 * keep using short names (`claude`, `npx`, etc.) cross-platform.
 *
 * Results are cached by (cmd, envPath) key so repeated spawns of the same
 * command don't block the event loop with synchronous PATH scans.
 *
 * Returns the original name if resolution fails; Bun will raise the same
 * ENOENT it would have otherwise.
 */
const RESOLVED_EXE_CACHE_MAX = 128;
const resolvedExeCache = new Map<string, string | null>();

/** Evict the oldest entry when the cache is at capacity. */
function evictIfFull(): void {
  if (resolvedExeCache.size >= RESOLVED_EXE_CACHE_MAX) {
    // Map iteration order is insertion order — delete the first (oldest) key.
    const oldest = resolvedExeCache.keys().next().value;
    if (oldest !== undefined) resolvedExeCache.delete(oldest);
  }
}

function resolveWindowsExe(args: readonly string[], envPath: string): readonly string[] {
  if (process.platform !== 'win32' || args.length === 0) return args;
  const cmd = args[0]!;
  // Already a full path or has an extension → trust caller.
  if (isAbsolute(cmd) || /\.[a-z0-9]+$/i.test(cmd)) return args;

  const cacheKey = `${cmd}\x00${envPath}`;
  if (resolvedExeCache.has(cacheKey)) {
    // ?? null coerces undefined→null so cached is string|null and the !== null
    // check narrows it to string without a spurious 'undefined' arm.
    const cached = resolvedExeCache.get(cacheKey) ?? null;
    return cached !== null ? [cached, ...args.slice(1)] : args;
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
          evictIfFull();
          resolvedExeCache.set(cacheKey, candidate);
          return [candidate, ...args.slice(1)];
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
 */
function failResult(stderr: string, durationMs: number): TaskResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr,
    stderrPath: null,
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

  const mergedEnv = { ...process.env, ...(spec.env ?? {}) };
  const resolvedArgs = resolveWindowsExe(spec.args, mergedEnv.PATH ?? process.env.PATH ?? '');

  // ── 1. Spawn (catch ENOENT / bad-cwd up front) ────────────────────────
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(resolvedArgs as string[], {
      cwd: spec.cwd,
      env: mergedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: spec.stdin ? 'pipe' : undefined,
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
      proc.kill('SIGTERM');
      // If the child ignores SIGTERM, escalate to SIGKILL after 3 s.
      forceTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
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

  // ── 4. Collect output & wait (parallel to avoid pipe-buffer deadlock) ─
  const stdoutStream = typeof proc.stdout === 'object' ? proc.stdout : undefined;
  const stderrStream = typeof proc.stderr === 'object' ? proc.stderr : undefined;

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    stdoutStream ? new Response(stdoutStream).text() : Promise.resolve(''),
    stderrStream ? new Response(stderrStream).text() : Promise.resolve(''),
  ]);

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
      stderrPath: null,
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
      const meta = driver.parseResult(stdout, stderr);
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
        stderrPath: null,
        durationMs,
        sessionId: null,
        normalizedOutput: null,
        // H2: parseResult threw — the spawn itself succeeded, so the failure
        // is "the process exited but the driver couldn't parse it". Surface
        // that as exit_nonzero (when the actual exit was non-zero) or null
        // (when the underlying exit was 0 — UI will still mark it failed via
        // engine.ts because the result is incomplete).
        failureKind: exitCode === 0 ? null : 'exit_nonzero',
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
      stderrPath: null,
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
    stderrPath: null,
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
