import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkReceipt, parseBunOutput, runGate } from './known-issue-regressions.mjs';

const bunBin = process.env.KNOWN_ISSUE_BUN_BIN ?? 'bun';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t, body = "test('historical regression', () => expect(1).toBe(1));") {
  const root = mkdtempSync(join(tmpdir(), 'tagma-regression-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidence = 'immutable observed evidence\n';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.14' }));
  writeFileSync(join(root, 'evidence.json'), evidence);
  writeFileSync(
    join(root, 'fixture.test.ts'),
    `import { test, expect } from 'bun:test';\n${body}\n`,
  );
  const issue = {
    id: 'TAGMA-0001',
    lineage: [],
    title: 'Historical fixture',
    category: 'test-tool',
    mechanism: 'fixture',
    observationVerified: 'verified',
    causeConfirmed: 'confirmed',
    firstEvidence: {
      sourceId: 'source-1',
      round: 1,
      sourceRevision: 'fixture',
      acceptancePolicy: 'local synthetic',
      path: 'evidence.json',
      sha256: digest(evidence),
    },
    history: [{ result: 'observed' }],
    status: 'open',
    fixes: [],
    regressions: [
      {
        cwd: '.',
        file: 'fixture.test.ts',
        namePattern: '^historical regression$',
        expectedTests: 1,
      },
    ],
    realTestSelectors: [],
    lastExecution: null,
  };
  const catalog = {
    schemaVersion: 1,
    importComplete: true,
    sources: [{ id: 'source-1', path: 'evidence.json', sha256: digest(evidence) }],
    issues: [issue],
  };
  const save = () => writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog));
  spawnSync('git', ['init', '--quiet', root]);
  assert.equal(spawnSync('git', ['add', 'package.json'], { cwd: root }).status, 0);
  assert.equal(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=Regression Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'initial source fixture',
      ],
      { cwd: root },
    ).status,
    0,
  );
  save();
  return {
    root,
    catalog,
    issue,
    save,
    run: async (options = {}) => {
      save();
      return runGate({
        repoRoot: root,
        catalogPath: 'catalog.json',
        initialImport: true,
        bunBin,
        ...options,
      });
    },
  };
}

test('rejects zero inventory and incomplete imports without running a child', async (t) => {
  const f = fixture(t);
  f.catalog.issues = [];
  let receipt = await f.run();
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failures.some((entry) => entry.code === 'inventory_empty'));
  assert.equal(receipt.results.length, 0);
  f.catalog.issues = [f.issue];
  f.catalog.importComplete = false;
  receipt = await f.run();
  assert.ok(receipt.failures.some((entry) => entry.code === 'import_incomplete'));
});

test('missing mapping, file, source and SHA mismatch all block before tests', async (t) => {
  const f = fixture(t);
  f.issue.regressions = [];
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_mapping_missing'));
  f.issue.regressions = [
    { cwd: '.', file: 'missing.test.ts', namePattern: '^regression$', expectedTests: 1 },
  ];
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_path_invalid'));
  f.issue.regressions = [
    { cwd: '.', file: 'fixture.test.ts', namePattern: '^historical regression$', expectedTests: 1 },
  ];
  f.catalog.sources[0].path = 'missing.json';
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'source_unavailable'));
  f.catalog.sources[0].path = 'evidence.json';
  f.catalog.sources[0].sha256 = '0'.repeat(64);
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'source_hash_mismatch'));
});

test('rejects symlinks, traversal and non-exact or empty selectors', async (t) => {
  const f = fixture(t);
  symlinkSync(join(f.root, 'fixture.test.ts'), join(f.root, 'alias.test.ts'));
  f.issue.regressions[0].file = 'alias.test.ts';
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_path_invalid'));
  f.issue.regressions[0].file = '../outside.test.ts';
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_path_invalid'));
  f.issue.regressions[0].file = 'fixture.test.ts';
  f.issue.regressions[0].namePattern = 'historical';
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_selector_invalid'));
  f.issue.regressions[0].namePattern = '^.*$';
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_selector_invalid'));
  f.issue.regressions[0].namePattern = '^historical regression$';
  f.issue.regressions[0].expectedTests = 0;
  assert.ok((await f.run()).failures.some((entry) => entry.code === 'regression_selector_invalid'));
});

test('historical first evidence, histories and regression mappings cannot be lost or weakened', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'previous.json'), JSON.stringify(f.catalog));
  f.issue.history = [];
  assert.ok(
    (await f.run({ initialImport: false, previousPath: 'previous.json' })).failures.some(
      (entry) => entry.code === 'history_rewritten',
    ),
  );
  f.issue.history = [{ result: 'observed' }];
  f.issue.firstEvidence.round = 2;
  assert.ok(
    (await f.run({ initialImport: false, previousPath: 'previous.json' })).failures.some(
      (entry) => entry.code === 'stable_identity_changed',
    ),
  );
  f.issue.firstEvidence.round = 1;
  f.issue.regressions[0].expectedTests = 2;
  assert.ok(
    (await f.run({ initialImport: false, previousPath: 'previous.json' })).failures.some(
      (entry) => entry.code === 'regression_mapping_rewritten',
    ),
  );
  f.catalog.issues = [];
  assert.ok(
    (await f.run({ initialImport: false, previousPath: 'previous.json' })).failures.some(
      (entry) => entry.code === 'historical_issue_removed',
    ),
  );
});

