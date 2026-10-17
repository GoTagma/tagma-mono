import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateTrialSemanticReview,
  TRIAL_SEMANTIC_REVIEW_LIMITS,
  type TrialSemanticReviewInput,
  type TrialSemanticReviewRuntime,
} from '../server/chat-trial-semantic-review';
import { semanticReviewIntent } from './helpers/trial-semantic-review-fixture';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string, algorithm = 'sha256') =>
  createHash(algorithm).update(value).digest('hex');
const report =
  'The observation is provisional; there is insufficient evidence for a firm measurement.';
const source = 'Observation: the measurement is provisional.';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-model-content-review-'));
  roots.push(root);
  const directory = join(root, '.tagma', 'flow');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'report.md'), report);
  writeFileSync(join(directory, 'input.md'), source);
  let calls = 0;
  let observed: Parameters<TrialSemanticReviewRuntime['invoke']>[0] | null = null;
  const response = (verdict: 'pass' | 'fail' | 'uncertain' = 'pass') => ({
    sessionId: 'ses_fixture_review',
    finishCode: 'stop',
    failureCode: null,
    text: JSON.stringify({
      version: 1,
      reviews: [
        {
          taskId: 'flow.inspect',
          path: 'flow/report.md',
          verdict,
          reason:
            verdict === 'fail'
              ? 'The actual report contradicts the input.'
              : 'The explanation distinguishes the supported provisional observation from an unsupported firm result.',
          evidence: [{ path: 'flow/report.md', quote: 'The observation is provisional' }],
        },
      ],
    }),
  });
  const runtime = {
    model: { providerID: 'synthetic', modelID: 'reviewer', variant: 'off' },
    invoke: async (request: Parameters<TrialSemanticReviewRuntime['invoke']>[0]) => {
      calls += 1;
      observed = request;
      return response();
    },
  };
  const yaml = 'pipeline:\n  name: Review actual content\n';
  const input: TrialSemanticReviewInput = {
    identity: {
      stageId: 'stage_fixture',
      trialId: 'trial_fixture',
      caseId: 'normal',
      runId: 'run_actual_1',
      runNumber: 1,
      yamlHash: sha(yaml, 'sha1'),
      planHash: 'c'.repeat(64),
      intentDigest: sha(semanticReviewIntent),
    },
    intentText: semanticReviewIntent,
    yamlText: yaml,
    targets: [{ taskId: 'flow.inspect', path: 'flow/report.md' }],
    referencePaths: ['flow/input.md'],
    runSucceeded: true,
    taskStatuses: { 'flow.inspect': 'success' },
    workDir: root,
    relativeYamlPath: 'flow/flow.yaml',
    runtime,
    signal: new AbortController().signal,
    secretValues: [],
  };
  return {
    root,
    directory,
    input,
    runtime,
    response,
    calls: () => calls,
    observed: () => observed,
  };
}

test('independent semantic review binds actual artifact bytes and frozen execution identities', async () => {
  const f = fixture();
  const result = await evaluateTrialSemanticReview(f.input);
  expect(result.success).toBe(true);
  expect(f.calls()).toBe(1);
  const request = JSON.parse(f.observed()!.user);
  expect(request.frozenIntent).toBe(semanticReviewIntent);
  expect(request.identity).toEqual(f.input.identity);
  expect(request.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: 'flow/report.md',
        content: report,
        sha256: sha(report),
        role: 'produced',
      }),
      expect.objectContaining({ path: 'flow/input.md', content: source, role: 'input' }),
    ]),
  );
  expect(f.observed()!.system).toContain('untrusted data');
  expect(result.receipt).toMatchObject({
    grading: 'independent-model',
    outcome: 'passed',
    identity: f.input.identity,
    model: f.runtime.model,
    reviewerSessionId: 'ses_fixture_review',
  });
  expect(result.receipt!.artifacts.every((item) => !('content' in item))).toBe(true);
  expect(result.receipt!.verdicts[0]!.evidence[0]!.quoteSha256).toBe(
    sha('The observation is provisional'),
  );
});

test('semantic votes distinguish an evidenced artifact defect from an uncertain observation', async () => {
  for (const verdict of ['fail', 'uncertain'] as const) {
    const f = fixture();
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: { ...f.runtime, invoke: async () => f.response(verdict) },
    });
    expect(result.success).toBe(false);
    expect(result.receipt!.outcome).toBe(verdict === 'fail' ? 'failed' : 'uncertain');
    expect(result.expectations[0]!.repairScope).toBe(
      verdict === 'fail' ? 'pipeline-artifact' : 'diagnostic-only',
    );
  }
});

