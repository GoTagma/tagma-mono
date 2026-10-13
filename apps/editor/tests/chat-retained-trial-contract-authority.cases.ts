import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cleanupOwnedFixtureConstructionRoots,
  frozenIntent,
  realEngineFixture,
  type FixtureNegativeOptions,
} from './chat-retained-trial-contract.fixture.js';
export type NegativeFixture = Awaited<ReturnType<typeof realEngineFixture>>;
/** Bind to the candidate's normal authenticated readers after it is sealed/installed. */
export interface AuthorityInspection {
  baselinePresent: boolean;
  verified: boolean;
  phase: string | null;
}
export type InspectCandidateAuthority = (value: NegativeFixture) => Promise<AuthorityInspection>;
export const retainedContractAuthorityEvidence: Record<string, unknown>[] = [];
export function registerRetainedPlanAuthorityNegatives(
  inspectCandidateAuthority: InspectCandidateAuthority,
) {
  const modes = [
    'support-bytes',
    'old-plan-bytes',
    'frozen-intent',
    'foreign-generation',
    'blocked-core',
  ] as const;
  for (const mode of modes)
    test(`Host retained contract refuses ${mode} without a verified receipt or publication`, async () => {
      let value: NegativeFixture | undefined;
      let afterRepairApplied = false;
      const options: {
        afterOwnedRepair?: FixtureNegativeOptions['afterOwnedRepair'];
        mutateVerificationAfterRepair?: FixtureNegativeOptions['mutateVerificationAfterRepair'];
        transformPlanPayload?: FixtureNegativeOptions['transformPlanPayload'];
      } = {};
      if (mode === 'support-bytes')
        options.afterOwnedRepair = async ({ targetPath }) => {
          const support = join(dirname(targetPath), 'support.txt');
          const old = readFileSync(support, 'utf8');
          writeFileSync(support, old + 'changed supporting byte\n');
          expect(readFileSync(support, 'utf8')).not.toBe(old);
          afterRepairApplied = true;
        };
      if (mode === 'old-plan-bytes')
        options.afterOwnedRepair = async ({ targetPath, committedPlanBytes }) => {
          const path = targetPath.replace(/\.yaml$/, '.trial-plan.json');
          const plan = JSON.parse(committedPlanBytes);
          plan.summary += ' Altered after genuine failed Trial.';
          writeFileSync(path, JSON.stringify(plan, null, 2) + '\n');
          expect(readFileSync(path, 'utf8')).not.toBe(committedPlanBytes);
          afterRepairApplied = true;
        };
      if (mode === 'frozen-intent')
        options.mutateVerificationAfterRepair = (input) => ({
          ...input,
          intentText: frozenIntent + ' A different frozen intent.',
        });
      if (mode === 'foreign-generation')
        options.mutateVerificationAfterRepair = (input) => ({
          ...input,
          operationGeneration: input.operationGeneration + 1,
        });
      if (mode === 'blocked-core')
        options.transformPlanPayload = (payload) => ({
          ...payload,
          evidence_review: {
            ...payload.evidence_review,
            coreWitness: {
              status: 'blocked',
              code: 'isolated-core-not-witnessed',
              taskIds: ['main.observe'],
              rationale:
                'This negative committed contract explicitly has no authorized positive core witness.',
            },
          },
          findings: [
            {
              severity: 'blocking',
              repairScope: 'diagnostic-only',
              summary: 'Blocked retained core',
              evidence:
                'The negative contract deliberately retains an unavailable concrete core witness; no positive authority is granted.',
            },
          ],
        });
      try {
        value = await realEngineFixture('retained-repair', options);
        let dispatch: Awaited<ReturnType<NegativeFixture['engine']['dispatch']>> | undefined;
        let ownerRejected = false;
        try {
          dispatch = await value.engine.dispatch(value.dispatchInput());
        } catch (error) {
          if (mode !== 'foreign-generation') throw error;
          expect(error).toMatchObject({
            name: 'ChatOperationV2AuthoringProtocolError',
            code: 'authority_mismatch',
            message: 'Verification does not own this stage.',
          });
          ownerRejected = true;
        }
        expect(
          value.openCode.incomingRequests.filter(({ purpose }) => purpose === 'trial_plan'),
        ).toHaveLength(2);
        expect(value.commitToolResult).toBeDefined();
        if (mode === 'foreign-generation') expect(ownerRejected).toBe(true);
        else expect(dispatch!.kind).not.toBe('commit_preparing');
        const inspection = await inspectCandidateAuthority(value);
        expect(inspection.verified).toBe(false);
        retainedContractAuthorityEvidence.push({
          mode,
          dispatch: dispatch?.kind ?? 'exact_owner_rejection',
          inspection,
          purposes: value.openCode.incomingRequests.map(({ purpose }) => purpose),
          trials: value.trials.map(({ result }) => result),
          verificationFaults: value.verificationFaults,
          mutationObservations: value.mutationObservations,
        });
        if (mode === 'blocked-core') {
          expect(JSON.parse(value.committedPlanBytes).evidenceReview.coreWitness.status).toBe(
            'blocked',
          );
          expect(JSON.parse(value.committedPlanBytes).findings).toEqual([
            expect.objectContaining({ severity: 'blocking', repairScope: 'diagnostic-only' }),
          ]);
          expect(
            value.openCode.incomingRequests.filter(({ purpose }) => purpose === 'repair'),
          ).toHaveLength(0);
          expect(value.trials.every(({ result }) => !result.ran)).toBe(true);
          expect(inspection.baselinePresent).toBe(false);
        } else {
          expect(
            value.openCode.incomingRequests.filter(({ purpose }) => purpose === 'repair'),
          ).toHaveLength(1);
          expect(value.store.getOperation('operation-1')).toMatchObject({
            repairAttempts: 1,
            repairMaxAttempts: 2,
          });
          expect(value.trials.filter(({ result }) => result.ran)).toHaveLength(1);
          expect(value.trials.find(({ result }) => result.ran)!.result).toMatchObject({
            success: false,
            kind: 'failed',
            repairAuthorization: 'pipeline-change-allowed',
          });
          expect(inspection.baselinePresent).toBe(true);
          if (mode === 'support-bytes' || mode === 'old-plan-bytes')
            expect(afterRepairApplied).toBe(true);
          if (mode === 'frozen-intent' || mode === 'foreign-generation')
            expect(
              value.mutationObservations.some((item) => item.kind === 'typed-verification-input'),
            ).toBe(true);
        }
        expect(value.store.listCommitWal('scope-1')).toHaveLength(0);
        expect(await value.coordinator.resumePending()).toEqual([]);
        expect(value.store.getResultProjection('operation-1')?.terminalOutcome).not.toBe(
          'completed_published',
        );
        expect(existsSync(join(value.workspaceRoot, '.tagma/alpha/alpha.yaml'))).toBe(false);
      } finally {
        if (value) await value.dispose();
        cleanupOwnedFixtureConstructionRoots();
      }
    }, 120_000);
}
