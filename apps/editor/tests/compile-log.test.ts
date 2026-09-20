import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { YamlCompileResult } from '@tagma/sdk/yaml';

import {
  __compileLogTestHooks,
  compileLogPath,
  runCompileAndWriteLog,
} from '../server/compile-log';

const { mergeCompileDiagnostics } = __compileLogTestHooks;

describe('compile log additional validation', () => {
  test('never turns an unrepresented base compiler failure into success', () => {
    const crashed: YamlCompileResult = {
      timestamp: '2026-08-16T00:00:00.000Z',
      sourceName: 'fixture.yaml',
      success: false,
      parseOk: true,
      validation: { errors: [], warnings: [] },
      summary: 'Validation crashed: fixture crash',
    };

    const merged = mergeCompileDiagnostics(crashed, [
      { path: 'pipeline', message: 'advisory context', severity: 'warning' },
    ]);

    expect(merged.success).toBe(false);
    expect(merged.summary).toContain('Validation crashed: fixture crash');
    expect(merged.validation.warnings).toEqual([{ path: 'pipeline', message: 'advisory context' }]);
  });

  test('does not let an existing warning suppress an added error with the same identity', () => {
    const validWithWarning: YamlCompileResult = {
      timestamp: '2026-08-16T00:00:00.000Z',
      sourceName: 'fixture.yaml',
      success: true,
      parseOk: true,
      validation: {
        errors: [],
        warnings: [{ path: 'tracks[0]', message: 'same diagnostic' }],
      },
      summary: 'Valid with 1 warning(s)',
    };

    const merged = mergeCompileDiagnostics(validWithWarning, [
      { path: 'tracks[0]', message: 'same diagnostic', severity: 'error' },
    ]);

    expect(merged.success).toBe(false);
    expect(merged.validation.errors).toEqual([{ path: 'tracks[0]', message: 'same diagnostic' }]);
    expect(merged.validation.warnings).toEqual([{ path: 'tracks[0]', message: 'same diagnostic' }]);
  });
});

// The compile log is a *generated companion* inside Trial's sealed real-workspace
// witness scope. A redundant recompile of unchanged YAML must therefore be
// byte-idempotent: if it rewrites the file, the sealed digest changes and an
// isolated case is misreported as leaking into the real workspace. This is the
// same contract `requirements-sync` and `pipeline-manifest` already honour.
const STABLE_YAML = 'pipeline:\n  name: Stable\n  tracks: []\n';
const DIFFERENT_YAML = 'pipeline: [\n';

describe('compile log byte idempotence', () => {
  const createdDirs: string[] = [];

  function makeYamlDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-compile-log-'));
    createdDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('recompiling unchanged YAML preserves the log bytes and mtime', () => {
    const dir = makeYamlDir();
    const yamlPath = join(dir, 'pipeline.yaml');
    writeFileSync(yamlPath, STABLE_YAML, 'utf-8');
    const logPath = compileLogPath(yamlPath);

    runCompileAndWriteLog(yamlPath);
    const firstBytes = readFileSync(logPath, 'utf-8');
    const firstMtimeMs = statSync(logPath).mtimeMs;

    runCompileAndWriteLog(yamlPath);

    expect(readFileSync(logPath, 'utf-8')).toBe(firstBytes);
    expect(statSync(logPath).mtimeMs).toBe(firstMtimeMs);
  });

  test.skipIf(process.platform !== 'win32')(
    'treats a drive-letter/separator alias of the same source path as equivalent',
    () => {
      const dir = makeYamlDir();
      const yamlPath = join(dir, 'pipeline.yaml');
      writeFileSync(yamlPath, STABLE_YAML, 'utf-8');
      const logPath = compileLogPath(yamlPath);

      runCompileAndWriteLog(yamlPath);
      const parsed = JSON.parse(readFileSync(logPath, 'utf-8')) as Record<string, unknown>;
      // Same file, different spelling. AGENTS.md: drive-letter casing and
      // `/` versus `\` are aliases of one coordinate.
      const aliased = (parsed.sourceName as string).replace(/\\/gu, '/').toLowerCase();
      const aliasedText = `${JSON.stringify({ ...parsed, sourceName: aliased }, null, 2)}\n`;
      writeFileSync(logPath, aliasedText, 'utf-8');

      runCompileAndWriteLog(yamlPath);

      expect(readFileSync(logPath, 'utf-8')).toBe(aliasedText);
    },
  );

  test('still rewrites the log when the YAML semantics change', () => {
    const dir = makeYamlDir();
    const yamlPath = join(dir, 'pipeline.yaml');
    writeFileSync(yamlPath, STABLE_YAML, 'utf-8');
    const logPath = compileLogPath(yamlPath);

    runCompileAndWriteLog(yamlPath);
    const firstBytes = readFileSync(logPath, 'utf-8');

    writeFileSync(yamlPath, DIFFERENT_YAML, 'utf-8');
    runCompileAndWriteLog(yamlPath);

    const secondBytes = readFileSync(logPath, 'utf-8');
    expect(secondBytes).not.toBe(firstBytes);
    expect((JSON.parse(secondBytes) as YamlCompileResult).parseOk).toBe(false);
  });

  test('repairs an unparseable existing log instead of preserving it', () => {
    const dir = makeYamlDir();
    const yamlPath = join(dir, 'pipeline.yaml');
    writeFileSync(yamlPath, STABLE_YAML, 'utf-8');
    const logPath = compileLogPath(yamlPath);
    writeFileSync(logPath, 'not a compile log\n', 'utf-8');

    runCompileAndWriteLog(yamlPath);

    const repaired = JSON.parse(readFileSync(logPath, 'utf-8')) as YamlCompileResult;
    expect(repaired.sourceName).toBe(yamlPath);
    expect(typeof repaired.summary).toBe('string');
  });
});