test('semantic review never calls a model without actual success and a Host runtime', async () => {
  const f = fixture();
  const cancelled = new AbortController();
  cancelled.abort();
  for (const patch of [
    { runSucceeded: false },
    { taskStatuses: { 'flow.inspect': 'failed' } },
    { runtime: undefined },
    { signal: cancelled.signal },
    { identity: { ...f.input.identity, intentDigest: '0'.repeat(64) } },
    { identity: { ...f.input.identity, yamlHash: '0'.repeat(40) } },
  ]) {
    const result = await evaluateTrialSemanticReview({ ...f.input, ...patch });
    expect(result.success).toBe(false);
    expect(
      result.expectations.every((item) => !item.passed && item.repairScope === 'diagnostic-only'),
    ).toBe(true);
  }
  expect(f.calls()).toBe(0);
});

test('semantic evidence rejects escaped paths, ancestor links and hardlinks before model access', async () => {
  for (const mode of ['outside', 'junction', 'hardlink'] as const) {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'tagma-model-review-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'report.md'), 'outside private bytes');
    let path = '../report.md';
    if (mode === 'junction') {
      symlinkSync(
        outside,
        join(f.directory, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      path = 'flow/linked/report.md';
    } else if (mode === 'hardlink') {
      linkSync(join(outside, 'report.md'), join(f.directory, 'aliased.md'));
      path = 'flow/aliased.md';
    }
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      targets: [{ taskId: 'flow.inspect', path }],
    });
    expect(result.success).toBe(false);
    expect(f.calls()).toBe(0);
  }
});

test('semantic evidence never transmits partial binary oversized or secret-bearing artifacts', async () => {
  for (const value of [
    Buffer.from([0xff, 0xfe]),
    Buffer.from('  \n'),
    Buffer.from('x'.repeat(TRIAL_SEMANTIC_REVIEW_LIMITS.fileBytes + 1)),
    Buffer.from('private-secret-42'),
  ]) {
    const f = fixture();
    writeFileSync(join(f.directory, 'report.md'), value);
    expect(
      (await evaluateTrialSemanticReview({ ...f.input, secretValues: ['private-secret-42'] }))
        .success,
    ).toBe(false);
    expect(f.calls()).toBe(0);
  }
});

test('semantic review fails closed on incomplete invented or extra model verdicts', async () => {
  const f = fixture();
  const valid = JSON.parse(f.response().text);
  const row = valid.reviews[0];
  for (const response of [
    'not JSON',
    JSON.stringify({ ...valid, passed: true }),
    JSON.stringify({ version: 1, reviews: [] }),
    JSON.stringify({ version: 1, reviews: [row, row] }),
    JSON.stringify({ version: 1, reviews: [{ ...row, taskId: 'other.task' }] }),
    JSON.stringify({ version: 1, reviews: [{ ...row, evidence: [] }] }),
    JSON.stringify({
      version: 1,
      reviews: [{ ...row, evidence: [{ path: row.path, quote: 'an invented assertion' }] }],
    }),
    JSON.stringify({
      version: 1,
      reviews: [{ ...row, evidence: [{ path: 'flow/input.md', quote: source }] }],
    }),
  ]) {
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: { ...f.runtime, invoke: async () => ({ ...f.response(), text: response }) },
    });
    expect(result.success).toBe(false);
    expect(result.receipt?.outcome).toBe('unavailable');
    expect(result.expectations[0]!.repairScope).toBe('diagnostic-only');
  }
});

test('semantic review requires complete provider output and preserves unknown billing outcomes', async () => {
  const f = fixture();
  for (const patch of [
    { finishCode: 'length' },
    { failureCode: 'provider_billing_required' },
    { text: 'x'.repeat(TRIAL_SEMANTIC_REVIEW_LIMITS.responseBytes + 1) },
  ]) {
    let calls = 0;
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: {
        ...f.runtime,
        invoke: async () => {
          calls += 1;
          return { ...f.response(), ...patch };
        },
      },
    });
    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(result.expectations[0]!.repairScope).toBe('diagnostic-only');
  }
});

