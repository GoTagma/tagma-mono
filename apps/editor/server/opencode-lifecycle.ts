/**
 * OpenCode server lifecycle.
 *
 * Spawns `opencode serve` as a child process on demand, returning a base URL
 * the browser-side opencode SDK client (`createOpencodeClient({ baseUrl })`)
 * connects to directly. Idempotent — repeat calls return the same running
 * instance until shutdown.
 *
 * Browser access requires CORS: opencode serve denies cross-origin requests
 * by default, so we pass `--cors <origin>` for every entry in ALLOWED_ORIGINS
 * (covers dev vite on :5173 and prod express on the configured PORT). Without
 * this the renderer's fetch/EventSource calls into the spawned opencode port
 * are blocked by the browser.
 *
 * Uses Bun.spawn + a Bun.listen free-port trick because bun-types in this
 * project doesn't ship Node's child_process / net types, and the rest of
 * the server (see routes/opencode.ts --version probe) is already Bun-native.
 */

import { ALLOWED_ORIGINS } from './allowed-origins.js';
import {
  buildEmbeddedOpencodeRuntimeConfig,
  prepareEmbeddedOpencodeRuntime,
} from './opencode-config.js';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface OpencodeServerAuth {
  username: string;
  password: string;
  authorization: string;
}

export interface OpencodeHandle {
  baseUrl: string;
  pid: number;
  cwd: string;
  auth: OpencodeServerAuth;
}

export function ensureRealTagmaDirectory(workspaceRoot: string): string {
  const tagmaCwd = join(workspaceRoot, '.tagma');
  if (existsSync(tagmaCwd) && lstatSync(tagmaCwd).isSymbolicLink()) {
    throw new Error('Refusing to start opencode with a symlinked .tagma directory');
  }
  mkdirSync(tagmaCwd, { recursive: true });
  return tagmaCwd;
}

// One opencode instance per workspace cwd. The sidecar hosts multiple
// WorkspaceState values (one per Electron window / open workspace) and each
// needs its own opencode scoped to `<workspace>/.tagma/` — sharing a single
// instance silently pins every chat to whichever workspace happened to open
// chat first. Maps are keyed by the absolute cwd the caller passed.
const handles = new Map<string, OpencodeHandle>();
const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const starting = new Map<string, Promise<OpencodeHandle>>();
const authByCwd = new Map<string, OpencodeServerAuth>();
let lifecycleGeneration = 0;

type OpencodeProcess = ReturnType<typeof Bun.spawn>;

function preferredWindowsPathEnvKey(): 'Path' | 'PATH' {
  return typeof process.env.Path === 'string' ? 'Path' : 'PATH';
}

function normalizePathEnv(env: Record<string, string>): Record<string, string> {
  if (process.platform !== 'win32') return env;
  // Windows treats env var names case-insensitively. Keep only one PATH
  // spelling so the bundled/user opencode lookup is deterministic.
  const value = env.Path ?? env.PATH;
  delete env.PATH;
  delete env.Path;
  if (typeof value === 'string') env[preferredWindowsPathEnvKey()] = value;
  return env;
}

export function createOpencodeServerAuth(): OpencodeServerAuth {
  const username = 'tagma';
  const password = randomBytes(32).toString('base64url');
  return {
    username,
    password,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  };
}

function getOrCreateOpencodeServerAuth(cwd: string): OpencodeServerAuth {
  const existing = authByCwd.get(cwd);
  if (existing) return existing;
  const auth = createOpencodeServerAuth();
  authByCwd.set(cwd, auth);
  return auth;
}

