import { describe, expect, test } from 'bun:test';
import { runSpawn } from './bun-process-runner';

const LARGE_STDIN = 'x'.repeat(16 * 1024 * 1024);
const CHILD_LIFETIME_MS = 4_000;
const CANCELLATION_DEADLINE_MS = 2_500;

function sleepingChild() {
  return {
    args: ['node', '-e', `setTimeout(() => {}, ${CHILD_LIFETIME_MS})`],
    stdin: LARGE_STDIN,
  };
}

describe('runSpawn cancellation while writing stdin', () => {
  test('task timeout starts before a backpressured stdin write completes', async () => {
    const startedAt = performance.now();

    const result = await runSpawn(sleepingChild(), null, { timeoutMs: 25 });

    expect(result.failureKind).toBe('timeout');
    expect(performance.now() - startedAt).toBeLessThan(CANCELLATION_DEADLINE_MS);
  });

  test('external abort is observed while stdin is backpressured', async () => {
    const controller = new AbortController();
    const startedAt = performance.now();
    setTimeout(() => controller.abort(), 25);

    const result = await runSpawn(sleepingChild(), null, { signal: controller.signal });

    expect(result.failureKind).toBe('aborted');
    expect(performance.now() - startedAt).toBeLessThan(CANCELLATION_DEADLINE_MS);
  });

  test('handles child stdout before child reads stdin without deadlocking', async () => {
    const bytes = 2 * 1024 * 1024;
    const childScript = [
      `const output = 'y'.repeat(${bytes});`,
      `process.stdout.write(output, () => {`,
      `  let received = 0;`,
      `  process.stdin.on('data', (chunk) => { received += chunk.length; });`,
      `  process.stdin.on('end', () => process.stderr.write(String(received)));`,
      `  process.stdin.resume();`,
      `});`,
    ].join('\n');

    const result = await runSpawn(
      {
        args: ['node', '-e', childScript],
        stdin: 'x'.repeat(bytes),
      },
      null,
      { timeoutMs: 3_000 },
    );

    expect(result.failureKind).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdoutBytes).toBe(bytes);
    expect(result.stderr).toBe(String(bytes));
  });
});