test('semantic review rechecks produced and input evidence after the model returns', async () => {
  for (const filename of ['report.md', 'input.md']) {
    const f = fixture();
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: {
        ...f.runtime,
        invoke: async () => {
          writeFileSync(join(f.directory, filename), 'changed during review');
          return f.response();
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.detail).toContain('evidence_changed_during_review');
    expect(result.receipt!.outcome).toBe('unavailable');
  }
});

test('semantic reviewer deadline aborts the one invocation even when it never settles', async () => {
  const f = fixture();
  let calls = 0;
  let signal: AbortSignal | null = null;
  const result = await evaluateTrialSemanticReview({
    ...f.input,
    timeoutMs: 10,
    runtime: {
      ...f.runtime,
      invoke: async (request) => {
        calls += 1;
        signal = request.signal;
        return new Promise(() => {});
      },
    },
  });
  expect(result.success).toBe(false);
  expect(calls).toBe(1);
  expect((signal as AbortSignal | null)?.aborted).toBe(true);
  expect(result.detail).toContain('reviewer_deadline');
});

test('semantic reviewer cancellation and caller mutation cannot turn an in-flight review green', async () => {
  const f = fixture();
  const controller = new AbortController();
  let started!: () => void;
  const invoked = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal: AbortSignal | null = null;
  const pending = evaluateTrialSemanticReview({
    ...f.input,
    signal: controller.signal,
    runtime: {
      ...f.runtime,
      invoke: async (request) => {
        signal = request.signal;
        started();
        return new Promise(() => {});
      },
    },
  });
  await invoked;
  controller.abort();
  const result = await pending;
  expect(result.success).toBe(false);
  expect((signal as AbortSignal | null)?.aborted).toBe(true);
  expect(result.detail).toContain('cancelled');
  const mutable: {
    model: TrialSemanticReviewRuntime['model'];
    invoke: TrialSemanticReviewRuntime['invoke'];
  } = { ...f.runtime };
  const second = evaluateTrialSemanticReview({ ...f.input, runtime: mutable });
  mutable.invoke = async () => ({ ...f.response(), failureCode: 'provider_billing_required' });
  expect((await second).success).toBe(true);
});

test('reviewer receives the unchanged response limits before one bounded invocation', async () => {
  const f = fixture();
  let calls = 0;
  const result = await evaluateTrialSemanticReview({
    ...f.input,
    runtime: {
      ...f.runtime,
      invoke: async (request) => {
        calls += 1;
        const contract = JSON.parse(request.user).responseContract;
        expect(contract).toEqual({
          maxReasonCodeUnits: 1600,
          maxEvidenceItems: 4,
          maxQuoteCodeUnits: 512,
          maxResponseBytes: 65536,
        });
        expect(request.system).toContain(JSON.stringify(contract));
        const response = JSON.parse(f.response().text);
        response.reviews[0].evidence = Array.from({ length: contract.maxEvidenceItems }, () => ({
          path: 'flow/report.md',
          quote: 'The observation is provisional',
        }));
        return { ...f.response(), text: JSON.stringify(response) };
      },
    },
  });
  expect(result.success).toBe(true);
  expect(calls).toBe(1);
  expect(result.receipt?.verdicts[0]?.evidence).toHaveLength(4);
});

test('reviewer response limits keep complete literal evidence strict without truncation coercion or retries', async () => {
  const vectors = [
    {
      label: 'four valid quotes',
      count: 4,
      reason: 1600,
      quote: 'The observation is provisional',
      pass: true,
    },
    {
      label: 'fifth valid quote',
      count: 5,
      reason: 20,
      quote: 'The observation is provisional',
      pass: false,
    },
    {
      label: 'reason one beyond bound',
      count: 1,
      reason: 1601,
      quote: 'The observation is provisional',
      pass: false,
    },
    { label: 'quote at bound', count: 1, reason: 20, quote: 'Q'.repeat(512), pass: true },
    { label: 'quote one beyond bound', count: 1, reason: 20, quote: 'Q'.repeat(513), pass: false },
    { label: 'Unicode at UTF16 bound', count: 1, reason: 20, quote: '🧭'.repeat(256), pass: true },
    {
      label: 'Unicode beyond UTF16 bound',
      count: 1,
      reason: 20,
      quote: '🧭'.repeat(257),
      pass: false,
    },
    {
      label: 'literal JSON characters',
      count: 1,
      reason: 20,
      quote: '"mode": "observed"',
      pass: true,
    },
    {
      label: 'invented escape characters',
      count: 1,
      reason: 20,
      quote: '\\"mode\\": \\"observed\\"',
      pass: false,
    },
  ];
  for (const vector of vectors) {
    const f = fixture();
    const actual =
      report + '\n' + 'Q'.repeat(513) + '\n' + '🧭'.repeat(257) + '\n' + '"mode": "observed"';
    writeFileSync(join(f.directory, 'report.md'), actual);
    let calls = 0;
    const response = JSON.parse(f.response().text);
    response.reviews[0].reason = 'R'.repeat(vector.reason);
    response.reviews[0].evidence = Array.from({ length: vector.count }, () => ({
      path: 'flow/report.md',
      quote: vector.quote,
    }));
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: {
        ...f.runtime,
        invoke: async () => {
          calls += 1;
          return { ...f.response(), text: JSON.stringify(response) };
        },
      },
    });
    expect(result.success, vector.label).toBe(vector.pass);
    expect(calls, vector.label).toBe(1);
    expect(result.receipt?.responseSha256).toBe(sha(JSON.stringify(response)));
    expect(result.receipt?.artifacts.find((a) => a.path === 'flow/report.md')?.sha256).toBe(
      sha(actual),
    );
    if (vector.pass) expect(result.receipt?.verdicts[0]?.evidence).toHaveLength(vector.count);
    else {
      expect(result.receipt?.outcome).toBe('unavailable');
      expect(result.expectations[0]?.repairScope).toBe('diagnostic-only');
      expect(result.receipt?.verdicts).toEqual([]);
    }
  }
});