function requestOpencodeTermination(proc: OpencodeProcess, cwd: string, reason: string): void {
  if (process.platform === 'win32' && proc.pid != null) {
    try {
      const result = Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(proc.pid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (result.exitCode === 0 || result.exitCode === 128) {
        return;
      }
      const stderr = new TextDecoder().decode(result.stderr).trim();
      console.error(
        `[opencode] taskkill exited ${result.exitCode} during ${reason} for cwd=${cwd}: ${stderr}`,
      );
    } catch (err) {
      console.error(`[opencode] taskkill failed during ${reason} for cwd=${cwd}:`, err);
    }
  }
  try {
    if (process.platform === 'win32') {
      proc.kill();
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err) {
    console.error(`[opencode] kill failed during ${reason} for cwd=${cwd}:`, err);
  }
}

async function waitForExit(proc: OpencodeProcess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      proc.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateOpencodeProcess(
  proc: OpencodeProcess,
  cwd: string,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  requestOpencodeTermination(proc, cwd, reason);
  const exited = await waitForExit(proc, timeoutMs);
  if (exited || process.platform === 'win32') return;
  try {
    proc.kill('SIGKILL');
    await waitForExit(proc, 1_000);
  } catch (err) {
    console.error(`[opencode] SIGKILL failed during ${reason} for cwd=${cwd}:`, err);
  }
}

export function buildOpencodeEnv(
  cwd: string,
  auth: OpencodeServerAuth = getOrCreateOpencodeServerAuth(cwd),
): Record<string, string> {
  const runtime = prepareEmbeddedOpencodeRuntime(cwd);
  const keep = new Set([
    'PATH',
    'Path',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'SHELL',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
  const providerPrefixes = [
    'OPENAI_',
    'ANTHROPIC_',
    'GEMINI_',
    'GOOGLE_',
    'OPENROUTER_',
    'GROQ_',
    'AZURE_OPENAI_',
    'AWS_',
    'XAI_',
    'MISTRAL_',
    'DEEPSEEK_',
    'COHERE_',
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (keep.has(key) || providerPrefixes.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  env.HOME = runtime.home;
  env.USERPROFILE = runtime.home;
  env.APPDATA = runtime.appData;
  env.LOCALAPPDATA = runtime.localAppData;
  env.XDG_CONFIG_HOME = runtime.configHome;
  env.OPENCODE_CONFIG_DIR = runtime.configDir;
  env.XDG_DATA_HOME = runtime.dataHome;
  env.XDG_STATE_HOME = runtime.stateHome;
  env.XDG_CACHE_HOME = runtime.cacheHome;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildEmbeddedOpencodeRuntimeConfig(runtime));
  env.OPENCODE_SERVER_USERNAME = auth.username;
  env.OPENCODE_SERVER_PASSWORD = auth.password;
  return normalizePathEnv(env);
}

/**
 * Resolve the opencode binary, preferring the one shipped with the desktop
 * app over anything on the user's PATH — dev and release go through the same
 * staged binary so the chat panel never depends on a separate user install.
 *
 * Precedence (highest first):
 *   1. `$TAGMA_OPENCODE_RUNTIME_USER_DIR/bin/opencode[.exe]`
 *        — writable userData layer that in-app updates (/api/opencode/update)
 *          stage into. `$TAGMA_OPENCODE_USER_DIR` remains the update
 *          destination, while `TAGMA_OPENCODE_SKIP_USER_DIR=1` disables this
 *          runtime layer.
 *   2. `$TAGMA_OPENCODE_BUNDLED_DIR/bin/opencode[.exe]`
 *        — signed binary pinned at desktop build time
 *          (apps/electron/scripts/fetch-opencode.mjs).
 *   3. `apps/electron/build/opencode/<platform>-<arch>/bin/opencode[.exe]`
 *        — dev fallback: `bun run dev:server` pre-runs fetch-opencode.mjs
 *          which stages the binary here. The editor's dev server then picks
 *          it up at the same path layout packaged mode ships. This means a
 *          fresh clone with no opencode anywhere gets a working chat panel
 *          without touching the developer's global install.
 *   4. `"opencode"` — dev-only last resort (resolves via PATH). Never used
 *          in packaged mode: TAGMA_OPENCODE_BUNDLED_DIR is always set there,
 *          so reaching this branch means the install is broken and we throw
 *          with a clear error instead of letting PATH silently pick up a
 *          stale npm/bun `.cmd` shim.
 *
 * Why not rely on PATH alone? End users don't have bun or opencode installed
 * locally — the desktop app has to ship its own. And even when the bundled
 * dirs are on PATH (they are, via runtime-paths.ts), spawning by bare name
 * on Windows can match `.cmd` shims that launch through node.exe, producing
 * a confusing `Cannot find module .../node_modules/opencode-ai/bin/opencode`
 * failure when the user's prior global install has been pruned. Using an
 * absolute path to the pre-extracted Bun single-file executable avoids the
 * shim entirely and makes startup / signals behave predictably.
 */
export function resolveOpencodePathFallback(): string {
  return Bun.which('opencode') ?? 'opencode';
}

export function resolveOpencodeBinary(): string {
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const userRuntimeDir =
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR === '1'
      ? undefined
      : (process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR ?? process.env.TAGMA_OPENCODE_USER_DIR);
  const layers = [userRuntimeDir, process.env.TAGMA_OPENCODE_BUNDLED_DIR];
  for (const dir of layers) {
    if (!dir) continue;
    const candidate = join(dir, 'bin', exe);
    if (existsSync(candidate)) return candidate;
  }

  // Dev fallback — `apps/electron/scripts/fetch-opencode.mjs` stages binaries
  // into a per-target dir one level up from this file's package root. The
  // relative hop is `apps/editor/server/` → `apps/electron/build/opencode/…`.
  const devCandidate = join(
    import.meta.dirname,
    '..',
    '..',
    'electron',
    'build',
    'opencode',
    `${process.platform}-${process.arch}`,
    'bin',
    exe,
  );
  if (existsSync(devCandidate)) return devCandidate;

  // Packaged mode always sets TAGMA_OPENCODE_BUNDLED_DIR. Reaching here with
  // that env var set means the installer shipped without the binary (CI bug,
  // Defender quarantined it, user deleted it). Falling through to bare
  // `"opencode"` would then resolve via PATH — on machines that once had
  // `bun install -g opencode-ai` or `npm i -g opencode-ai` this picks up a
  // stale `.cmd` shim pointing at a node_modules tree that no longer exists,
  // yielding a `Cannot find module ...\node_modules\opencode-ai\bin\opencode`
  // crash that exits the sidecar before serve/health can respond. Fail fast
  // with an actionable error instead.
  const bundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  if (bundledDir) {
    throw new Error(
      `Bundled opencode binary is missing at ${join(bundledDir, 'bin', exe)}. ` +
        `This Tagma install is incomplete — reinstall the app, or open ` +
        `Settings → OpenCode CLI and click "Update" to stage a fresh binary.`,
    );
  }

  // Bun.spawn does not resolve bare Windows commands through PATHEXT. Resolve
  // the fallback up front so npm/bun opencode.cmd shims work in headless dev
  // setups that intentionally skipped the bundled-binary ensure step.
  return resolveOpencodePathFallback();
}

async function pickFreePort(): Promise<number> {
  // Ask the kernel for a free loopback port by listening on port 0, then
  // close immediately. Tiny race window before opencode binds, but in
  // practice nothing else grabs localhost ports mid-startup of our own
  // process. Good enough for a skeleton; swap to retry-on-EADDRINUSE if
  // this ever bites.
  const srv = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {}, open() {}, close() {}, drain() {}, error() {} },
  });
  const port = srv.port;
  srv.stop(true);
  return port;
}

/**
 * Loopback GET that bypasses any configured HTTP proxy. We can't use Bun's
 * fetch (or its `node:http` compat layer) here because both honor
 * `http_proxy` even for 127.0.0.1 — common on dev machines with a corporate
 * or traffic-inspector proxy, which misroutes the probe through the proxy
 * and yields a 502. Dropping to a raw TCP socket via `Bun.connect` avoids
 * any proxy resolution whatsoever.
 */
function loopbackGet(
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
  authorization?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let closeSocket: (() => void) | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const tryResolve = (allowIncompleteBody: boolean) => {
      const parsed = parseLoopbackHttpResponse(
        Buffer.concat(chunks.map((c) => Buffer.from(c))),
        allowIncompleteBody,
      );
      if (!parsed) return;
      clearTimeout(timer);
      done(() => {
        closeSocket?.();
        resolve(parsed);
      });
    };
    const timer = setTimeout(() => {
      done(() => reject(new Error(`timeout after ${timeoutMs}ms`)));
    }, timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          closeSocket = () => s.end();
          const authLine = authorization ? `Authorization: ${authorization}\r\n` : '';
          s.write(
            `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authLine}Connection: close\r\nAccept: */*\r\n\r\n`,
          );
        },
        data(_s, data) {
          chunks.push(data);
          try {
            tryResolve(false);
          } catch (err) {
            clearTimeout(timer);
            done(() => reject(err));
          }
        },
        close() {
          clearTimeout(timer);
          done(() => {
            try {
              const parsed = parseLoopbackHttpResponse(
                Buffer.concat(chunks.map((c) => Buffer.from(c))),
                true,
              );
              resolve(parsed ?? { status: 0, body: '' });
            } catch (err) {
              reject(err);
            }
          });
        },
        error(_s, err) {
          clearTimeout(timer);
          done(() => reject(err));
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
  });
}

function parseLoopbackHttpResponse(
  raw: Buffer,
  allowIncompleteBody: boolean,
): { status: number; body: string } | null {
  // Split headers from body on the first blank line; tolerate CRLF or bare LF
  // so a quirky server response doesn't confuse parsing.
  const crlfSep = raw.indexOf('\r\n\r\n');
  const lfSep = crlfSep === -1 ? raw.indexOf('\n\n') : -1;
  const headerEnd = crlfSep === -1 ? lfSep : crlfSep;
  if (headerEnd === -1) return allowIncompleteBody ? { status: 0, body: '' } : null;
  const sepLen = crlfSep === -1 ? 2 : 4;
  const headerBlock = raw.subarray(0, headerEnd).toString('latin1');
  const bodyBytes = raw.subarray(headerEnd + sepLen);
  const lines = headerBlock.split(/\r?\n/);
  const statusLine = lines.shift() ?? '';
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  const status = m ? Number(m[1]) : 0;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }

  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    const decoded = decodeCompleteChunkedBody(bodyBytes, allowIncompleteBody);
    if (!decoded) return null;
    return { status, body: decoded.toString('utf-8') };
  }

  const contentLength = headers.get('content-length');
  if (contentLength != null && contentLength !== '') {
    const expected = Number(contentLength);
    if (Number.isFinite(expected) && expected >= 0) {
      if (bodyBytes.length < expected && !allowIncompleteBody) return null;
      return { status, body: bodyBytes.subarray(0, expected).toString('utf-8') };
    }
  }

  if (!allowIncompleteBody) return null;
  return { status, body: bodyBytes.toString('utf-8') };
}

