import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChatPipelineTrialPlan } from './chat-pipeline-trial-plan.js';
import type { PipelineConfig } from '@tagma/sdk';
import { buildDag } from '@tagma/sdk/config';
import {
  buildTrialPlanPathCoordinateContext,
  createTrialPathCoordinateRules,
} from './chat-trial-path-coordinate-rules.js';
import {
  createTrialResilienceRules,
  type ExplicitResilienceObligation,
  type TrialPlanValidationContext,
  type TrialResilienceTaskEvidence,
} from './chat-trial-resilience-rules.js';
export type {
  ExplicitResilienceObligation,
  TrialPlanValidationContext,
} from './chat-trial-resilience-rules.js';
const rules = createTrialResilienceRules();
const coordinateRules = createTrialPathCoordinateRules();
export const parseTrialEvidenceReview = rules.parseReview;
export const parseTrialCaseEvidence = rules.parseCaseEvidence;
export function trialIntentDigest(intentText: string): string {
  return createHash('sha256').update(intentText, 'utf8').digest('hex');
}
export function parseTrialPlanValidationContext(value: unknown): TrialPlanValidationContext {
  const context = rules.parseValidationContext(value);
  if (context.pathCoordinates !== undefined) coordinateRules.parseContext(context.pathCoordinates);
  return context;
}
export function buildTrialPlanValidationContext(
  pipelineConfig: PipelineConfig,
  obligations: readonly ExplicitResilienceObligation[],
  coordinates?: { readonly relativeYamlPath: string; readonly workDir: string },
  intentDigest?: string,
): TrialPlanValidationContext {
  const tasks: Record<string, TrialResilienceTaskEvidence[string]> = {};
  for (const [id, node] of buildDag(pipelineConfig).nodes) {
    const track = node.track;
    const completion = node.task.completion as { type?: string; path?: string } | undefined;
    const artifactPaths: string[] = [];
    if (coordinates && completion?.type === 'file_exists' && typeof completion.path === 'string') {
      const path = relative(
        coordinates.workDir,
        resolve(coordinates.workDir, node.task.cwd ?? track?.cwd ?? '.', completion.path),
      ).replace(/\\/g, '/');
      if (path && !path.startsWith('../') && !isAbsolute(path))
        artifactPaths.push(path.startsWith('.tagma/') ? path.slice(7) : path);
    }
    tasks[id] = {
      kind: node.task.command !== undefined ? 'command' : 'prompt',
      onFailure: track?.on_failure ?? 'skip_downstream',
      artifactPaths,
      dependsOn: [...node.dependsOn],
    };
  }
  const context = {
    version: 2 as const,
    obligations: [...obligations],
    tasks,
    ...(coordinates
      ? {
          pathCoordinates: buildTrialPlanPathCoordinateContext(
            pipelineConfig,
            coordinates.relativeYamlPath,
            coordinates.workDir,
          ),
        }
      : {}),
    ...(intentDigest ? { intentDigest } : {}),
  };
  return parseTrialPlanValidationContext(context);
}
export function requiredTrialEvidence(
  plan: ChatPipelineTrialPlan,
  expectedIntentDigest?: string,
  pinned: readonly ExplicitResilienceObligation[] = [],
): ExplicitResilienceObligation[] {
  if (!plan.evidenceReview) {
    if (expectedIntentDigest || pinned.length)
      throw new Error(
        'A structured evidenceReview of every registered behavior is required; use the Host-issued intent digest. No behavior is inferred from request keywords.',
      );
    return [];
  }
  const review = rules.parseReview(plan.evidenceReview);
  if (expectedIntentDigest && review.intentDigest !== expectedIntentDigest)
    throw new Error('Evidence review does not match the frozen Host intent digest.');
  const required = review.decisions.filter((item) => item.required).map((item) => item.type);
  if (pinned.some((kind) => !required.includes(kind)))
    throw new Error(
      'Evidence review cannot drop a Host-pinned requirement after a pipeline revision.',
    );
  return required;
}
export function inspectTrialEvidence(
  obligations: readonly ExplicitResilienceObligation[],
  plan: ChatPipelineTrialPlan,
  pipelineConfig?: PipelineConfig,
  coordinates?: { relativeYamlPath: string; workDir: string },
) {
  return rules.inspectEvidence(
    obligations,
    plan,
    pipelineConfig
      ? buildTrialPlanValidationContext(pipelineConfig, obligations, coordinates).tasks
      : undefined,
  );
}
export function missingExplicitResilienceEvidence(
  obligations: readonly ExplicitResilienceObligation[],
  plan: ChatPipelineTrialPlan,
  pipelineConfig?: PipelineConfig,
): ExplicitResilienceObligation[] {
  return inspectTrialEvidence(obligations, plan, pipelineConfig).missing;
}
