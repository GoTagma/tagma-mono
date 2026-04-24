import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpawn } from './runner';

// Portable output producer — node is guaranteed in the bun dev env. Using a
// known runtime avoids shell-quoting differences between platforms.
function nodeArg(script: string): string[] {
  return ['node', '-e', script];
}

test('runSpawn: small output is returned whole, persisted byte-identical', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tagma-runner-small-'));
  const stdoutPath = join(tmp, 'out');
  const stderrPath = join(tmp, 'err');
  try {
    const result = await runSpawn(
      { args: nodeArg('process.stdout.write("hello world"); process.stderr.write("oops")') },
      null,
      { stdoutPath, stderrPath },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('oops');
    expect(result.stdoutBytes).toBe(11);
    expect(result.stderrBytes).toBe(4);
    expect(result.stdoutPath).toBe(stdoutPath);
    expect(result.stderrPath).toBe(stderrPath);
    expect(readFileSync(stdoutPath, 'utf8')).toBe('hello world');
    expect(readFileSync(stderrPath, 'utf8')).toBe('oops');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSpawn: oversized output — bounded tail in memory, full bytes on disk', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tagma-runner-big-'));
  const stdoutPath = join(tmp, 'out');
  try {
    // Produce 3 MB of output against a 512 KB cap. The child writes in one
    // shot; the runner should slice the single chunk's tail rather than
    // evicting (the "pathological one-chunk-over-cap" branch).
    const cap = 512 * 1024;
    const totalBytes = 3 * 1024 * 1024;
    const result = await runSpawn(
      {
        args: nodeArg(
          `process.stdout.write("a".repeat(${totalBytes}))`,
        ),
      },
      null,
      { stdoutPath, maxStdoutTailBytes: cap },
    );
    expect(result.exitCode).toBe(0);
    // Total bytes reported match reality
    expect(result.stdoutBytes).toBe(totalBytes);
    // In-memory tail bounded (tail + truncation marker header is a couple
    // hundred bytes at most; give it slack)
    expect(result.stdout.length).toBeLessThan(cap + 1024);
    expect(result.stdout.length).toBeGreaterThan(cap - 1024);
    // Truncation breadcrumb present and points at the full output
    expect(result.stdout).toContain('truncated from head');
    expect(result.stdout).toContain(stdoutPath);
    // The tail ends with the trailing bytes the child wrote ('a')
    expect(result.stdout.endsWith('a')).toBe(true);
    // Disk copy is byte-exact and full-length
    const onDiskBytes = statSync(stdoutPath).size;
    expect(onDiskBytes).toBe(totalBytes);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSpawn: chunked output — tail eviction keeps retained <= cap', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tagma-runner-chunked-'));
  const stdoutPath = join(tmp, 'out');
  try {
    // Emit 8 chunks × 64 KB with sync drains between them, so the runner
    // receives them as distinct chunks rather than one blob. Cap at 128 KB
    // forces eviction of older chunks.
    const cap = 128 * 1024;
    const chunkSize = 64 * 1024;
    const nChunks = 8;
    const script = `
      const chunk = 'b'.repeat(${chunkSize});
      (async () => {
        for (let i = 0; i < ${nChunks}; i++) {
          process.stdout.write(chunk);
          await new Promise(r => setImmediate(r));
        }
      })();
    `;
    const result = await runSpawn(
      { args: nodeArg(script) },
      null,
      { stdoutPath, maxStdoutTailBytes: cap },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(nChunks * chunkSize);
    // Retained tail should be strictly bounded by cap (eviction case, no
    // single-chunk slice). Allow small overhead for the truncation marker.
    expect(result.stdout.length).toBeLessThan(cap + 1024);
    expect(result.stdout).toContain('truncated from head');
    // Full stream on disk
    expect(statSync(stdoutPath).size).toBe(nChunks * chunkSize);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSpawn: no path configured — memory-only tail, returns null paths', async () => {
  const result = await runSpawn(
    { args: nodeArg('process.stdout.write("inline only")') },
    null,
    {},
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('inline only');
  expect(result.stdoutPath).toBeNull();
  expect(result.stderrPath).toBeNull();
});

test('runSpawn: pre-spawn failure (bad executable) — no paths leak on disk', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tagma-runner-bad-'));
  const stdoutPath = join(tmp, 'out');
  try {
    const result = await runSpawn(
      { args: ['this-command-definitely-does-not-exist-xyz123'] },
      null,
      { stdoutPath },
    );
    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('spawn_error');
    // On pre-spawn failure the runner never opened the file, so stdoutPath
    // is null (not the unopened path). Callers can rely on this to decide
    // whether a disk file exists to read.
    expect(result.stdoutPath).toBeNull();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