function decodeCompleteChunkedBody(body: Buffer, allowIncompleteBody: boolean): Buffer | null {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) return allowIncompleteBody ? Buffer.concat(chunks) : null;
    const sizeLine = body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('opencode health response has invalid chunk size');
    }
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size + 2 > body.length) return allowIncompleteBody ? Buffer.concat(chunks) : null;
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return allowIncompleteBody ? Buffer.concat(chunks) : null;
}

async function waitForHealth(
  baseUrl: string,
  timeoutMs = 300_000,
  authorization?: string,
): Promise<void> {
  const { hostname, port } = new URL(baseUrl);
  const portNum = Number(port);
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  let lastStatus: number | null = null;
  // opencode 1.14+ uses /global/health; earlier builds may use /health.
  // Try both on each probe; consider the server healthy when either returns OK.
  const healthPaths = ['/global/health', '/health'];
  while (Date.now() < deadline) {
    for (const path of healthPaths) {
      try {
        const res = await loopbackGet(hostname, portNum, path, 2_000, authorization);
        lastStatus = res.status;
        lastErr = null;
        if (res.status >= 200 && res.status < 300) {
          console.log(`[opencode] health check passed via ${path} (${res.status})`);
          return;
        }
        console.log(`[opencode] ${path} → ${res.status}: ${res.body.slice(0, 200)}`);
      } catch (err) {
        lastErr = err;
        lastStatus = null;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `opencode serve did not become healthy within ${timeoutMs}ms` +
      ` (lastStatus=${lastStatus}, lastErr=${String(lastErr)})`,
  );
}

export async function ensureOpencode(cwd: string): Promise<OpencodeHandle> {
  const existing = handles.get(cwd);
  if (existing) return existing;
  const inFlight = starting.get(cwd);
  if (inFlight) return inFlight;

  const startGeneration = lifecycleGeneration;
  const assertStartStillCurrent = () => {
    if (startGeneration !== lifecycleGeneration) {
      throw new Error('opencode startup canceled by shutdown/update');
    }
  };

  const startPromise = (async () => {
    const port = await pickFreePort();
    const auth = getOrCreateOpencodeServerAuth(cwd);
    assertStartStillCurrent();
    // Expand ALLOWED_ORIGINS into repeated --cors flags. opencode accepts the
    // flag multiple times (one origin per use). If the set is empty for some
    // reason we still spawn without CORS so server-to-server use (legacy
    // tests, curl) keeps working.
    const corsArgs: string[] = [];
    for (const origin of ALLOWED_ORIGINS) {
      corsArgs.push('--cors', origin);
    }
    const spawnArgs = ['serve', '--hostname', '127.0.0.1', '--port', String(port), ...corsArgs];
    const binary = resolveOpencodeBinary();
    assertStartStillCurrent();
    console.log('[opencode] spawning:', binary, spawnArgs.join(' '), 'cwd=', cwd);

    // Keep the tail of what opencode wrote to stderr before dying, so the
    // error we surface up to the user (via /api/opencode/chat/ensure) actually
    // contains a clue instead of a generic timeout. 8 KB is enough for a
    // Bun/opencode panic stack without pinning a lot of memory.
    const STDERR_TAIL_LIMIT = 8 * 1024;
    let stderrTail = '';
    const appendTail = (text: string) => {
      stderrTail += text;
      if (stderrTail.length > STDERR_TAIL_LIMIT) {
        stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_LIMIT);
      }
    };

    const proc = Bun.spawn([binary, ...spawnArgs], {
      cwd,
      env: buildOpencodeEnv(cwd, auth),
      stdout: 'pipe',
      stderr: 'pipe',
      onExit(exitedProcess, exitCode, signalCode) {
        console.log(`[opencode] exited code=${exitCode} signal=${signalCode} cwd=${cwd}`);
        // A restart may spawn and register the replacement before this older
        // process's exit callback runs. Only the currently tracked child may
        // clear the cwd maps; otherwise the stale callback detaches the new
        // process and later restarts incorrectly reuse its cached handle.
        if (children.get(cwd) !== exitedProcess) return;
        handles.delete(cwd);
        children.delete(cwd);
      },
    });
    // Track immediately, not only after health passes, so shutdown/update can
    // kill a process that is still booting or stuck before serving health.
    children.set(cwd, proc);

    // Best-effort log relay so crashes are visible in the editor's server log.
    // The reader loops are fire-and-forget; a stream error here must not become
    // an unhandled rejection that taints the sidecar event loop. If the pipe
    // closes abruptly (proc killed, stream errored), log once and exit cleanly.
    void (async () => {
      try {
        const reader = proc.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) process.stdout.write(`[opencode] ${new TextDecoder().decode(value)}`);
        }
      } catch (err) {
        console.warn(`[opencode] stdout reader ended with error for cwd=${cwd}:`, err);
      }
    })();
    void (async () => {
      try {
        const reader = proc.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const text = new TextDecoder().decode(value);
            process.stderr.write(`[opencode] ${text}`);
            appendTail(text);
          }
        }
      } catch (err) {
        console.warn(`[opencode] stderr reader ended with error for cwd=${cwd}:`, err);
      }
    })();

    const baseUrl = `http://127.0.0.1:${port}`;

    // Race health check vs. early exit: if opencode dies before becoming
    // healthy (Defender kills it, missing DLL, --cors flag reject, bad CPU
    // variant, etc.), waitForHealth would otherwise poll the full timeout
    // and report a generic "did not become healthy" with no hint of the
    // underlying cause. proc.exited winning the race gives us the exit code
    // + last stderr and lets callers fail fast.
    let healthResult: { kind: 'healthy' } | { kind: 'exited'; exitCode: number };
    try {
      healthResult = await Promise.race([
        waitForHealth(baseUrl, 300_000, auth.authorization).then(() => ({
          kind: 'healthy' as const,
        })),
        proc.exited.then((exitCode) => ({ kind: 'exited' as const, exitCode })),
      ]);
    } catch (err) {
      await terminateOpencodeProcess(proc, cwd, 'failed startup', 3_000);
      children.delete(cwd);
      throw err;
    }

    if (healthResult.kind === 'exited') {
      const tail = stderrTail.trim();
      children.delete(cwd);
      throw new Error(
        `opencode exited with code=${healthResult.exitCode} before becoming healthy.` +
          (tail ? ` Last stderr:\n${tail}` : ' (no stderr captured)'),
      );
    }

    const h: OpencodeHandle = { baseUrl, pid: proc.pid ?? -1, cwd, auth };
    handles.set(cwd, h);
    return h;
  })();

  starting.set(cwd, startPromise);
  try {
    return await startPromise;
  } finally {
    starting.delete(cwd);
  }
}

