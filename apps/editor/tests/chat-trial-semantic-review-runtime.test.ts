import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import {
  trialRunChatYamlStage,
  trialNeedsPlanReview,
  type ChatPipelineTrialRunResult,
} from '../server/chat-pipeline-trial-run';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
  finalizeChatYamlStage,
} from '../server/chat-yaml-staging';
import {
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
} from '../server/server-record-auth';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import type {
  TrialSemanticReviewIdentity,
  TrialSemanticReviewRuntime,
} from '../server/chat-trial-semantic-review';
import { validateTrialSemanticReviewReceipts } from '../server/chat-trial-semantic-review';
import { parseChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';
import {
  semanticReviewIntent,
  semanticReviewPlanInput,
} from './helpers/trial-semantic-review-fixture';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(mode: 'write' | 'staged-only' | 'first-only' | 'fail' = 'write', verdictRun = 0) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-actual-semantic-trial-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'semantic');
  const sourceYaml = 'pipeline:\n  name: Base\n  tracks: []\n';
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml);
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    }),
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
  const namespace = entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'));
  const command =
    mode === 'fail'
      ? 'process.exit(7)'
      : mode === 'staged-only'
        ? 'process.stdout.write("no production")'
        : `const fs=require('node:fs');const n=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8'))+1:1;fs.writeFileSync('count.txt',String(n));${mode === 'first-only' ? 'if(n===1)' : ''}fs.writeFileSync('report.md','Run '+n+': '+fs.readFileSync('input.md','utf8'));`;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Actual dynamic report',
      tracks: [
        {
          id: 'flow',
          name: 'Inspection',
          cwd: `.tagma/${namespace}`,
          tasks: [
            {
              id: 'inspect',
              command: { argv: [process.execPath, '-e', command] },
              completion: { type: 'file_exists', path: 'report.md' },
            },
          ],
        },
      ],
    }),
  );
  if (mode === 'staged-only')
    writeFileSync(
      join(dirname(entry.stagedPath), 'report.md'),
      'Prewritten provisional observation.',
    );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  const raw = JSON.parse(
    JSON.stringify(semanticReviewPlanInput())
      .split('flow/report.md')
      .join(`${namespace}/report.md`)
      .split('flow/input.md')
      .join(`${namespace}/input.md`),
  );
  raw.cases[0].runs = 2;
  raw.yamlHash = createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex');
  writeFileSync(entry.stagedPath.replace(/\.ya?ml$/iu, '.trial-plan.json'), JSON.stringify(raw));
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
  const reviewed: TrialSemanticReviewIdentity[] = [];
  const runtime: TrialSemanticReviewRuntime = {
    model: { providerID: 'synthetic', modelID: 'independent-reviewer', variant: null },
    invoke: async (request) => {
      const bundle = JSON.parse(request.user) as {
        identity: TrialSemanticReviewIdentity;
        targets: Array<{ taskId: string; path: string }>;
        artifacts: Array<{ path: string; content: string }>;
      };
      reviewed.push(bundle.identity);
      return {
        sessionId: `ses_fixture_review_${reviewed.length}`,
        finishCode: 'stop',
        failureCode: null,
        text: JSON.stringify({
          version: 1,
          reviews: bundle.targets.map((target) => ({
            ...target,
            verdict: bundle.identity.runNumber === verdictRun ? 'fail' : 'pass',
            reason: 'The actual report is checked against the frozen input observation.',
            evidence: [
              {
                path: target.path,
                quote: bundle.artifacts
                  .find((item) => item.path === target.path)!
                  .content.slice(0, 128),
              },
            ],
          })),
        }),
      };
    },
  };
  return {
    ws,
    stage,
    entry,
    runtime,
    reviewed,
    plan: parseChatPipelineTrialPlan(raw),
    cleanup: () => discardChatYamlStage(ws, stage.id),
    run: (
      trialId: string,
      semanticReview: TrialSemanticReviewRuntime | null = runtime,
      trustedOperationV2 = true,
    ) =>
      trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId,
        trustedOperationV2,
        intentText: semanticReviewIntent,
        ...(semanticReview ? { semanticReview } : {}),
      }),
  };
}

