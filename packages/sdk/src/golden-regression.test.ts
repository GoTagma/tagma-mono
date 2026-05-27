import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createTagma, type RunEventPayload, type EngineResult } from './index';

/**
 * Golden file regression test harness.
 *
 * Runs known-good pipeline YAML fixtures through `createTagma().runYaml()`
 * with the **real** `bunRuntime` and compares the structured output against
 * stored golden JSON files.
 *
 * **How it works:**
 *   1. Each `.yaml` file in `__fixtures__/golden/` defines a pipeline.
 *   2. Each `.json` file in `__fixtures__/golden/expected/` captures the
 *      expected engine output (success, summary, per-task status/outputs).
 *   3. The test runs each fixture, extracts the comparable result shape,
 *      and deep-equals it against the golden file.
 *
 * **Updating golden files:**
 *   When a pipeline behavior change is intentional, run:
 *     UPDATE_GOLDEN=1 bun test packages/sdk/src/golden-regression.test.ts
 *   This regenerates the expected JSON files from current output.
 *
 * **Adding new fixtures:**
 *   1. Add a `.yaml` file to `__fixtures__/golden/`
 *   2. Run with `UPDATE_GOLDEN=1` to generate the expected output
 *   3. Review the generated JSON and commit it
 *
 * This closes the gap identified in the testing pipeline review:
 * "No regression testing — I don't compare against previous run outputs."
 */

const FIXTURES_DIR = join(__dirname, '__fixtures__', 'golden');
const EXPECTED_DIR = join(FIXTURES_DIR, 'expected');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

/**
 * Extract a stable, comparable shape from the engine result and events.
 * Strips non-deterministic fields (runId, timestamps, paths, durations)
 * and keeps only the structural output that should be stable across runs.
 */
function extractGoldenShape(
  result: EngineResult,
  events: RunEventPayload[],
): GoldenOutput {
  const tasks: Record<string, GoldenTaskOutput> = {};

  for (const event of events) {
    if (event.type !== 'task_update') continue;
    const taskId = event.taskId;
    if (!taskId) continue;

    tasks[taskId] = {
      status: event.status,
      exitCode: event.exitCode ?? null,
      // Normalize stdout: trim trailing whitespace, strip platform-specific
      // path separators in truncation markers
      stdout: (event.stdout ?? '').trim(),
      stderr: (event.stderr ?? '').trim()
        // Normalize Windows paths in error messages for cross-platform stability
        .replace(/\\/g, '/'),
      outputs: event.outputs
        ? Object.fromEntries(
            Object.entries(event.outputs).sort(([a], [b]) => a.localeCompare(b)),
          )
        : null,
    };
  }

  return {
    success: result.success,
    summary: { ...result.summary },
    tasks: Object.fromEntries(
      Object.entries(tasks).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

interface GoldenTaskOutput {
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, unknown> | null;
}

interface GoldenOutput {
  success: boolean;
  summary: EngineResult['summary'];
  tasks: Record<string, GoldenTaskOutput>;
}

function getFixtureFiles(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-golden-'));
}

describe('golden regression — pipeline output stability', () => {
  const fixtures = getFixtureFiles();

  if (fixtures.length === 0) {
    test('no golden fixtures found (placeholder)', () => {
      // This test exists so the describe block is never empty
      expect(true).toBe(true);
    });
    return;
  }

  for (const fixtureFile of fixtures) {
    const stem = basename(fixtureFile).replace(/\.ya?ml$/i, '');
    const expectedFile = join(EXPECTED_DIR, `${stem}.json`);

    test(`golden: ${stem}`, async () => {
      const dir = makeDir();
      try {
        const yamlContent = readFileSync(join(FIXTURES_DIR, fixtureFile), 'utf8');
        const tagma = createTagma();
        const events: RunEventPayload[] = [];
        const result = await tagma.runYaml(yamlContent, {
          cwd: dir,
          onEvent: (e) => events.push(e),
        });

        expect(result.kind).toBe('pipeline');
        if (result.kind !== 'pipeline') return;

        const shape = extractGoldenShape(result.result, events);

        if (UPDATE_GOLDEN) {
          // Ensure the expected directory exists
          if (!existsSync(EXPECTED_DIR)) {
            mkdirSync(EXPECTED_DIR, { recursive: true });
          }
          writeFileSync(expectedFile, JSON.stringify(shape, null, 2) + '\n');
          console.log(`[golden] Updated: ${expectedFile}`);
          return;
        }

        // Compare against stored golden file
        if (!existsSync(expectedFile)) {
          throw new Error(
            `Golden file missing: ${expectedFile}\n` +
              `Run with UPDATE_GOLDEN=1 to generate it, or delete the fixture.`,
          );
        }

        const expected: GoldenOutput = JSON.parse(
          readFileSync(expectedFile, 'utf8'),
        );

        // Deep structural comparison
        expect(shape.success).toBe(expected.success);
        expect(shape.summary).toEqual(expected.summary);

        // Compare tasks
        expect(Object.keys(shape.tasks).sort()).toEqual(
          Object.keys(expected.tasks).sort(),
        );

        for (const [taskId, expectedTask] of Object.entries(expected.tasks)) {
          const actualTask = shape.tasks[taskId];
          if (!actualTask) {
            throw new Error(`Missing task in actual output: ${taskId}`);
          }
          expect(actualTask.status).toBe(expectedTask.status);
          expect(actualTask.exitCode).toBe(expectedTask.exitCode);
          expect(actualTask.stdout).toBe(expectedTask.stdout);
          // Only check stderr for error cases (non-empty expected stderr)
          if (expectedTask.stderr) {
            expect(actualTask.stderr).toContain(expectedTask.stderr);
          }
          if (expectedTask.outputs) {
            expect(actualTask.outputs).toEqual(expectedTask.outputs);
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
