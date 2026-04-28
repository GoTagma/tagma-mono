import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputCheckCompletion } from './output-check';
import { bunRuntime } from '@tagma/runtime-bun';
import type { TaskResult } from '@tagma/types';

function taskResult(stdout = 'payload'): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 0,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

test('output_check drains verbose check stdout so the check process can exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-output-check-'));
  try {
    const script = join(dir, 'verbose-check.js');
    writeFileSync(script, 'process.stdout.write("x".repeat(16 * 1024 * 1024));\n');

    const passed = await OutputCheckCompletion.check(
      {
        check: `node "${script}"`,
        timeout: '1s',
      },
      taskResult(),
      { workDir: dir, signal: new AbortController().signal, runtime: bunRuntime() },
    );

    expect(passed).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);