test('actual Sandbox semantic review runs after task execution for every repeat', async () => {
  const f = fixture();
  try {
    const result = await f.run('semantic_actual_repeats');
    expect(result.ran).toBe(true);
    expect(result.success).toBe(true);
    expect(f.reviewed).toHaveLength(2);
    expect(f.reviewed.map((item) => item.runId)).toEqual(result.cases[0]!.runIds);
    expect(f.reviewed.map((item) => item.runNumber)).toEqual([1, 2]);
    expect(result.cases[0]!.semanticReviews?.map((item) => item.outcome)).toEqual([
      'passed',
      'passed',
    ]);
  } finally {
    f.cleanup();
  }
});

test('a failed earlier semantic repeat cannot be hidden and retains complete private repair evidence', async () => {
  const f = fixture('write', 1);
  try {
    const result = await f.run('semantic_first_repeat_fails');
    expect(result.ran).toBe(true);
    expect(result.success).toBe(false);
    expect(f.reviewed).toHaveLength(2);
    expect(result.cases[0]!.semanticReviews!.map((item) => item.outcome)).toEqual([
      'failed',
      'passed',
    ]);
    expect(
      result.cases[0]!.expectations.some(
        (item) =>
          item.type === 'artifact-semantic-review' &&
          !item.passed &&
          item.detail.startsWith('Run 1:'),
      ),
    ).toBe(true);
    expect(result.repairAuthorization).toBe('pipeline-change-allowed');
    expect(trialNeedsPlanReview(result.cases)).toBe(false);
    const evidence = JSON.parse(
      result.repairPipelineDiagnostics!.find((item) =>
        item.text.includes('independent-semantic-review'),
      )!.text,
    );
    const request = JSON.parse(evidence.request);
    expect(
      request.artifacts.some((item: { content: string }) => item.content.includes('Run 1:')),
    ).toBe(true);
    expect(JSON.parse(evidence.response).reviews[0].verdict).toBe('fail');
    expect(result.tasks.every((task) => task.status === 'success' && task.stdout === '')).toBe(
      true,
    );
    const unproved = result.cases.map((item) => ({ ...item, semanticReviews: [] }));
    expect(trialNeedsPlanReview(unproved)).toBe(true);
  } finally {
    f.cleanup();
  }
});

test('semantic outputs must be freshly produced rather than staged or inherited from a previous repeat', async () => {
  for (const mode of ['staged-only', 'first-only', 'fail'] as const) {
    const f = fixture(mode);
    try {
      const result = await f.run('semantic_production_' + mode);
      expect(result.ran).toBe(true);
      expect(result.success).toBe(false);
      expect(f.reviewed).toHaveLength(mode === 'first-only' ? 1 : 0);
      expect(result.cases[0]!.tasks.some((item) => item.status === 'failed')).toBe(true);
    } finally {
      f.cleanup();
    }
  }
});

