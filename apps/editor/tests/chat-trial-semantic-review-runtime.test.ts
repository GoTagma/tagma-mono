import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  buildChatRepairErrorEvidence,
  isChatRepairErrorEvidence,
} from '../server/chat-operations/repair-error-evidence';
import { createTrialTaskStreamEvidenceSink } from '../server/chat-operations/trial-stream-evidence-store';
import { buildManagedChatOperationV2ExecutionPrompt } from '../server/chat-operations/authoring-runtime';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission';
import {
  semanticReviewIntent,
  semanticReviewPlanInput,
} from './helpers/trial-semantic-review-fixture';

const savedStageRecordKeyFile = process.env.TAGMA_STAGE_RECORD_KEY_FILE;
let isolatedKeyRoot: string;
beforeAll(() => {
  // macOS tmpdir may start with /var -> /private/var. Keep the production fence strict.
  isolatedKeyRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-semantic-test-key-')));
  process.env.TAGMA_STAGE_RECORD_KEY_FILE = join(isolatedKeyRoot, 'record.key');
});
afterAll(() => {
  if (savedStageRecordKeyFile === undefined) delete process.env.TAGMA_STAGE_RECORD_KEY_FILE;
  else process.env.TAGMA_STAGE_RECORD_KEY_FILE = savedStageRecordKeyFile;
  rmSync(isolatedKeyRoot, { recursive: true, force: true });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  mode: 'write' | 'staged-only' | 'first-only' | 'fail' = 'write',
  verdictRun = 0,
  emptyQualificationCases = false,
  archivedOutput?: 'jsonl' | 'unicode',
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-actual-semantic-trial-')));
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
  if (archivedOutput) {
    const emit =
      archivedOutput === 'jsonl'
        ? `for(let i=0;i<7000;i++)console.log(JSON.stringify({type:'tool_use',run:n,index:i,output:'ordinary successful context '.repeat(5)}));`
        : `process.stdout.write(('Run '+n+' café-日本 🧭 complete source context\\n').repeat(22000));`;
    writeFileSync(
      join(dirname(entry.stagedPath), 'semantic-context.js'),
      command + emit + "process.stdout.write('COMPLETE_CONTEXT_END');",
    );
  }
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
              command: {
                argv: archivedOutput
                  ? [process.execPath, 'semantic-context.js']
                  : [process.execPath, '-e', command],
              },
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
  if (archivedOutput)
    raw.cases[0].fixtures[0].content =
      '{\n  "observation": "A café-日本 reading remains provisional",\n  "status": "uncertain"\n}\n';
  if (emptyQualificationCases) {
    raw.cases[0].runs = 1;
    raw.cases[0].fixtures[0].content = 'No observations supplied.';
    const emptyCase = { ...structuredClone(raw.cases[0]), id: 'valid-empty' };
    emptyCase.expectations = [
      { type: 'task-status', taskId: 'flow.inspect', status: 'success' },
      {
        type: 'file-equals',
        path: `${namespace}/report.md`,
        text: 'Run 1: No observations supplied.',
      },
    ];
    raw.cases.push(emptyCase);
  }

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
  const archiveRoot = join(root, '.tagma', '.chat-staging', stage.id, '.trial-streams');
  const taskStreamEvidenceSink = archivedOutput
    ? createTrialTaskStreamEvidenceSink(
        {
          workspaceTagmaDir: join(root, '.tagma'),
          controlRoot: dirname(archiveRoot),
          stageId: stage.id,
          kind: 'stage-metadata',
        },
        {
          workspaceScopeId: 'semantic-context-workspace',
          operationId: 'semantic-context-operation',
          operationGeneration: 1,
          stageId: stage.id,
        },
      )
    : undefined;
  return {
    root,
    ws,
    stage,
    entry,
    runtime,
    reviewed,
    archiveRoot,
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
        ...(taskStreamEvidenceSink ? { taskStreamEvidenceSink } : {}),
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

function expandRepairReferences(value: unknown, shared: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => expandRepairReferences(item, shared));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.textRef === 'string')
      return shared[record.textRef];
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, expandRepairReferences(item, shared)]),
    );
  }
  return value;
}

