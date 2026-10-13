import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAuthenticatedServerRecordSync } from '../server/server-record-auth.js';
import {
  readChatYamlStageRetainedContractSource,
  readChatYamlStageVerifiedRetainedTrialReceipt,
} from '../server/chat-yaml-staging.js';
import { pipelineLayoutPath, pipelineRequirementsPath } from '../server/pipeline-paths.js';
import { pipelineTrialPlanPath } from '../server/chat-pipeline-trial-plan.js';
import {
  cleanupOwnedFixtureConstructionRoots,
  realEngineFixture,
} from './chat-retained-trial-contract.fixture.js';
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
export const retainedContractInactiveLeafEvidence: Record<string, unknown>[] = [];
for (const kind of ['layout', 'requirements', 'plan'] as const)
  test(`Host retained full-stage contract refuses inactive ${kind} absence becoming a dangling symlink`, async () => {
    let value: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
    let leaf = '';
    let baselineHash = '';
    let stageRoot = '';
    let stageId = '';
    let baselineEntries = 0;
    try {
      value = await realEngineFixture('retained-repair', {
        seedInactivePipeline: true,
        afterOwnedRepair: async ({ workspace, stageDescriptor }) => {
          stageRoot = stageDescriptor.rootDir;
          stageId = stageDescriptor.id;
          const inactive = stageDescriptor.entries.find(
            (entry) => entry.relativePath === 'beta/beta.yaml',
          );
          expect(inactive).toBeDefined();
          const record = readAuthenticatedServerRecordSync<{
            version: number;
            state: string;
            baselineHash: string;
            baseline: {
              beforeSource: {
                entries: Array<{
                  relativePath: string;
                  yamlHash: string;
                  layoutHash: string | null;
                  requirementsHash: string | null;
                  planHash: string | null;
                }>;
              };
            };
          }>(join(stageRoot, 'retained-trial-contract.json'), {
            workspaceTagmaDir: join(workspace.workDir!, '.tagma'),
            controlRoot: stageRoot,
            stageId,
            kind: 'stage-metadata',
          });
          expect(record).toMatchObject({ version: 1, state: 'captured' });
          baselineHash = record.baselineHash;
          expect(baselineHash).toMatch(/^[0-9a-f]{64}$/);
          baselineEntries = record.baseline.beforeSource.entries.length;
          expect(baselineEntries).toBe(2);
          const original = record.baseline.beforeSource.entries.find(
            (entry) => entry.relativePath === 'beta/beta.yaml',
          );
          expect(original).toMatchObject({
            yamlHash: sha1(readFileSync(inactive!.stagedPath, 'utf8')),
            layoutHash: null,
            requirementsHash: null,
            planHash: null,
          });
          leaf =
            kind === 'layout'
              ? pipelineLayoutPath(inactive!.stagedPath)
              : kind === 'requirements'
                ? pipelineRequirementsPath(inactive!.stagedPath)
                : pipelineTrialPlanPath(inactive!.stagedPath);
          expect(existsSync(leaf)).toBe(false);
          expect(() => lstatSync(leaf)).toThrow();
          const target = join(dirname(leaf), `never-created-${kind}-target`);
          expect(existsSync(target)).toBe(false);
          symlinkSync(target, leaf, 'file');
          expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
          expect(existsSync(leaf)).toBe(false);
        },
      });
      const dispatch = await value.engine.dispatch(value.dispatchInput());
      expect(value.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
        'authoring',
        'trial_plan',
        'trial_plan',
        'repair',
      ]);
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 1,
        repairMaxAttempts: 2,
      });
      expect(leaf).not.toBe('');
      expect(baselineEntries).toBe(2);
      expect(() =>
        readChatYamlStageRetainedContractSource(value!.workspace, stageId, 'alpha/alpha.yaml'),
      ).toThrow('Retained Trial source must be a bounded private regular file.');
      expect(dispatch.kind).not.toBe('commit_preparing');
      const verified = readChatYamlStageVerifiedRetainedTrialReceipt(value.workspace, {
        stageId,
        relativePath: 'alpha/alpha.yaml',
      });
      expect(verified).toBeNull();
      expect(value.trials.filter(({ result }) => result.ran)).toHaveLength(1);
      expect(value.trials.find(({ result }) => result.ran)!.result).toMatchObject({
        success: false,
        kind: 'failed',
      });
      expect(value.store.listCommitWal('scope-1')).toHaveLength(0);
      expect(await value.coordinator.resumePending()).toEqual([]);
      expect(existsSync(join(value.workspaceRoot, '.tagma/alpha/alpha.yaml'))).toBe(false);
      retainedContractInactiveLeafEvidence.push({
        kind,
        dispatch: dispatch.kind,
        baselineEntries,
        baselineHash,
        stageId,
        leafWasAbsent: true,
        leafIsDanglingSymlink: lstatSync(leaf).isSymbolicLink() && !existsSync(leaf),
        verified: false,
        trials: value.trials.map(({ result }) => result),
        verificationFaults: value.verificationFaults,
      });
    } finally {
      if (value) await value.dispose();
      cleanupOwnedFixtureConstructionRoots();
    }
  }, 120_000);
