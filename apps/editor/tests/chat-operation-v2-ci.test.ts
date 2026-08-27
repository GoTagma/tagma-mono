import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('managed-runtime CI runs both Chat Operation V2 native conformance contracts on every desktop OS', () => {
  const workflow = readFileSync(
    resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const managedRuntimeJob = workflow.match(
    /managed-opencode-runtime:[\s\S]*?\n {2}full-check:/,
  )?.[0];

  expect(managedRuntimeJob).toBeDefined();
  expect(managedRuntimeJob).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
  expect(managedRuntimeJob).toContain("TAGMA_OPENCODE_NATIVE_SMOKE: '1'");
  expect(managedRuntimeJob).toContain(
    'bun test tests/opencode-managed-runtime-smoke.test.ts --timeout 360000',
  );
  expect(managedRuntimeJob).toContain(
    'bun test tests/opencode-v2-question-conformance.test.ts --timeout 360000',
  );
  expect(managedRuntimeJob?.indexOf('opencode-v2-question-conformance.test.ts')).toBeGreaterThan(
    managedRuntimeJob?.indexOf('opencode-managed-runtime-smoke.test.ts') ?? -1,
  );
});

test('desktop release build re-verifies both native conformance contracts after staging OpenCode', () => {
  const workflow = readFileSync(
    resolve(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'release-desktop.yml'),
    'utf8',
  );
  const buildJob = workflow.match(/\n {2}build:[\s\S]*?\n {2}publish:/)?.[0];

  expect(buildJob).toBeDefined();
  expect(buildJob).toContain("TAGMA_OPENCODE_NATIVE_SMOKE: '1'");
  expect(buildJob).toContain(
    'bun test tests/opencode-managed-runtime-smoke.test.ts --timeout 360000',
  );
  expect(buildJob).toContain(
    'bun test tests/opencode-v2-question-conformance.test.ts --timeout 360000',
  );
  expect(buildJob?.indexOf('opencode-managed-runtime-smoke.test.ts')).toBeGreaterThan(
    buildJob?.indexOf('Stage bundled opencode binary') ?? -1,
  );
});
