import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isBinaryMissingError, runSpawn } from './bun-process-runner';

const DEFAULT_STDOUT_TAIL_BYTES = 8 * 1024 * 1024;

function nodeArg(script: string): string[] {
  return ['node', '-e', script];
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
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
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
    { args: nodeArg(`process.stdout.write("x".repeat(${totalBytes}))`) },
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
    { args: nodeArg('process.stdout.write("secret"); process.stderr.write("secret")') },
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

test('runSpawn streams stdout/stderr to onOutputChunk before exit', async () => {
  const seen: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const result = await runSpawn(
    {
      args: nodeArg(
        'process.stdout.write("hello "); process.stderr.write("warn "); process.stdout.write("world")',
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

test('runSpawn does not let a throwing onOutputChunk abort the drain', async () => {
  const result = await runSpawn({ args: nodeArg('process.stdout.write("abc")') }, null, {
    onOutputChunk: () => {
      throw new Error('sink boom');
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('abc');
});