test('semantic invocation is unavailable to legacy callers and missing Host model contexts', async () => {
  for (const trusted of [false, true]) {
    const f = fixture();
    try {
      const result = await f.run(
        'semantic_no_Host_' + trusted,
        trusted ? null : f.runtime,
        trusted,
      );
      expect(result.ran).toBe(false);
      expect(result.success).toBe(false);
      expect(f.reviewed).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  }
});

test('semantic same-attempt replay is exact but new trials and model configs require fresh execution', async () => {
  const f = fixture();
  try {
    const first = await f.run('semantic_cache_exact');
    expect(first.success).toBe(true);
    const replay = await f.run('semantic_cache_exact');
    expect(replay.success).toBe(true);
    expect(replay.cases[0]!.runIds).toEqual(first.cases[0]!.runIds);
    expect(f.reviewed).toHaveLength(2);
    const fresh = await f.run('semantic_cache_new_attempt');
    expect(fresh.success).toBe(true);
    expect(fresh.cases[0]!.runIds).not.toEqual(first.cases[0]!.runIds);
    expect(f.reviewed).toHaveLength(4);
    const changed = await f.run('semantic_cache_exact', {
      ...f.runtime,
      model: { ...f.runtime.model, modelID: 'other-reviewer' },
    });
    expect(changed.success).toBe(true);
    expect(f.reviewed).toHaveLength(6);
    expect(changed.cases[0]!.semanticReviews![0]!.model.modelID).toBe('other-reviewer');
  } finally {
    f.cleanup();
  }
});

test('semantic receipt validation rejects missing shifted or tampered current-run proofs', async () => {
  const f = fixture();
  try {
    const result = await f.run('semantic_receipt_guard');
    expect(result.success).toBe(true);
    const receipt = result.cases[0]!.semanticReviews![0]!;
    const { stageId, trialId, yamlHash, planHash } = receipt.identity;
    const validate = (cases: unknown) =>
      validateTrialSemanticReviewReceipts({
        plan: f.plan,
        cases,
        configurationDigest: receipt.configurationDigest,
        identity: { stageId, trialId, yamlHash, planHash },
      });
    expect(validate(result.cases)).toBe(true);
    for (const mutate of [
      (cases: typeof result.cases) => {
        cases[0]!.semanticReviews = [];
      },
      (cases: typeof result.cases) => {
        const receipt = cases[0]!.semanticReviews![0]!;
        receipt.identity = { ...receipt.identity, runId: 'another_run' };
      },
      (cases: typeof result.cases) => {
        const receipt = cases[0]!.semanticReviews![0]!;
        receipt.identity = { ...receipt.identity, planHash: '0'.repeat(64) };
      },
      (cases: typeof result.cases) => {
        cases[0]!.semanticReviews![0]!.verdicts[0]!.evidence[0]!.quote = 'invented quote';
      },
      (cases: typeof result.cases) => {
        cases[0]!.expectations = cases[0]!.expectations.filter(
          (item) => item.type !== 'artifact-semantic-review',
        );
      },
    ]) {
      const changed = structuredClone(result.cases);
      mutate(changed);
      expect(validate(changed)).toBe(false);
    }
  } finally {
    f.cleanup();
  }
});

test('finalize requires the complete semantic receipts even in an otherwise correctly signed cache', async () => {
  const f = fixture();
  try {
    const trialId = 'semantic_finalize_missing_receipts';
    expect((await f.run(trialId)).success).toBe(true);
    const directory = join(f.stage.rootDir, '.trial-runs');
    const cachePath = join(
      directory,
      readdirSync(directory).find((name) => name.endsWith('.json'))!,
    );
    const context = {
      workspaceTagmaDir: join(f.ws.workDir, '.tagma'),
      controlRoot: directory,
      stageId: f.stage.id,
      kind: 'trial-cache' as const,
    };
    const cache = readAuthenticatedServerRecordSync<
      { result: ChatPipelineTrialRunResult } & Record<string, unknown>
    >(cachePath, context);
    cache.result.cases[0]!.semanticReviews = [];
    writeAuthenticatedServerRecordSync(cachePath, context, cache);
    const result = await finalizeChatYamlStage(f.ws, {
      stageId: f.stage.id,
      relativePath: f.entry.relativePath,
      trialId,
      retainStage: true,
    });
    expect(result.trialVerification).toBe('not-verified');
    expect(result.conflicts).toContain('trial-run-failed');
  } finally {
    f.cleanup();
  }
});

test('finalize accepts current semantic execution receipts without changing the input-hash contract', async () => {
  const f = fixture();
  try {
    const trialId = 'semantic_finalize_valid';
    expect((await f.run(trialId)).success).toBe(true);
    const result = await finalizeChatYamlStage(f.ws, {
      stageId: f.stage.id,
      relativePath: f.entry.relativePath,
      trialId,
      retainStage: true,
    });
    expect(result.trialVerification).toBe('verified');
    expect(result.conflicts).not.toContain('trial-run-failed');
  } finally {
    f.cleanup();
  }
});