/**
 * Kill the opencode instance for `cwd` (if any) and respawn it. Used after the
 * user changes provider auth — opencode 1.14.x caches `/config/providers` and
 * `/provider` in memory, and `PUT /auth/{id}` / `DELETE /auth/{id}` write to
 * auth.json without invalidating that cache. A fresh process rereads auth.json
 * from disk. Returns the new handle (new port) so the caller can hand it back
 * to the browser, which resets its cached SDK client to match.
 *
 * Cheaper than restarting the whole sidecar: sessions live in `<cwd>/` on
 * disk, so killing opencode only loses the in-flight HTTP response (if any).
 * SSE consumers reconnect automatically via chat-store's subscribe loop.
 */
export async function restartOpencode(cwd: string): Promise<OpencodeHandle> {
  const proc = children.get(cwd);
  if (proc) {
    await terminateOpencodeProcess(proc, cwd, 'restart', 3_000);
    // onExit clears these, but clear defensively in case ensureOpencode runs
    // before the onExit callback fires.
    handles.delete(cwd);
    children.delete(cwd);
  }
  return ensureOpencode(cwd);
}

export async function stopOpencodeProcesses(timeoutMs = 3_000): Promise<void> {
  lifecycleGeneration += 1;
  const entries = Array.from(children.entries());
  children.clear();
  handles.clear();
  starting.clear();
  if (entries.length === 0) return;

  for (const [cwd, proc] of entries) {
    requestOpencodeTermination(proc, cwd, 'shutdown');
  }

  await Promise.all(
    entries.map(async ([cwd, proc]) => {
      const exited = await waitForExit(proc, timeoutMs);
      if (!exited && process.platform !== 'win32') {
        try {
          proc.kill('SIGKILL');
          await waitForExit(proc, 1_000);
        } catch (err) {
          console.error(`[opencode] SIGKILL failed during shutdown for cwd=${cwd}:`, err);
        }
      }
    }),
  );
}

export function shutdownOpencode(): void {
  void stopOpencodeProcesses().catch((err) => {
    console.error('[opencode] shutdown failed:', err);
  });
}

export function getOpencodeHandle(cwd: string): OpencodeHandle | null {
  return handles.get(cwd) ?? null;
}
