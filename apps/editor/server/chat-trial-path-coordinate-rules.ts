import { dirname, resolve } from 'node:path';
import type { PipelineConfig } from '@tagma/sdk';
import type { ChatPipelineTrialPlan } from './chat-pipeline-trial-plan.js';
import { sameFilesystemPathCoordinate } from '../shared/filesystem-paths.js';

export interface TrialPlanPathCoordinateContext {
  readonly namespace: string;
  readonly taskLocalPaths: readonly {
    readonly path: string;
    readonly cwd: string;
    readonly descendants: boolean;
  }[];
}

/** Serialized into the planner so precommit and authoritative Host checks agree. */
export function createTrialPathCoordinateRules() {
  function normalize(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  }

  function parseContext(value: unknown): TrialPlanPathCoordinateContext {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Trial Plan path coordinate context is invalid.');
    }
    const raw = value as TrialPlanPathCoordinateContext;
    if (
      typeof raw.namespace !== 'string' ||
      !Array.isArray(raw.taskLocalPaths) ||
      raw.taskLocalPaths.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          typeof item.path !== 'string' ||
          typeof item.cwd !== 'string' ||
          typeof item.descendants !== 'boolean',
      )
    ) {
      throw new Error('Trial Plan path coordinate context is invalid.');
    }
    return raw;
  }

  function validate(plan: ChatPipelineTrialPlan, context: TrialPlanPathCoordinateContext): void {
    const namespace = normalize(context.namespace);
    if (!namespace || namespace === '.') return;
    for (const [caseIndex, testCase] of plan.cases.entries()) {
      const paths = [
        ...testCase.fixtures.map((fixture, index) => ({
          label: `cases[${caseIndex}].fixtures[${index}].path`,
          path: fixture.path,
        })),
        ...testCase.expectations.flatMap((expectation, index) => [
          ...('path' in expectation
            ? [{ label: `cases[${caseIndex}].expectations[${index}].path`, path: expectation.path }]
            : []),
          ...('sourcePath' in expectation
            ? [
                {
                  label: `cases[${caseIndex}].expectations[${index}].sourcePath`,
                  path: expectation.sourcePath,
                },
              ]
            : []),
        ]),
        ...(testCase.generatedInputPaths ?? []).map((path, index) => ({
          label: `cases[${caseIndex}].generatedInputPaths[${index}]`,
          path,
        })),
        ...(testCase.evidence ?? []).flatMap((item, index) =>
          item.type !== 'source-preservation' && item.fault.type === 'artifact-replace'
            ? [
                {
                  label: `cases[${caseIndex}].evidence[${index}].fault.path`,
                  path: item.fault.path,
                },
              ]
            : [],
        ),
      ];
      for (const item of paths) {
        const path = normalize(item.path);
        if (path === namespace || path.startsWith(`${namespace}/`)) continue;
        const matches = context.taskLocalPaths.filter(
          (candidate) =>
            path === candidate.path ||
            (candidate.descendants && path.startsWith(`${candidate.path}/`)),
        );
        if (matches.some((candidate) => candidate.cwd === '.')) continue;
        const match = matches.find(
          (candidate) => candidate.cwd.toLowerCase() === `.tagma/${namespace}`.toLowerCase(),
        );
        if (!match) continue;
        throw new Error(
          `${item.label} (${item.path}) uses a task-local path from effective cwd ${match.cwd}, ` +
            `but Trial paths are relative to the isolated case root. Use ${namespace}/${path}.`,
        );
      }
    }
  }
  return { normalize, parseContext, validate };
}

const rules = createTrialPathCoordinateRules();

export function buildTrialPlanPathCoordinateContext(
  pipelineConfig: PipelineConfig,
  relativeYamlPath: string,
  workDir: string,
): TrialPlanPathCoordinateContext {
  const namespace = rules.normalize(dirname(relativeYamlPath));
  const taskLocalPaths: Array<{ path: string; cwd: string; descendants: boolean }> = [];
  if (!namespace || namespace === '.') return { namespace, taskLocalPaths };
  const rootCwd = resolve(workDir);
  const pipelineCwd = resolve(workDir, '.tagma', ...namespace.split('/'));
  const add = (value: unknown, cwd: string, descendants = false): void => {
    if (typeof value !== 'string') return;
    const path = rules.normalize(value);
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('../'))
      return;
    taskLocalPaths.push({ path, cwd, descendants });
  };
  for (const track of pipelineConfig.tracks) {
    for (const task of track.tasks) {
      const resolvedCwd = resolve(workDir, task.cwd ?? track.cwd ?? '.');
      const cwd = sameFilesystemPathCoordinate(resolvedCwd, rootCwd)
        ? '.'
        : sameFilesystemPathCoordinate(resolvedCwd, pipelineCwd)
          ? `.tagma/${namespace}`
          : null;
      if (cwd === null) continue;
      const trigger = task.trigger as { type?: unknown; path?: unknown } | undefined;
      add(trigger?.path, cwd, trigger?.type === 'directory');
      const completion = task.completion as { path?: unknown } | undefined;
      add(completion?.path, cwd);
      for (const middleware of task.middlewares ?? track.middlewares ?? []) {
        const record = middleware as { type?: unknown; file?: unknown };
        if (record.type === 'static_context') add(record.file, cwd);
      }
      for (const binding of Object.values(task.inputs ?? {})) {
        const record = binding as { value?: unknown; default?: unknown };
        for (const value of [record.value, record.default]) {
          if (typeof value !== 'string' || !(/[\\/]/.test(value) || /\.[A-Za-z0-9]+$/.test(value)))
            continue;
          add(value, cwd);
        }
      }
    }
  }
  return { namespace, taskLocalPaths };
}