test('initial import cannot bypass a catalog already committed at HEAD', async (t) => {
  const f = fixture(t);
  spawnSync('git', ['add', 'catalog.json'], { cwd: f.root });
  const commit = spawnSync(
    'git',
    [
      '-c',
      'user.name=Regression Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: f.root },
  );
  assert.equal(commit.status, 0);
  const receipt = await f.run();
  assert.ok(
    receipt.failures.some((entry) => entry.code === 'initial_import_has_baseline'),
    JSON.stringify(receipt),
  );
});

test('parsing fails closed on ambiguous or summary-only output', () => {
  assert.equal(
    parseBunOutput(
      '1 pass\n0 fail\nRan 1 tests across 1 files. [1ms]\n',
      '^historical regression$',
      1,
    ).passed,
    false,
  );
  const good =
    'bun test v1.3.14 (fixture)\n\nfixture.test.ts:\n(pass) historical regression [0.20ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1.00ms]\n';
  assert.equal(parseBunOutput(good, '^historical regression$', 1).passed, true);
  assert.equal(parseBunOutput(`${good}${good}`, '^historical regression$', 1).passed, false);
});

test('real Bun pass records executed counts, hashes and preserves catalog bytes', async (t) => {
  const f = fixture(t);
  f.save();
  const before = readFileSync(join(f.root, 'catalog.json'));
  const receipt = await f.run({ receiptPath: 'work/receipt.json' });
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failures));
  assert.equal(receipt.results[0].executed, 1);
  assert.equal(receipt.results[0].classification, 'pass');
  assert.match(receipt.results[0].outputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(join(f.root, 'catalog.json')), before);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'work/receipt.json'))).passed, true);
});

test('real Bun assertion failure stops later regressions', async (t) => {
  const f = fixture(t, "test('historical regression', () => expect(1).toBe(2));");
  writeFileSync(
    join(f.root, 'later.test.ts'),
    "import {test} from 'bun:test'; import {writeFileSync} from 'node:fs'; test('later', () => writeFileSync('later-ran', 'yes'));\n",
  );
  f.issue.regressions.push({
    cwd: '.',
    file: 'later.test.ts',
    namePattern: '^later$',
    expectedTests: 1,
  });
  const receipt = await f.run();
  assert.equal(receipt.passed, false);
  assert.equal(receipt.results.length, 1);
  assert.equal(receipt.results[0].classification, 'assertion_failure');
  assert.throws(() => readFileSync(join(f.root, 'later-ran')), { code: 'ENOENT' });
});

test('real Bun zero match, selected skip and todo cannot pass on exit zero', async (t) => {
  for (const body of [
    "test('different', () => expect(1).toBe(1));",
    "test.skip('historical regression', () => expect(1).toBe(1));",
    "test.todo('historical regression');",
  ]) {
    const f = fixture(t, body);
    const receipt = await f.run();
    assert.equal(receipt.passed, false);
    assert.equal(receipt.results.length, 1);
    assert.equal(receipt.results[0].classification, 'execution_unproven');
  }
});

test('real Bun import failure is environment failure, not a product assertion RED', async (t) => {
  const f = fixture(
    t,
    "import './nonexistent-module.ts'; test('historical regression', () => expect(1).toBe(1));",
  );
  const receipt = await f.run();
  assert.equal(receipt.passed, false);
  assert.equal(receipt.results[0].classification, 'environment_failure');
  assert.equal(receipt.results[0].code, 'test_import_failure');
  assert.equal(JSON.stringify(receipt).includes('nonexistent-module'), false);
});

test('real child environment omits provider credentials', async (t) => {
  const f = fixture(
    t,
    "test('historical regression', () => { expect(process.env.OPENAI_API_KEY).toBeUndefined(); expect(process.env.DEEPSEEK_API_KEY).toBeUndefined(); });",
  );
  const receipt = await f.run({
    environment: {
      ...process.env,
      OPENAI_API_KEY: 'fixture-secret',
      DEEPSEEK_API_KEY: 'fixture-secret',
    },
  });
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failures));
  assert.equal(JSON.stringify(receipt).includes('fixture-secret'), false);
  assert.equal(receipt.networkIsolation, 'not_claimed');
});

test('real Bun nested describe selectors use the full matcher name', async (t) => {
  const f = fixture(
    t,
    "import {describe} from 'bun:test'; describe('suite', () => describe('inner', () => test('historical regression', () => expect(1).toBe(1))));",
  );
  f.issue.regressions[0].namePattern = '^suite inner historical regression$';
  const receipt = await f.run();
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failures));
  assert.equal(receipt.results[0].junitExecutionVerified, true);
});

