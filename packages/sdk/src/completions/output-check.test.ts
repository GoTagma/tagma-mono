import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(process.cwd(), '.tmp-output-check-'));
  try {
    const script = join(dir, 'verbose-check.js');
    writeFileSync(script, 'process.stdout.write("x".repeat(16 * 1024 * 1024));\n');

    const passed = await OutputCheckCompletion.check(
      {
        check: { argv: [process.platform === 'win32' ? 'node.exe' : 'node', script] },
        timeout: '5s',
      },
      taskResult(),
      { workDir: dir, signal: new AbortController().signal, runtime: bunRuntime() },
    );

    expect(passed).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);

test('output_check returns verifier evidence when the command rejects the result', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-output-check-feedback-'));
  try {
    const outcome = await OutputCheckCompletion.check(
      {
        check: {
          argv: [
            process.execPath,
            '-e',
            `process.stdout.write('observed value'); process.stderr.write('assertion failed'); process.exit(2)`,
          ],
        },
        timeout: '5s',
      },
      taskResult(),
      { workDir: dir, signal: new AbortController().signal, runtime: bunRuntime() },
    );

    expect(outcome).toEqual({
      passed: false,
      feedback: expect.stringContaining('assertion failed'),
    });
    expect((outcome as { feedback: string }).feedback).toContain('exit=2');
    expect((outcome as { feedback: string }).feedback).toContain('observed value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);
