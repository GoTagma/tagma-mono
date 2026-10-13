import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool.js';
import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  readChatPipelineTrialPlanRejectionEvidence,
  readChatPipelineTrialPlanToolTelemetry,
} from '../server/chat-pipeline-trial-plan.js';
import { buildTrialPlanValidationContext } from '../server/chat-trial-intent-coverage.js';
import { buildChatRepairErrorEvidence } from '../server/chat-operations/repair-error-evidence.js';
import {
  createTrialResilienceRules,
  TRIAL_EVIDENCE_KINDS,
} from '../server/chat-trial-resilience-rules.js';
import { parseYaml, resolveConfig } from '@tagma/sdk/yaml';

const relationMessage =
  'Core source-text relation needs owned generated source, dependency, and independent concrete source content.';
const contentMessage =
  'Core content requires a concrete JSON value, nonempty exact file bytes, or present:true source occurrence; status/existence/schema alone is insufficient.';
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function fixture(fault: 'anchor' | 'mapping' | 'role' | 'none' | 'long') {
  const root = mkdtempSync(join(tmpdir(), 'tagma-core-rejection-coordinate-'));
  try {
    const directory = join(root, '.tagma/.chat-staging/local-stage/agent-workspace/.tagma');
    const yamlPath = join(directory, 'handoff/handoff.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    const yaml = [
      'pipeline:',
      '  name: Local source handoff',
      '  tracks:',
      '    - id: native',
      '      cwd: .tagma/handoff',
      '      tasks:',
      '        - id: produce',
      '          command: echo producer',
      '          completion:',
      '            type: file_exists',
      '            path: source.json',
      '        - id: gate',
      '          command: echo gate',
      '          depends_on: [native.produce]',
      '        - id: render',
      '          command: echo report',
      '          depends_on: [native.gate]',
      '          completion:',
      '            type: file_exists',
      '            path: report.md',
      '',
    ].join('\n');
    writeFileSync(yamlPath, yaml);
    const yamlHash = createHash('sha1').update(yaml).digest('hex');
    const intentDigest = sha(
      'Preserve independent input identity in fresh produced source and render actual current source text through its gate.',
    );
    const attemptId = 'host-local-coordinate-attempt';
    const stage = dirname(dirname(directory));
    writeFileSync(
      join(stage, 'stage.json'),
      JSON.stringify({
        trialPlanMaxAttempts: 2,
        trialPlanAttempt: {
          relativePath: 'handoff/handoff.yaml',
          yamlHash,
          attemptId,
          validationContext: buildTrialPlanValidationContext(
            resolveConfig(parseYaml(yaml), root),
            [],
            { relativeYamlPath: 'handoff/handoff.yaml', workDir: root },
            intentDigest,
          ),
        },
      }),
    );
    const pluginDir = join(root, 'node_modules/@opencode-ai/plugin');
    mkdirSync(dirname(pluginDir), { recursive: true });
    symlinkSync(
      dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
      pluginDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const modulePath = join(root, 'generated-trial-plan.mjs');
    writeFileSync(modulePath, buildTagmaTrialPlanTool());
    const tool = (await import(pathToFileURL(modulePath).href)).default;
    const call = (operation: string, extra: Record<string, unknown> = {}) =>
      tool.execute(
        { operation, pipeline_path: yamlPath, attempt_id: attemptId, ...extra },
        { directory },
      );
    const sourcePath =
      fault === 'long' ? 'handoff/' + '界'.repeat(72) + '/source.json' : 'handoff/source.json';
    const outputPath =
      fault === 'long' ? 'handoff/' + '報'.repeat(190) + '/report.md' : 'handoff/report.md';
    const sourcePointer = fault === 'long' ? '/' + '欄'.repeat(500) : '/text';
    if (fault === 'long') {
      expect(Buffer.byteLength(sourcePath, 'utf8')).toBeLessThanOrEqual(240);
      expect(sourcePath.length).toBeLessThanOrEqual(240);
      expect(outputPath.length).toBeLessThanOrEqual(240);
      expect(sourcePointer.length).toBeLessThanOrEqual(512);
    }
    const expectation = {
      type: 'file-source-text-occurrence',
      path: outputPath,
      sourcePath,
      sourcePointer,
      producerTaskId: 'native.produce',
      consumerTaskId: 'native.render',
      present: true,
    };
    const core = {
      status: 'covered',
      normalCaseId: 'normal',
      taskRoles: [
        {
          taskId: 'native.produce',
          role: 'content',
          expectationIndices: [fault === 'anchor' ? 3 : 4],
          rationale:
            'Require the independently specified produced identity, without predicting full dynamic bytes.',
        },
        {
          taskId: 'native.gate',
          role: 'execution',
          expectationIndices: [],
          rationale: 'Execution-only gate has no independent content promise.',
        },
        {
          taskId: 'native.render',
          role: 'content',
          expectationIndices: [fault === 'role' ? 6 : 5],
          rationale: 'Render the actual same-run producer text in the dependent report.',
        },
      ],
      generatedInputs: [
        {
          path: sourcePath,
          producerTaskId: 'native.produce',
          consumerTaskId: fault === 'mapping' ? 'native.gate' : 'native.render',
        },
      ],
    };
    await call('begin', {
      summary: 'Bound the current rejected coordinate.',
      goals: ['Preserve all source-witness guards.'],
    });
    await call('upsert-case', {
      case: {
        id: 'normal',
        title: 'Fresh source handoff',
        objective: 'Produce and render actual source.',
        runs: 2,
        targetTaskIds: ['native.render'],
        fixtures: [{ path: sourcePath, content: null }],
        generatedInputPaths: [sourcePath],
        expectations: [
          { type: 'task-status', taskId: 'native.produce', status: 'success' },
          { type: 'task-status', taskId: 'native.gate', status: 'success' },
          { type: 'task-status', taskId: 'native.render', status: 'success' },
          { type: 'json-valid', path: sourcePath },
          {
            type: 'json-pointer-equals',
            path: sourcePath,
            pointer: '/recordId',
            expectedJson: '"source-identity"',
          },
          expectation,
          { type: 'path-exists', path: outputPath },
        ],
      },
    });
    await call('set-coverage', {
      coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
        dimension,
        status: 'accepted-risk',
        caseIds: [],
        rationale:
          'Focused no-model structural regression; unrelated availability remains unknown.',
      })),
    });
    await call('set-findings', { findings: [] });
    await call('set-evidence-review', {
      evidence_review: {
        version: 1,
        intentDigest,
        decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
          type,
          required: false,
          taskIds: [],
          rationale:
            'No controlled-recovery or external preservation promise in this synthetic contract.',
        })),
        coreWitness: core,
      },
    });
    const key = sha('handoff/handoff.yaml' + String.fromCharCode(0) + yamlHash);
    const draftPath = join(stage, '.trial-plan-drafts', key + '.json');
    const beforeDraft = readFileSync(draftPath);
    const beforeTelemetry = readChatPipelineTrialPlanToolTelemetry(yamlPath, 2);
    return {
      root,
      stage,
      directory,
      yamlPath,
      yamlHash,
      intentDigest,
      attemptId,
      call,
      draftPath,
      beforeDraft,
      beforeTelemetry,
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function rejected(fault: 'anchor' | 'mapping' | 'role') {
  const f = await fixture(fault);
  try {
    let thrown: unknown;
    try {
      await f.call('validate');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const oldMessage = fault === 'role' ? contentMessage : relationMessage;
    expect((thrown as Error).message.split('\n')[0]).toBe(oldMessage);
    expect(readFileSync(f.draftPath)).toEqual(f.beforeDraft);
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(f.beforeTelemetry);
    const evidence = readChatPipelineTrialPlanRejectionEvidence(f.yamlPath, 2, f.attemptId)!;
    expect(evidence).not.toBeNull();
    expect(evidence.submissionConsumed).toBe(false);
    expect(evidence.toolAttemptCount).toBe(0);
    expect(evidence.yamlHash).toBe(f.yamlHash);
    const detail = JSON.parse(evidence.text);
    expect(detail.message).toBe(fault === 'role' ? contentMessage : relationMessage);
    expect(detail.missingEvidence).toEqual([]);
    expect(detail.issues).toEqual([]);
    const d = JSON.parse(f.beforeDraft.toString());
    const plan = {
      version: d.version,
      yamlHash: d.yamlHash,
      summary: d.summary,
      goals: d.goals,
      coverage: d.coverage,
      findings: d.findings,
      cases: d.cases,
      evidenceReview: d.evidenceReview,
    };
    const stage = JSON.parse(readFileSync(join(f.stage, 'stage.json'), 'utf8'));
    let pureError: unknown;
    try {
      createTrialResilienceRules().validateCoreWitness(
        plan,
        stage.trialPlanAttempt.validationContext.tasks,
        true,
      );
    } catch (error) {
      pureError = error;
    }
    expect(pureError).toBeInstanceOf(Error);
    expect((pureError as Error).message).toBe(oldMessage);
    const marker = '\nrejectionContext: ';
    // The old-production RED now requires actionable data in the actual native error string.
    expect((thrown as Error).message.startsWith(oldMessage + marker)).toBe(true);
    const encodedNativeContext = (thrown as Error).message.slice(oldMessage.length + marker.length);
    expect(Buffer.byteLength(encodedNativeContext, 'utf8')).toBeLessThanOrEqual(2048);
    const nativeContext = JSON.parse(encodedNativeContext);
    const context = detail.rejectionContext;
    expect(nativeContext).toEqual(context);
    // This is the genuine old-production RED: setup and the old guard already succeeded above.
    expect(context).toMatchObject({
      version: 1,
      availability: 'unknown',
      normalCaseId: 'normal',
      expectationIndex: fault === 'role' ? 6 : 5,
      expectationType: fault === 'role' ? 'path-exists' : 'file-source-text-occurrence',
      path: 'handoff/report.md',
      failedConjunct:
        fault === 'anchor'
          ? 'independent_producer_content'
          : fault === 'mapping'
            ? 'generated_input_mapping'
            : 'supported_content_shape',
    });
    expect(context.binding).toMatchObject({
      attemptId: f.attemptId,
      relativeYamlPath: 'handoff/handoff.yaml',
      yamlHash: f.yamlHash,
      intentDigest: f.intentDigest,
      committedPlanHash: null,
      candidateMatchesCommittedPlan: false,
    });
    expect(context.binding.candidatePlanHash).toBe(sha(JSON.stringify(plan, null, 2) + '\n'));
    const canonical = buildChatRepairErrorEvidence('local-coordinate-trial', {
      version: 47,
      success: false,
      kind: 'plan-required',
      ran: false,
      runId: null,
      summary: detail.message,
      durationMs: 0,
      totalTaskCount: 0,
      omittedTaskCount: 0,
      taskStatusCounts: {},
      omittedTaskStatusCounts: {},
      tasks: [],
      cases: [],
      repairAuthorization: 'diagnostic-only',
      repairPlanRejectionEvidence: evidence,
    } as never);
    const privateFeedback = JSON.parse(canonical.text);
    expect(JSON.parse(privateFeedback.planRejectionEvidence.text).rejectionContext).toEqual(
      context,
    );
    expect(privateFeedback.planRejectionEvidence.nativeHash).toBe(evidence.hash);
    expect(canonical.hash).toBe(sha(canonical.text));
    expect(JSON.stringify(context)).not.toContain('source-identity');
    expect(JSON.stringify(context)).not.toContain('rationale');
    if (fault === 'role') expect(context.roleTaskId).toBe('native.render');
    if (fault === 'anchor') expect(context.producerRoleExpectationIndices).toEqual([3]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test('current generated rejection exposes bound failed producer coordinates while preserving the guard', async () =>
  rejected('anchor'));
test('current generated rejection identifies the exact source mapping without permitting it', async () =>
  rejected('mapping'));
test('current generated rejection identifies an unsupported selected role index without weakening content', async () =>
  rejected('role'));

test('valid transitive source witness still validates and commits exactly once', async () => {
  const f = await fixture('none');
  try {
    expect(JSON.parse(await f.call('validate'))).toMatchObject({
      valid: true,
      submissionConsumed: false,
    });
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(f.beforeTelemetry);
    expect(JSON.parse(await f.call('commit'))).toMatchObject({ yamlHash: f.yamlHash });
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
      attemptIds: [f.attemptId],
    });
    await expect(f.call('commit')).rejects.toThrow('commit was already attempted');
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2).toolAttemptCount).toBe(1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('foreign attempt and changed intent still reject before coordinate enrichment', async () => {
  const f = await fixture('none');
  try {
    const stagePath = join(f.stage, 'stage.json');
    const stage = JSON.parse(readFileSync(stagePath, 'utf8'));
    stage.trialPlanAttempt.attemptId = 'foreign-attempt';
    writeFileSync(stagePath, JSON.stringify(stage));
    await expect(f.call('validate')).rejects.toThrow('attempt_id was not issued by the host');
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(f.beforeTelemetry);
    stage.trialPlanAttempt.attemptId = f.attemptId;
    stage.trialPlanAttempt.validationContext.intentDigest = sha('changed intent');
    writeFileSync(stagePath, JSON.stringify(stage));
    await expect(f.call('validate')).rejects.toThrow(
      'Evidence review changed the frozen intent digest.',
    );
    expect(readFileSync(f.draftPath)).toEqual(f.beforeDraft);
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(f.beforeTelemetry);
    const evidence = readChatPipelineTrialPlanRejectionEvidence(f.yamlPath, 2, f.attemptId)!;
    expect(JSON.parse(evidence.text).rejectionContext).toBeUndefined();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('native coordinate suffix is byte bounded and reports omitted long coordinates', async () => {
  const f = await fixture('long');
  try {
    let thrown: unknown;
    try {
      await f.call('validate');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const marker = '\nrejectionContext: ';
    expect((thrown as Error).message.startsWith(relationMessage + marker)).toBe(true);
    const encoded = (thrown as Error).message.slice(relationMessage.length + marker.length);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(2048);
    const context = JSON.parse(encoded);
    expect(context).toMatchObject({
      availability: 'unknown',
      normalCaseId: 'normal',
      expectationIndex: 5,
      failedConjunct: 'producer_artifact_ownership',
      binding: {
        attemptId: f.attemptId,
        yamlHash: f.yamlHash,
        intentDigest: f.intentDigest,
        committedPlanHash: null,
      },
    });
    expect(context.omittedFields).toEqual([
      'path',
      'sourcePath',
      'sourcePointer',
      'producerRoleExpectationIndices',
    ]);
    expect(context.path).toBeUndefined();
    expect(readFileSync(f.draftPath)).toEqual(f.beforeDraft);
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(f.beforeTelemetry);
    const evidence = readChatPipelineTrialPlanRejectionEvidence(f.yamlPath, 2, f.attemptId)!;
    expect(JSON.parse(evidence.text).rejectionContext).toEqual(context);
    expect(JSON.parse(evidence.text).message).toBe(relationMessage);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('native coordinate errors preserve counted rejection summaries and attempt fencing', async () => {
  const f = await fixture('anchor');
  try {
    let thrown: unknown;
    try {
      await f.call('commit');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message.startsWith(relationMessage + '\nrejectionContext: ')).toBe(
      true,
    );
    const telemetry = readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2);
    expect(telemetry).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 0,
      validationRejectionCount: 1,
      repeatedValidationRejectionCount: 0,
      attemptIds: [f.attemptId],
      committedPlanHash: null,
    });
    expect(telemetry.rejections).toEqual([
      { fingerprint: sha(relationMessage), count: 1, message: relationMessage },
    ]);
    const evidence = readChatPipelineTrialPlanRejectionEvidence(f.yamlPath, 2, f.attemptId)!;
    expect(evidence.submissionConsumed).toBe(true);
    expect(evidence.toolAttemptCount).toBe(1);
    expect(JSON.parse(evidence.text).message).toBe(relationMessage);
    expect(JSON.parse(evidence.text).rejectionContext.binding.attemptId).toBe(f.attemptId);
    expect(JSON.parse(readFileSync(f.draftPath, 'utf8')).commitAttempted).toBe(true);
    await expect(f.call('commit')).rejects.toThrow('commit was already attempted');
    expect(readChatPipelineTrialPlanToolTelemetry(f.yamlPath, 2)).toEqual(telemetry);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
