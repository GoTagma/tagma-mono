import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DriverPlugin } from '@tagma/core';
import {
  collectStream,
  isBinaryMissingError,
  runSpawn,
  runSpawnWith,
  type BunSpawnForRunner,
} from './bun-process-runner';

const DEFAULT_STDOUT_TAIL_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 40;
const HEARTBEAT_QUIET_MS = 250;
const HEARTBEAT_STOP_TIMEOUT_MS = 2_000;

function nodeArg(script: string): string[] {
  return ['node', '-e', script];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readerBackedStream(
  reads: Array<ReadableStreamReadResult<Uint8Array> | Error>,
): ReadableStream<Uint8Array> {
  let index = 0;
  const getReader = () => ({
    async read() {
      const next = reads[index++] ?? { done: true, value: undefined };
      if (next instanceof Error) throw next;
      return next;
    },
    // Bun 1.3.x can return a reader without releaseLock under concurrent
    // spawn. The fixture deliberately models that runtime shape.
  });
  return {
    getReader,
    [Symbol.asyncIterator]() {
      const reader = getReader();
      return {
        async next() {
          const next = await reader.read();
          if (next.done) {
            // This is the old for-await failure mode: Bun's iterator cleanup
            // assumes the partial reader implements releaseLock().
            (
              reader as unknown as {
                releaseLock(): void;
              }
            ).releaseLock();
          }
          return next;
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function heartbeatCount(path: string): number {
  try {
    return readFileSync(path, 'utf8').match(/\n/g)?.length ?? 0;
  } catch {
    return 0;
  }
}

async function waitForHeartbeatCount(
  path: string,
  minimum: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = heartbeatCount(path);
  while (count < minimum && Date.now() < deadline) {
    await delay(25);
    count = heartbeatCount(path);
  }
  if (count < minimum) {
    throw new Error(`grandchild produced ${count} heartbeats; expected at least ${minimum}`);
  }
  return count;
}

async function waitForHeartbeatToStop(path: string): Promise<number> {
  const deadline = Date.now() + HEARTBEAT_STOP_TIMEOUT_MS;
  let count = heartbeatCount(path);
  let lastChangeAt = Date.now();

  while (Date.now() < deadline) {
    await delay(50);
    const nextCount = heartbeatCount(path);
    if (nextCount !== count) {
      count = nextCount;
      lastChangeAt = Date.now();
    }
    if (Date.now() - lastChangeAt >= HEARTBEAT_QUIET_MS) return count;
  }

  throw new Error(`grandchild heartbeat did not stop within ${HEARTBEAT_STOP_TIMEOUT_MS}ms`);
}

function processTreeFixtureScript(heartbeatPath: string, pidPath: string): string {
  const grandchildScript = `
    const { appendFileSync, writeFileSync } = require('node:fs');
    const heartbeatPath = ${JSON.stringify(heartbeatPath)};
    writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    const beat = () => appendFileSync(heartbeatPath, 'beat\\n');
    beat();
    setInterval(beat, ${HEARTBEAT_INTERVAL_MS});
  `;

  return `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {
      stdio: 'ignore',
      windowsHide: true,
    });
    grandchild.once('error', (error) => {
      console.error(error);
      process.exit(1);
    });
    require('node:fs').writeSync(1, 'grandchild-started\\n');
    setInterval(() => {}, 1_000);
  `;
}

function fixturePid(path: string): number | null {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(value) && value > 0 && value !== process.pid ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + HEARTBEAT_STOP_TIMEOUT_MS;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
  if (processIsAlive(pid)) {
    throw new Error(`grandchild process ${pid} did not exit within ${HEARTBEAT_STOP_TIMEOUT_MS}ms`);
  }
}

async function cleanupFixtureProcess(pidPath: string): Promise<void> {
  const pid = fixturePid(pidPath);
  if (pid === null || !processIsAlive(pid)) return;

  if (process.platform === 'win32') {
    const result = Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }

  const deadline = Date.now() + 1_000;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
}

test('binary-missing detection does not confuse generic posix_spawn failures with ENOENT', () => {
  expect(
    isBinaryMissingError(
      Object.assign(new Error('posix_spawn failed: Permission denied'), { code: 'EACCES' }),
    ),
  ).toBe(false);
  expect(
    isBinaryMissingError(
      Object.assign(new Error('posix_spawn failed: No such file or directory'), {
        code: 'ENOENT',
      }),
    ),
  ).toBe(true);
});

test('collectStream bypasses iterator cleanup that assumes a missing releaseLock', async () => {
  const first = new TextEncoder().encode('hello ');
  const second = new TextEncoder().encode('world');
  const reads: Array<ReadableStreamReadResult<Uint8Array> | Error> = [
    { done: false, value: first },
    { done: false, value: second },
    { done: true, value: undefined },
  ];
  const legacyStream = readerBackedStream([...reads]);
  let legacyText = '';
  await expect(
    (async () => {
      for await (const chunk of legacyStream) {
        legacyText += new TextDecoder().decode(chunk);
      }
    })(),
  ).rejects.toThrow('releaseLock');
  expect(legacyText).toBe('hello world');

  const stream = readerBackedStream(reads);

  const result = await collectStream(stream, undefined, 1024, 'stdout');

  expect(result).toMatchObject({
    text: 'hello world',
    totalBytes: first.byteLength + second.byteLength,
    path: null,
    complete: true,
    error: null,
  });
});

test('collectStream reports a real mid-read failure without contaminating captured output', async () => {
  const prefix = new TextEncoder().encode('valid-prefix');
  const stream = readerBackedStream([
    { done: false, value: prefix },
    new Error('fixture stream fault'),
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'tagma-stream-fault-'));
  const outputPath = join(dir, 'stdout.log');

  try {
    const result = await collectStream(stream, outputPath, 1024, 'stdout');

    expect(result.text).toBe('valid-prefix');
    expect(result.totalBytes).toBe(prefix.byteLength);
    expect(result.path).toBe(outputPath);
    expect(result.complete).toBe(false);
    expect(result.error?.message).toBe('fixture stream fault');
    expect(result.text).not.toContain('[runner]');
    expect(readFileSync(outputPath, 'utf8')).toBe('valid-prefix');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpawn classifies an incomplete stream as output_error without parsing partial output', async () => {
  const prefix = new TextEncoder().encode('partial-json');
  const stdout = readerBackedStream([
    { done: false, value: prefix },
    new Error('fixture stream fault'),
  ]);
  let settleStderr!: () => void;
  let stderrSettledByKill = false;
  const stderr = {
    getReader() {
      return {
        read() {
          return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            settleStderr = () => {
              stderrSettledByKill = true;
              resolve({ done: true, value: undefined });
            };
          });
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  let parseCalls = 0;
  const driver = {
    name: 'fixture-driver',
    capabilities: {
      sessionResume: false,
      systemPrompt: false,
      outputFormat: true,
      enforcesPermissions: false,
    },
    async buildCommand() {
      return { args: ['fixture-command'] };
    },
    parseResult() {
      parseCalls += 1;
      return { normalizedOutput: 'must-not-be-used' };
    },
  } as DriverPlugin;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const killSignals: string[] = [];
  const spawnProcess = (() =>
    ({
      pid: 2_000_000_000,
      stdout,
      stderr,
      stdin: undefined,
      exited,
      kill(signal?: string) {
        killSignals.push(signal ?? 'SIGTERM');
        settleStderr();
        resolveExit(0);
      },
    }) as unknown as ReturnType<typeof Bun.spawn>) satisfies BunSpawnForRunner;

  const result = await runSpawnWith({ args: ['fixture-command'] }, driver, {}, spawnProcess);

  expect(result.exitCode).toBe(0);
  expect(result.failureKind).toBe('output_error');
  expect(result.stdout).toBe('partial-json');
  expect(result.stderr).toBe('');
  expect(result.normalizedOutput).toBeNull();
  expect(result.outputDiagnostics).toEqual([
    {
      stream: 'stdout',
      stage: 'read',
      message: 'fixture stream fault',
      capturedBytes: prefix.byteLength,
      path: null,
    },
  ]);
  expect(Object.isFrozen(result.outputDiagnostics)).toBe(true);
  expect(Object.isFrozen(result.outputDiagnostics?.[0])).toBe(true);
  expect(parseCalls).toBe(0);
  expect(killSignals).toEqual(['SIGTERM']);
  expect(stderrSettledByKill).toBe(true);
});

test('runSpawn preserves complete output from an external Node subprocess reader', async () => {
  const result = await runSpawn(
    {
      args: nodeArg(
        'const { writeSync } = require("node:fs"); writeSync(1, "reader-ok"); writeSync(2, "reader-warning")',
      ),
    },
    null,
  );

  expect(result.exitCode).toBe(0);
  expect(result.failureKind).toBeNull();
  expect(result.stdout).toBe('reader-ok');
  expect(result.stderr).toBe('reader-warning');
  expect(result.stdoutBytes).toBe('reader-ok'.length);
  expect(result.stderrBytes).toBe('reader-warning'.length);
  expect(result.outputDiagnostics).toBeUndefined();
});

test('runSpawn drains concurrent external Node subprocess readers independently', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      runSpawn(
        {
          args: nodeArg(
            `const { writeSync } = require("node:fs"); writeSync(1, "stdout-${index}"); writeSync(2, "stderr-${index}")`,
          ),
        },
        null,
      ),
    ),
  );

  for (const [index, result] of results.entries()) {
    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBeNull();
    expect(result.stdout).toBe(`stdout-${index}`);
    expect(result.stderr).toBe(`stderr-${index}`);
    expect(result.outputDiagnostics).toBeUndefined();
  }
});

test('runSpawn reports a missing cwd as a spawn error instead of a missing executable', async () => {
  const missingCwd = mkdtempSync(join(tmpdir(), 'tagma-missing-cwd-'));
  rmSync(missingCwd, { recursive: true, force: true });

  const result = await runSpawn({ args: nodeArg(''), cwd: missingCwd }, null);

  expect(result.failureKind).toBe('spawn_error');
  expect(result.missingBinary).toBeUndefined();
  expect(result.stderr).toContain('working directory');
  expect(result.stderr).toContain(missingCwd);
});

test('runSpawn resolves relative Windows executables with PATHEXT against cwd', async () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'tagma-pathext-'));
  try {
    writeFileSync(join(dir, 'reltool.cmd'), '@echo off\r\necho relative-ok\r\n');

    const result = await runSpawn(
      { args: ['.\\reltool'], cwd: dir, env: { PATHEXT: '.CMD' } },
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBe(null);
    expect(result.stdout).toContain('relative-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpawn resolves bare Windows commands from cwd and keeps the cache cwd-aware', async () => {
  if (process.platform !== 'win32') return;
  const firstDir = mkdtempSync(join(tmpdir(), 'tagma-bare-cwd-first-'));
  const secondDir = mkdtempSync(join(tmpdir(), 'tagma-bare-cwd-second-'));
  try {
    writeFileSync(join(firstDir, 'cwd-tool.cmd'), '@echo off\r\necho first-cwd\r\n');
    writeFileSync(join(secondDir, 'cwd-tool.cmd'), '@echo off\r\necho second-cwd\r\n');
    const spec = {
      args: ['cwd-tool'],
      env: { PATH: '', PATHEXT: '.CMD' },
    };

    const first = await runSpawn({ ...spec, cwd: firstDir }, null);
    const second = await runSpawn({ ...spec, cwd: secondDir }, null);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('first-cwd');
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('second-cwd');
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test('runSpawn accepts quoted, case-insensitive Windows PATH and PATHEXT values', async () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'tagma quoted path-'));
  const workingDir = mkdtempSync(join(dir, 'working-cwd-'));
  try {
    writeFileSync(join(dir, 'quoted-path-tool.bat'), '@echo off\r\necho quoted-path-ok\r\n');
    const result = await runSpawn(
      {
        args: ['quoted-path-tool'],
        cwd: workingDir,
        env: { pAtH: `"${dir}"`, pAtHeXt: '.BAT' },
      },
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBe(null);
    expect(result.stdout).toContain('quoted-path-ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpawn unwraps npm-style Windows .cmd shims without changing argv', async () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'tagma npm shim path-'));
  try {
    const entry = join(dir, 'node_modules', 'fixture', 'bin', 'cli.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'require("node:fs").writeSync(1, JSON.stringify(process.argv.slice(2)))');
    writeFileSync(
      join(dir, 'fixture.cmd'),
      '@echo off\r\n"%_prog%"  "%dp0%\\node_modules\\fixture\\bin\\cli.js" %*\r\n',
    );
    const exactArg = 'line one\r\nline "two" \\ $ ` & | < >';

    const result = await runSpawn(
      { args: ['fixture', exactArg], cwd: dir, env: { PATHEXT: '.CMD' } },
      null,
    );

    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBe(null);
    expect(result.stdout).toBe(JSON.stringify([exactArg]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpawn reports a missing bare Windows command after cwd and PATH lookup', async () => {
  if (process.platform !== 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'tagma-missing-bare-'));
  try {
    const result = await runSpawn(
      { args: ['definitely-missing-tagma-command'], cwd: dir, env: { pAtH: '', pAtHeXt: '.CMD' } },
      null,
    );

    expect(result.failureKind).toBe('binary_missing');
    expect(result.missingBinary).toBe('definitely-missing-tagma-command');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpawn falls back to bounded tail caps for non-finite values', async () => {
  const totalBytes = DEFAULT_STDOUT_TAIL_BYTES + 1024 * 1024;
  const result = await runSpawn(
    {
      args: nodeArg(`require("node:fs").writeSync(1, Buffer.alloc(${totalBytes}, "x"))`),
    },
    null,
    { maxStdoutTailBytes: Number.POSITIVE_INFINITY },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdoutBytes).toBe(totalBytes);
  expect(result.stdout).toContain('bytes truncated from head');
  expect(result.stdout).toContain('not persisted (no path configured)');
  expect(result.stdout).not.toContain('{dropped}');
  expect(result.stdout.length).toBeLessThan(DEFAULT_STDOUT_TAIL_BYTES + 1024);
});

test('runSpawn reports child output bytes before redaction', async () => {
  const result = await runSpawn(
    {
      args: nodeArg(
        'const { writeSync } = require("node:fs"); writeSync(1, "secret"); writeSync(2, "secret")',
      ),
    },
    null,
    {
      outputRedactor: (_stream, text) => text.replaceAll('secret', 'x'),
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('x');
  expect(result.stderr).toBe('x');
  expect(result.stdoutBytes).toBe('secret'.length);
  expect(result.stderrBytes).toBe('secret'.length);
});

test('runSpawn reports pre-spawn aborts as aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runSpawn({ args: nodeArg('console.log("never")') }, null, {
    signal: controller.signal,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.failureKind).toBe('aborted');
});

test('runSpawn distinguishes external aborts from timeouts', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const result = await runSpawn({ args: nodeArg('setTimeout(() => {}, 10_000)') }, null, {
    signal: controller.signal,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.failureKind).toBe('aborted');
});

test('runSpawn keeps task timeout classified as timeout', async () => {
  const result = await runSpawn({ args: nodeArg('setTimeout(() => {}, 10_000)') }, null, {
    timeoutMs: 20,
  });

  expect(result.exitCode).toBe(-1);
  expect(result.failureKind).toBe('timeout');
});

test('runSpawn timeout terminates the descendant process tree', async () => {
  if (
    process.platform !== 'win32' &&
    process.platform !== 'linux' &&
    process.platform !== 'darwin'
  ) {
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'tagma-process-tree-timeout-'));
  const heartbeatPath = join(dir, 'heartbeat.log');
  const pidPath = join(dir, 'grandchild.pid');
  const controller = new AbortController();
  let runPromise: ReturnType<typeof runSpawn> | null = null;

  try {
    runPromise = runSpawn(
      { args: nodeArg(processTreeFixtureScript(heartbeatPath, pidPath)) },
      null,
      { timeoutMs: 3_000, signal: controller.signal },
    );
    await waitForHeartbeatCount(heartbeatPath, 3, 2_500);

    const result = await runPromise;

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('timeout');
    expect(result.stdout).toContain('grandchild-started');
    const pid = fixturePid(pidPath);
    if (pid === null) throw new Error('grandchild did not publish its pid');
    const [stoppedCount] = await Promise.all([
      waitForHeartbeatToStop(heartbeatPath),
      waitForProcessExit(pid),
    ]);
    expect(stoppedCount).toBeGreaterThanOrEqual(3);
    expect(processIsAlive(pid)).toBe(false);
    await delay(HEARTBEAT_QUIET_MS);
    expect(heartbeatCount(heartbeatPath)).toBe(stoppedCount);
  } finally {
    controller.abort();
    if (runPromise) {
      await Promise.race([
        runPromise.then(
          () => undefined,
          () => undefined,
        ),
        delay(3_000),
      ]);
    }
    await cleanupFixtureProcess(pidPath);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test('runSpawn external abort terminates the descendant process tree', async () => {
  if (
    process.platform !== 'win32' &&
    process.platform !== 'linux' &&
    process.platform !== 'darwin'
  ) {
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'tagma-process-tree-abort-'));
  const heartbeatPath = join(dir, 'heartbeat.log');
  const pidPath = join(dir, 'grandchild.pid');
  const controller = new AbortController();
  let runPromise: ReturnType<typeof runSpawn> | null = null;

  try {
    runPromise = runSpawn(
      { args: nodeArg(processTreeFixtureScript(heartbeatPath, pidPath)) },
      null,
      { signal: controller.signal },
    );
    await waitForHeartbeatCount(heartbeatPath, 3, 4_000);
    controller.abort();

    const result = await runPromise;

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('aborted');
    expect(result.stdout).toContain('grandchild-started');
    const pid = fixturePid(pidPath);
    if (pid === null) throw new Error('grandchild did not publish its pid');
    const [stoppedCount] = await Promise.all([
      waitForHeartbeatToStop(heartbeatPath),
      waitForProcessExit(pid),
    ]);
    expect(stoppedCount).toBeGreaterThanOrEqual(3);
    expect(processIsAlive(pid)).toBe(false);
    await delay(HEARTBEAT_QUIET_MS);
    expect(heartbeatCount(heartbeatPath)).toBe(stoppedCount);
  } finally {
    controller.abort();
    if (runPromise) {
      await Promise.race([
        runPromise.then(
          () => undefined,
          () => undefined,
        ),
        delay(3_000),
      ]);
    }
    await cleanupFixtureProcess(pidPath);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test('runSpawn streams stdout/stderr to onOutputChunk before exit', async () => {
  const seen: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const result = await runSpawn(
    {
      args: nodeArg(
        'const { writeSync } = require("node:fs"); writeSync(1, "hello "); writeSync(2, "warn "); writeSync(1, "world")',
      ),
    },
    null,
    { onOutputChunk: (stream, text) => seen.push({ stream, text }) },
  );

  expect(result.exitCode).toBe(0);
  const stdout = seen
    .filter((c) => c.stream === 'stdout')
    .map((c) => c.text)
    .join('');
  const stderr = seen
    .filter((c) => c.stream === 'stderr')
    .map((c) => c.text)
    .join('');
  expect(stdout).toBe('hello world');
  expect(stderr).toBe('warn ');
  // The bounded tail in the result still matches what was streamed.
  expect(result.stdout).toBe('hello world');
});

test('runSpawn incrementally decodes UTF-8 split across stdout/stderr chunks', async () => {
  const expectedStdout = '你😀好';
  const expectedStderr = '警🚨报';
  const seen: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const script = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const { writeSync } = require('node:fs');
    const writeSplit = async (fd, text, cuts) => {
      const bytes = Buffer.from(text, 'utf8');
      let start = 0;
      for (const end of [...cuts, bytes.length]) {
        writeSync(fd, bytes.subarray(start, end));
        start = end;
        await sleep(75);
      }
    };
    Promise.all([
      writeSplit(1, ${JSON.stringify(expectedStdout)}, [1, 6]),
      writeSplit(2, ${JSON.stringify(expectedStderr)}, [2, 5]),
    ]).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  const result = await runSpawn({ args: nodeArg(script) }, null, {
    onOutputChunk: (stream, text) => seen.push({ stream, text }),
  });

  const liveStdoutChunks = seen
    .filter((chunk) => chunk.stream === 'stdout')
    .map((chunk) => chunk.text);
  const liveStderrChunks = seen
    .filter((chunk) => chunk.stream === 'stderr')
    .map((chunk) => chunk.text);

  expect(result.exitCode).toBe(0);
  expect(liveStdoutChunks.length).toBeGreaterThanOrEqual(2);
  expect(liveStderrChunks.length).toBeGreaterThanOrEqual(2);
  expect(liveStdoutChunks.join('')).toBe(expectedStdout);
  expect(liveStderrChunks.join('')).toBe(expectedStderr);
  expect(result.stdout).toBe(expectedStdout);
  expect(result.stderr).toBe(expectedStderr);
});

test('runSpawn does not let a throwing onOutputChunk abort the drain', async () => {
  const result = await runSpawn({ args: nodeArg('require("node:fs").writeSync(1, "abc")') }, null, {
    onOutputChunk: () => {
      throw new Error('sink boom');
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('abc');
});