for (const shape of ['jsonl', 'unicode'] as const) {
  test(`semantic-only repair context bounds archived successful ${shape} streams without changing review evidence`, async () => {
    const f = fixture('write', 1, false, shape);
    const trialId = `semantic_context_${shape}`;
    try {
      const result = await f.run(trialId);
      expect(result.success).toBe(false);
      expect(result.repairAuthorization).toBe('pipeline-change-allowed');
      expect(result.cases[0]!.taskStatusCounts).toEqual({ success: 2 });
      expect(result.cases[0]!.semanticReviews?.map((r) => r.outcome)).toEqual(['failed', 'passed']);
      expect(f.reviewed).toHaveLength(2);
      const originals = result.repairErrorTasks!;
      expect(originals).toHaveLength(2);
      expect(
        originals.every(
          (t) => t.stdout.length > 500000 && t.stdout.endsWith('COMPLETE_CONTEXT_END'),
        ),
      ).toBe(true);
      const evidence = buildChatRepairErrorEvidence(trialId, result);
      expect(Buffer.byteLength(evidence.text)).toBeLessThan(128 * 1024);
      expect(isChatRepairErrorEvidence(evidence)).toBe(true);
      expect(evidence.hash).toBe(createHash('sha256').update(evidence.text).digest('hex'));
      const encoded = JSON.parse(evidence.text);
      const parsed = expandRepairReferences(encoded, encoded.sharedTexts) as {
        tasks: unknown[];
        successfulExecutionContext: Array<{
          caseId: string;
          runNumber: number;
          taskId: string;
          stdoutExcerpt: {
            prefix: string;
            suffix: string;
            fullSha256: string;
            fullByteLength: number;
            omittedCodeUnits: number;
          };
          archive: { streams: Array<{ stream: string; hash: string; state: string }> };
        }>;
        pipelineDiagnostics: Array<
          NonNullable<typeof result.repairPipelineDiagnostics>[number] & {
            expectedCaseOutcome: boolean;
          }
        >;
        cases: typeof result.cases;
      };
      expect(parsed.tasks).toHaveLength(0);
      expect(parsed.successfulExecutionContext).toHaveLength(2);
      for (const context of parsed.successfulExecutionContext) {
        const original = originals.find(
          (t) =>
            t.caseId === context.caseId &&
            t.runNumber === context.runNumber &&
            t.taskId === context.taskId,
        )!;
        const excerpt = context.stdoutExcerpt;
        expect(excerpt.prefix.length + excerpt.suffix.length).toBeLessThanOrEqual(2048);
        expect(original.stdout.startsWith(excerpt.prefix)).toBe(true);
        expect(original.stdout.endsWith(excerpt.suffix)).toBe(true);
        expect(excerpt.omittedCodeUnits).toBe(
          original.stdout.length - excerpt.prefix.length - excerpt.suffix.length,
        );
        expect(excerpt.fullByteLength).toBe(Buffer.byteLength(original.stdout));
        expect(excerpt.fullSha256).toBe(createHash('sha256').update(original.stdout).digest('hex'));
        const stream = context.archive.streams.find((s) => s.stream === 'stdout')!;
        expect(stream.state).toBe('complete');
        expect(stream.hash).toBe(excerpt.fullSha256);
        expect(readFileSync(join(f.archiveRoot, stream.hash + '.utf8'), 'utf8')).toBe(
          original.stdout,
        );
      }
      const semantic = result.repairPipelineDiagnostics!.filter((d) =>
        d.text.includes('independent-semantic-review'),
      );
      expect(semantic.length).toBeGreaterThan(0);
      for (const original of semantic)
        expect(parsed.pipelineDiagnostics?.find((d) => d.text === original.text)).toEqual({
          ...original,
          expectedCaseOutcome: false,
        });
      expect(parsed.cases[0]!.expectations).toEqual(result.cases[0]!.expectations);
      expect(result.success).toBe(false);
      expect(originals.every((t) => t.stdout.endsWith('COMPLETE_CONTEXT_END'))).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 30000);
}

test('semantic-only repair context preserves complete streams for missing proofs other assertions and real errors', async () => {
  const f = fixture('write', 1, false, 'jsonl');
  const trialId = 'semantic_context_controls';
  try {
    const original = await f.run(trialId);
    const vectors: Array<{ label: string; change: (trial: ChatPipelineTrialRunResult) => void }> = [
      {
        label: 'no archive',
        change: (trial) => {
          delete trial.taskStreamEvidence;
        },
      },
      {
        label: 'partial archive',
        change: (trial) => {
          trial.taskStreamEvidence![0] = { ...trial.taskStreamEvidence![0]!, status: 'partial' };
        },
      },
      {
        label: 'wrong archive hash',
        change: (trial) => {
          const item = trial.taskStreamEvidence![0]!;
          trial.taskStreamEvidence![0] = {
            ...item,
            streams: item.streams!.map((s) =>
              s.stream === 'stdout' ? { ...s, hash: '0'.repeat(64) } : s,
            ),
          };
        },
      },
      {
        label: 'missing receipt',
        change: (trial) => {
          trial.cases[0]!.semanticReviews = [];
        },
      },
      {
        label: 'missing complete review details',
        change: (trial) => {
          trial.repairPipelineDiagnostics = trial.repairPipelineDiagnostics!.filter(
            (d) => !d.text.includes('independent-semantic-review'),
          );
        },
      },
      {
        label: 'foreign review identity',
        change: (trial) => {
          const receipt = trial.cases[0]!.semanticReviews![0]!;
          trial.cases[0]!.semanticReviews![0] = {
            ...receipt,
            identity: { ...receipt.identity, trialId: 'foreign_trial' },
          };
        },
      },
      {
        label: 'unbound review request',
        change: (trial) => {
          trial.cases[0]!.semanticReviews![0]!.requestSha256 = '0'.repeat(64);
        },
      },
      {
        label: 'unbound review response',
        change: (trial) => {
          trial.cases[0]!.semanticReviews![0]!.responseSha256 = '0'.repeat(64);
        },
      },
      {
        label: 'stale reviewer configuration',
        change: (trial) => {
          trial.cases[0]!.semanticReviews![0]!.configurationDigest = '0'.repeat(64);
        },
      },
      {
        label: 'other assertion failed',
        change: (trial) => {
          trial.cases[0]!.expectations.push({
            type: 'file-contains',
            passed: false,
            detail: 'A concrete source span is missing.',
            repairScope: 'pipeline-artifact',
          });
        },
      },
      {
        label: 'actual task failure',
        change: (trial) => {
          trial.repairErrorTasks![0]!.status = 'failed';
          trial.repairErrorTasks![0]!.stderr =
            'REAL_FAILURE_FIRST\n' + 'complete error context '.repeat(4000) + 'REAL_FAILURE_LAST';
          trial.cases[0]!.taskStatusCounts = { success: 1, failed: 1 };
        },
      },
      {
        label: 'successful stderr',
        change: (trial) => {
          trial.repairErrorTasks![0]!.stderr =
            'SUCCESS_DIAGNOSTIC_FIRST\n' +
            'complete warning context '.repeat(4000) +
            'SUCCESS_DIAGNOSTIC_LAST';
        },
      },
    ];
    for (const vector of vectors) {
      const trial = structuredClone(original);
      vector.change(trial);
      const evidence = buildChatRepairErrorEvidence(trialId, trial);
      const encoded = JSON.parse(evidence.text);
      const parsed = expandRepairReferences(encoded, encoded.sharedTexts) as {
        tasks: Array<{
          caseId: string;
          taskId: string;
          runNumber: number;
          stdout: string;
          stderr: string;
        }>;
      };
      const source = trial.repairErrorTasks![0]!;
      const task = parsed.tasks.find(
        (t) =>
          t.caseId === source.caseId &&
          t.runNumber === source.runNumber &&
          t.taskId === source.taskId,
      );
      expect(task, vector.label).toBeDefined();
      expect(task!.stdout, vector.label).toBe(source.stdout);
      expect(task!.stderr, vector.label).toBe(source.stderr);
      expect(isChatRepairErrorEvidence(evidence), vector.label).toBe(true);
    }
  } finally {
    f.cleanup();
  }
}, 30000);

test('semantic-only repair context reaches the sealed repair prompt with explicit excerpt scope', async () => {
  const f = fixture('write', 1, false, 'jsonl');
  try {
    const result = await f.run('semantic_context_prompt');
    const evidence = buildChatRepairErrorEvidence('semantic_context_prompt', result);
    const request = {
      purpose: 'repair',
      repairAttempt: 1,
      repairEvidence: {
        feedback: {
          schemaVersion: 1,
          stage: 'trial',
          details: 'Independent content review failed.',
          failedTaskIds: ['flow.inspect'],
          omittedFailedTaskCount: 0,
        },
        diagnosticCodes: ['trial_failed'],
        errors: evidence.text,
        errorEvidenceHash: evidence.hash,
      },
    };
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'semantic-repair',
      sessionId: 'semantic-repair-session',
      executionMessageId: 'semantic-repair-input',
      purpose: 'repair',
      intent: 'create',
      stageDirectory: f.root,
      targetRelativePath: f.entry.relativePath,
      trialPlanRequest: null,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: { schemaVersion: 1, text: semanticReviewIntent, attachments: [] },
        provider: 'test',
        model: 'offline-fixture',
        variant: null,
        agentPolicyHash: '1'.repeat(64),
        settingsHash: '2'.repeat(64),
        capabilityHash: '3'.repeat(64),
        featureHash: '4'.repeat(64),
        rendererInstanceId: 'semantic-renderer',
        conversationId: 'semantic-conversation',
        inventoryRevision: 1,
        inventoryDigest: '5'.repeat(64),
        readSnapshotHash: null,
        purpose: 'authoring',
        admittedAt: 1,
      }),
      clarificationThread: null,
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
      canonicalRequestBytes: new TextEncoder().encode(JSON.stringify(request)),
    });
    expect(prompt.system).toContain('successfulExecutionContext');
    expect(prompt.system).toContain('not complete stdout');
    expect(prompt.system).toContain('grant no private-file access');
    expect(Buffer.byteLength(prompt.text)).toBeLessThan(512 * 1024);
    const encoded = prompt.text.match(
      /<repair-error-evidence>([\s\S]*?)<\/repair-error-evidence>/u,
    )![1]!;
    const decoded = encoded
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&');
    expect(decoded).toBe(evidence.text);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(evidence.hash);
    expect(f.reviewed).toHaveLength(2);
    expect(result.success).toBe(false);
  } finally {
    f.cleanup();
  }
}, 30000);

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