test('printing a fake Bun success followed by exit zero cannot prove execution', async (t) => {
  const f = fixture(
    t,
    "console.error('(pass) historical regression [0.20ms]\\n\\n 1 pass\\n 0 fail\\nRan 1 test across 1 file. [1.00ms]'); process.exit(0);",
  );
  const receipt = await f.run();
  assert.equal(receipt.passed, false);
  assert.equal(receipt.results[0].classification, 'execution_unproven');
  assert.equal(receipt.results[0].junitExecutionVerified, false);
});

test('receipt recheck binds tracked and new public source while excluding private work', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'apps'), { recursive: true });
  writeFileSync(join(f.root, 'apps', 'production.ts'), 'export const value = 1;\n');
  const receipt = await f.run({ receiptPath: 'work/receipt.json' });
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failures));
  let check = await checkReceipt({ repoRoot: f.root, receiptPath: 'work/receipt.json' });
  assert.equal(check.passed, true, JSON.stringify(check.failures));
  writeFileSync(join(f.root, 'work', 'private-runtime.db'), 'private runtime fixture');
  check = await checkReceipt({ repoRoot: f.root, receiptPath: 'work/receipt.json' });
  assert.equal(check.passed, true, JSON.stringify(check.failures));
  writeFileSync(join(f.root, 'apps', 'production.ts'), 'export const value = 2;\n');
  check = await checkReceipt({ repoRoot: f.root, receiptPath: 'work/receipt.json' });
  assert.ok(check.failures.some((entry) => entry.code === 'receipt_source_changed'));
  writeFileSync(join(f.root, 'apps', 'production.ts'), 'export const value = 1;\n');
  writeFileSync(join(f.root, 'apps', 'new-module.ts'), 'export const value = 3;\n');
  check = await checkReceipt({ repoRoot: f.root, receiptPath: 'work/receipt.json' });
  assert.ok(check.failures.some((entry) => entry.code === 'receipt_source_changed'));
});

test('explicit mutable baseline cannot hide a committed historical issue', async (t) => {
  const f = fixture(t);
  spawnSync('git', ['add', 'catalog.json'], { cwd: f.root });
  assert.equal(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=Regression Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: f.root },
    ).status,
    0,
  );
  f.catalog.issues = [];
  writeFileSync(join(f.root, 'previous.json'), JSON.stringify(f.catalog));
  const receipt = await f.run({ initialImport: false, previousPath: 'previous.json' });
  assert.ok(receipt.failures.some((entry) => entry.code === 'historical_issue_removed'));
});

test('current-source pass declares historical coverage incomplete', async (t) => {
  const f = fixture(t);
  f.catalog.scope = 'current-source';
  const receipt = await f.run();
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failures));
  assert.equal(receipt.scope, 'current-source');
  assert.equal(receipt.historicalCoverageComplete, false);
});

test('real child timeout is an environment failure and stops the suite', async (t) => {
  const f = fixture(
    t,
    "test('historical regression', async () => { await new Promise((resolve) => setTimeout(resolve, 10000)); expect(1).toBe(1); });",
  );
  const receipt = await f.run({ timeoutMs: 30 });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.results[0].classification, 'environment_failure');
  assert.equal(receipt.results[0].code, 'child_timeout');
});

test('a receipt path cannot overwrite public source', async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, 'package.json'));
  const receipt = await f.run({ receiptPath: 'package.json' });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failures.some((entry) => entry.code === 'receipt_write_failed'));
  assert.deepEqual(readFileSync(join(f.root, 'package.json')), before);
});

test('qualification Node sentinel failures retain environmental classification through actual gate', async (t) => {
  for (const sentinel of [
    'qualification_Node_environment_unavailable',
    'qualification_Node_environment_invalid_response',
    'qualification_Node_environment_not_actual_Node',
    'qualification_Node_fixture_environment_failure',
  ]) {
    for (const topLevel of [true, false]) {
      const body = topLevel
        ? `throw new Error('${sentinel}'); test('historical regression', () => expect(1).toBe(1));`
        : `test('historical regression', () => { throw new Error('${sentinel}'); });`;
      const f = fixture(t, body);
      const receipt = await f.run();
      assert.equal(receipt.passed, false);
      assert.equal(receipt.results.length, 1);
      assert.equal(receipt.results[0].classification, 'environment_failure');
      assert.equal(receipt.results[0].code, sentinel);
      assert.ok(
        receipt.failures.some(
          (failure) => failure.kind === 'environment' && failure.code === sentinel,
        ),
      );
    }
  }
});

test('qualification sentinel names in text or unknown errors cannot relabel genuine assertions', async (t) => {
  for (const body of [
    "test('historical regression', () => { console.log('qualification_Node_environment_unavailable'); expect(1).toBe(2); });",
    "test('historical regression', () => { throw new Error('qualification_Node_fixture_environment_failure_extra'); });",
    "test('historical regression', () => { throw new Error('qualification_Node_fixture_assertion_failed'); });",
  ]) {
    const f = fixture(t, body);
    const receipt = await f.run();
    assert.equal(receipt.passed, false);
    assert.equal(receipt.results.length, 1);
    assert.equal(receipt.results[0].classification, 'assertion_failure');
    assert.ok(receipt.failures.every((failure) => failure.kind !== 'environment'));
  }
});
