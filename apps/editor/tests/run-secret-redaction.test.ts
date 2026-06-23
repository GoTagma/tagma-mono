import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretOutputRedactor, runtimeWithInjectedEnv } from '../server/routes/run-session';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-run-redaction-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('run secret output redaction', () => {
  test('redacts secrets that are split across output chunks', () => {
    const redact = createSecretOutputRedactor(['abcdef']);
    expect(redact).toBeDefined();
    expect(redact?.('stdout', 'abc')).toBe('');
    expect(redact?.('stdout', 'def', true)).toBe('[redacted secret]');
  });

  test('redacts injected secret values from live chunks, tails, and persisted logs', async () => {
    const dir = makeTempDir();
    const secret = 'SECRET_VALUE_FOR_REDACTION_12345';
    const stdoutPath = join(dir, 'stdout.log');
    const stderrPath = join(dir, 'stderr.log');
    const chunks: string[] = [];
    const runtime = runtimeWithInjectedEnv({ SECRET_VALUE: secret }, [secret]);
    const script = [
      'const secret = process.env.SECRET_VALUE;',
      "process.stdout.write('stdout:' + secret + '\\n');",
      "process.stderr.write('stderr:' + secret + '\\n');",
    ].join('\n');

    const result = await runtime.runSpawn(
      { args: [process.execPath, '-e', script], cwd: dir },
      null,
      {
        stdoutPath,
        stderrPath,
        onOutputChunk: (stream, text) => chunks.push(`${stream}:${text}`),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[redacted secret]');
    expect(result.stderr).toContain('[redacted secret]');
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(chunks.join('')).not.toContain(secret);
    expect(readFileSync(stdoutPath, 'utf-8')).not.toContain(secret);
    expect(readFileSync(stderrPath, 'utf-8')).not.toContain(secret);
    expect(readFileSync(stdoutPath, 'utf-8')).toContain('[redacted secret]');
    expect(readFileSync(stderrPath, 'utf-8')).toContain('[redacted secret]');
  });
});