test('deterministic input identity blocks a passing critic until actual producer bytes are repaired', async () => {
  const f = fixture();
  try {
    const planPath = f.entry.stagedPath.replace(/\.ya?ml$/iu, '.trial-plan.json');
    const raw = JSON.parse(readFileSync(planPath, 'utf8'));
    const normal = raw.cases[0];
    normal.runs = 1;
    normal.expectations.push({
      type: 'file-equals',
      path: normal.expectations[1].path,
      text: normal.fixtures[0].content,
    });
    writeFileSync(planPath, JSON.stringify(raw));
    writeAuthenticatedTrialPlanTelemetry(f.entry.stagedPath);
    const failed = await f.run('identity_mutated');
    expect(failed.success).toBe(false);
    expect(failed.tasks.every((task) => task.status === 'success')).toBe(true);
    expect(f.reviewed).toHaveLength(0);
    expect(failed.kind).toBe('plan-required');
    const before = await finalizeChatYamlStage(f.ws, {
      stageId: f.stage.id,
      relativePath: f.entry.relativePath,
      trialId: 'identity_mutated',
      retainStage: true,
    });
    expect(before.trialVerification).toBe('not-verified');
    const good = fixture();
    try {
      const config = parseYaml(readFileSync(good.entry.stagedPath, 'utf8'));
      const correctedTask = {
        ...config.tracks[0]!.tasks[0]!,
        command: {
          argv: [
            process.execPath,
            '-e',
            "const fs=require('node:fs');fs.writeFileSync('report.md',fs.readFileSync('input.md'))",
          ],
        },
      };
      const correctedConfig = {
        ...config,
        tracks: [
          { ...config.tracks[0]!, tasks: [correctedTask, ...config.tracks[0]!.tasks.slice(1)] },
          ...config.tracks.slice(1),
        ],
      };
      writeFileSync(good.entry.stagedPath, serializePipeline(correctedConfig));
      expect(compileChatYamlStage(good.ws, good.stage.id, good.entry.relativePath).success).toBe(
        true,
      );
      const goodPlanPath = good.entry.stagedPath.replace(/\.ya?ml$/iu, '.trial-plan.json');
      const goodPlan = JSON.parse(readFileSync(goodPlanPath, 'utf8'));
      goodPlan.cases[0].runs = 1;
      goodPlan.cases[0].expectations.push({
        type: 'file-equals',
        path: goodPlan.cases[0].expectations[1].path,
        text: goodPlan.cases[0].fixtures[0].content,
      });
      goodPlan.yamlHash = createHash('sha1')
        .update(readFileSync(good.entry.stagedPath))
        .digest('hex');
      writeFileSync(goodPlanPath, JSON.stringify(goodPlan));
      writeAuthenticatedTrialPlanTelemetry(good.entry.stagedPath);
      const repaired = await good.run('identity_preserved');
      expect(repaired.success).toBe(true);
      expect(good.reviewed).toHaveLength(1);
      const after = await finalizeChatYamlStage(good.ws, {
        stageId: good.stage.id,
        relativePath: good.entry.relativePath,
        trialId: 'identity_preserved',
        retainStage: true,
      });
      expect(after.trialVerification).toBe('verified');
    } finally {
      good.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('normal core qualification reaches the real reviewer without turning valid empty cases into positive witnesses', async () => {
  const f = fixture('write', 0, true);
  const requests: Array<{
    identity: TrialSemanticReviewIdentity;
    normalCoreWitness?: { normalCaseId: string; contentTaskIds: string[] } | null;
    targets: Array<{ taskId: string; path: string }>;
    artifacts: Array<{ path: string; content: string }>;
  }> = [];
  try {
    const result = await f.run('semantic_empty_positive_qualification', {
      ...f.runtime,
      invoke: async ({ user }) => {
        const bundle = JSON.parse(user) as (typeof requests)[number];
        requests.push(bundle);
        // Models can correctly allow empty behavior yet miss its distinct qualification role.
        const normal = bundle.normalCoreWitness?.normalCaseId === bundle.identity.caseId;
        return {
          sessionId: 'ses_context_qualification_' + requests.length,
          finishCode: 'stop',
          failureCode: null,
          text: JSON.stringify({
            version: 1,
            reviews: bundle.targets.map((target) => ({
              ...target,
              verdict: normal ? 'uncertain' : 'pass',
              reason: normal
                ? 'Valid empty behavior does not exercise the promised positive observation explanation.'
                : 'No observations were supplied, so the requested empty behavior is correct.',
              evidence: [
                {
                  path: target.path,
                  quote: bundle.artifacts.find((a) => a.path === target.path)!.content,
                },
              ],
            })),
          }),
        };
      },
    });
    expect(result.ran).toBe(true);
    expect(result.success).toBe(false);
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.normalCoreWitness).toEqual({
        normalCaseId: 'normal',
        contentTaskIds: ['flow.inspect'],
      });
      expect(request.artifacts.some((a) => a.content.includes('No observations supplied.'))).toBe(
        true,
      );
    }
    expect(result.cases.map((c) => c.success)).toEqual([false, true]);
    expect(result.cases.map((c) => c.semanticReviews?.[0]?.outcome)).toEqual([
      'uncertain',
      undefined,
    ]);
    expect(
      result.cases[0]!.expectations.some((e) => !e.passed && e.repairScope === 'diagnostic-only'),
    ).toBe(true);
    expect(result.tasks.filter((t) => t.status === 'success')).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});
