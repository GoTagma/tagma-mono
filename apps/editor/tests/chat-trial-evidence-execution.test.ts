import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { WorkspaceState } from '../server/workspace-state';
import { pipelineYamlPath } from '../server/pipeline-paths';
import {
  createChatYamlStage,
  discardChatYamlStageWithDisposition,
  listChatYamlStage,
} from '../server/chat-yaml-staging';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  type ChatPipelineTrialPlan,
  type ChatPipelineTrialExpectation,
} from '../server/chat-pipeline-trial-plan';
import { trialIntentDigest } from '../server/chat-trial-intent-coverage';
import {
  TRIAL_EVIDENCE_KINDS,
  type TrialControlledFault,
} from '../server/chat-trial-resilience-rules';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

for (const kind of [
  'timeout-recovery',
  'failure-recovery',
  'empty-result',
  'unlocated-source',
] as const)
  test(`actual isolated Trial observes ${kind}, preserves inputs and pins intent`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-evidence-trial-'));
    const path = pipelineYamlPath(root, 'flow');
    mkdirSync(dirname(path), { recursive: true });
    const source = 'Original span';
    const marker =
      kind === 'unlocated-source' ? 'Source could not be located.' : 'Audit incomplete';
    const yaml = serializePipeline({
      name: 'Structured evidence',
      tracks: [
        {
          id: 'flow',
          name: 'Flow',
          cwd: '.tagma/flow',
          on_failure: 'ignore',
          tasks: [
            {
              id: 'source',
              name: 'Source',
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  'require("node:fs").writeFileSync("data.json",JSON.stringify([{span:"Original span"}]))',
                ],
              },
              completion: { type: 'file_exists', path: 'data.json' },
            },
            {
              id: 'report',
              name: 'Report',
              depends_on: ['flow.source'],
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  `const fs=require("node:fs");const data=fs.existsSync("data.json")?JSON.parse(fs.readFileSync("data.json","utf8")):[];const src=fs.readFileSync("source.txt","utf8");fs.writeFileSync("report.txt",data.length&&src.includes(data[0].span)?"R1":${JSON.stringify(marker)})`,
                ],
              },
              completion: { type: 'file_exists', path: 'report.txt' },
            },
          ],
        },
      ],
    });
    writeFileSync(path, yaml);
    writeFileSync(
      join(root, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      }),
    );
    const ws = new WorkspaceState(root);
    ws.workDir = root;
    ws.yamlPath = path;
    ws.config = parseYaml(yaml);
    bootstrapBuiltins(ws.registry);
    const stage = createChatYamlStage(ws, { activePath: path });
    const entry = stage.entries.find((item) => item.sourcePath === path)!;
    try {
      const success: ChatPipelineTrialExpectation[] = [
        { type: 'task-status', taskId: 'flow.source', status: 'success' },
        { type: 'task-status', taskId: 'flow.report', status: 'success' },
        { type: 'path-exists', path: 'flow/report.txt' },
      ];
      const native = kind === 'failure-recovery' || kind === 'timeout-recovery';
      const fault: TrialControlledFault =
        kind === 'timeout-recovery'
          ? { type: 'task-timeout', taskId: 'flow.source', timeoutMs: 100 }
          : kind === 'failure-recovery'
            ? { type: 'task-exit', taskId: 'flow.source', exitCode: 7 }
            : {
                type: 'artifact-replace',
                producerTaskId: 'flow.source',
                consumerTaskId: 'flow.report',
                path: 'flow/data.json',
                content: kind === 'empty-result' ? '[]' : '[{"span":"Absent span"}]',
              };
      const observation: ChatPipelineTrialExpectation =
        kind === 'empty-result'
          ? { type: 'json-pointer-equals', path: 'flow/data.json', pointer: '', expectedJson: '[]' }
          : {
              type: 'json-pointer-text-occurrence',
              path: 'flow/data.json',
              pointer: '/0/span',
              sourcePath: 'flow/source.txt',
              present: false,
            };
      const normalObservation: ChatPipelineTrialExpectation =
        kind === 'empty-result'
          ? {
              type: 'json-pointer-equals',
              path: 'flow/data.json',
              pointer: '',
              expectedJson: '[{"span":"Original span"}]',
            }
          : {
              type: 'json-pointer-text-occurrence',
              path: 'flow/data.json',
              pointer: '/0/span',
              sourcePath: 'flow/source.txt',
              present: true,
            };
      const intent = 'Produce useful output through the declared production boundary.';
      const common = {
        runs: 1,
        targetTaskIds: ['flow.report'],
        fixtures: [{ path: 'flow/source.txt', content: source }],
      };
      const plan: ChatPipelineTrialPlan = {
        version: 12,
        yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
        summary: 'Observe typed fault execution.',
        goals: ['Verify boundary behavior.'],
        findings: [],
        coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: 'not-applicable',
          caseIds: [],
          rationale: 'Focused execution mechanism regression.',
        })),
        evidenceReview: {
          version: 1,
          intentDigest: trialIntentDigest(intent),
          decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
            type,
            required: type === kind,
            taskIds: type === kind ? ['flow.report'] : [],
            rationale: 'Reviewed output boundary.',
          })),
        },
        cases: [
          {
            ...common,
            id: 'normal',
            title: 'N',
            objective: 'N',
            expectations: [
              ...success,
              { type: 'file-not-contains', path: 'flow/report.txt', text: marker },
              ...(native ? [] : [normalObservation]),
              { type: 'file-equals', path: 'flow/source.txt', text: source },
            ],
          },
          {
            ...common,
            id: 'fault',
            title: 'F',
            objective: 'F',
            evidence: [
              {
                type: kind,
                normalCaseId: 'normal',
                recoveredTaskId: 'flow.report',
                outcomeExpectationIndices: [3],
                fault,
                ...(native ? {} : { observationExpectationIndex: 4 }),
              },
            ],
            expectations: [
              native
                ? {
                    type: 'task-status',
                    taskId: 'flow.source',
                    status: kind === 'timeout-recovery' ? 'timeout' : 'failed',
                  }
                : success[0]!,
              success[1]!,
              success[2]!,
              { type: 'file-contains', path: 'flow/report.txt', text: marker },
              ...(native ? [] : [observation]),
              { type: 'file-equals', path: 'flow/source.txt', text: source },
            ],
          },
        ],
      };
      writeFileSync(entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'), JSON.stringify(plan));
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
      const input = {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trustedOperationV2: true,
        intentText: intent,
      };
      const result = await trialRunChatYamlStage(ws, { ...input, trialId: 'first' });
      expect(result.summary).not.toContain('plan required');
      expect(result.success).toBe(true);
      expect(result.cases?.map((item) => item.success)).toEqual([true, true]);
      expect(result.cases?.[1]?.expectations).toContainEqual(
        expect.objectContaining({ type: 'controlled-fault-evidence', passed: true }),
      );
      expect(listChatYamlStage(ws, stage.id, true).trialEvidenceContract?.required).toEqual([kind]);
      expect(readFileSync(path, 'utf8')).toBe(yaml);
      expect(readFileSync(entry.stagedPath, 'utf8')).toBe(yaml);
      const second = await trialRunChatYamlStage(ws, { ...input, trialId: 'fresh' });
      expect(second.success).toBe(true);
      expect(second.cases?.[1]?.runIds[0]).not.toBe(result.cases?.[1]?.runIds[0]);
      expect(second.cases?.[1]?.expectations).toContainEqual(
        expect.objectContaining({ type: 'controlled-fault-evidence', passed: true }),
      );
      plan.evidenceReview = {
        ...plan.evidenceReview!,
        decisions: plan.evidenceReview!.decisions.map((item) => ({
          ...item,
          required: false,
          taskIds: [],
        })),
      };
      writeFileSync(entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'), JSON.stringify(plan));
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
      const dropped = await trialRunChatYamlStage(ws, { ...input, trialId: 'changed-review' });
      expect(dropped.ran).toBe(false);
      expect(dropped.success).toBe(false);
      expect(dropped.summary).toContain('cannot drop');
      expect(dropped.repairAuthorization).toBe('diagnostic-only');
      expect(listChatYamlStage(ws, stage.id, true).trialEvidenceContract?.required).toEqual([kind]);
    } finally {
      discardChatYamlStageWithDisposition(ws, stage.id, true);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
      await disposeTrialWitnessWorker(ws);
      rmSync(root, { recursive: true, force: true });
    }
  });