test('reviewer quote guidance preserves decoded source whitespace on the actual invocation', async () => {
  const f = fixture();
  let calls = 0;
  let deliveredSystem = '';
  const result = await evaluateTrialSemanticReview({
    ...f.input,
    runtime: {
      ...f.runtime,
      invoke: async (request) => {
        calls += 1;
        deliveredSystem = request.system;
        return f.response();
      },
    },
  });
  expect(calls).toBe(1);
  expect(deliveredSystem).toContain('Preserve the decoded artifact characters exactly');
  expect(deliveredSystem).toContain('including whitespace, indentation and line breaks');
  expect(deliveredSystem).toContain('Never join JSON fields or separate lines');
  expect(deliveredSystem).toContain('one short contiguous source sentence or JSON field value');
  expect(result.success).toBe(true);
  expect(result.receipt?.responseSha256).toBe(sha(f.response().text));
  expect(result.receipt?.model).toEqual(f.runtime.model);
});

test('reviewer quote copying rejects reflowed JSON and Markdown without normalizing evidence', async () => {
  const jsonArtifact = '{\n  "sensor": "Café-日本",\n  "status": "pending"\n}\n';
  const markdownArtifact =
    '# Observation\r\n\r\nThe observation is provisional;\r\nits scope remains limited.\r\n';
  const vectors = [
    { artifact: jsonArtifact, quote: '"sensor": "Café-日本",\n  "status": "pending"', pass: true },
    { artifact: jsonArtifact, quote: 'Café-日本', pass: true },
    { artifact: jsonArtifact, quote: '"sensor": "Café-日本", "status": "pending"', pass: false },
    { artifact: jsonArtifact, quote: '"sensor": "Cafe\u0301-日本"', pass: false },
    {
      artifact: markdownArtifact,
      quote: 'The observation is provisional;\r\nits scope remains limited.',
      pass: true,
    },
    { artifact: markdownArtifact, quote: 'its scope remains limited.', pass: true },
    {
      artifact: markdownArtifact,
      quote: 'The observation is provisional; its scope remains limited.',
      pass: false,
    },
    {
      artifact: markdownArtifact,
      quote: 'The observation is provisional;\nits scope remains limited.',
      pass: false,
    },
  ];
  for (const vector of vectors) {
    const f = fixture();
    writeFileSync(join(f.directory, 'report.md'), vector.artifact);
    const response = JSON.parse(f.response().text);
    response.reviews[0].evidence = [{ path: 'flow/report.md', quote: vector.quote }];
    const text = JSON.stringify(response);
    let calls = 0;
    const result = await evaluateTrialSemanticReview({
      ...f.input,
      runtime: {
        ...f.runtime,
        invoke: async () => {
          calls += 1;
          return { ...f.response(), text };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.success).toBe(vector.pass);
    expect(result.receipt?.responseSha256).toBe(sha(text));
    expect(result.receipt?.artifacts.find((a) => a.path === 'flow/report.md')?.sha256).toBe(
      sha(vector.artifact),
    );
    if (vector.pass) {
      const quote = result.receipt?.verdicts[0]?.evidence[0];
      expect(quote?.quote).toBe(vector.quote);
      expect(quote?.offset).toBe(vector.artifact.indexOf(vector.quote));
      expect(quote?.quoteSha256).toBe(sha(vector.quote));
    } else {
      expect(result.receipt?.outcome).toBe('unavailable');
      expect(result.receipt?.verdicts).toEqual([]);
      expect(result.expectations[0]?.detail).toContain('invented_reviewer_quote');
      expect(result.expectations[0]?.repairScope).toBe('diagnostic-only');
    }
  }
});
