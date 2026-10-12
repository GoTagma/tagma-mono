import type {
  ChatPipelineTrialPlan,
  ChatPipelineTrialPlanCase,
  ChatPipelineTrialPlanRequest,
} from './chat-pipeline-trial-plan.js';

interface TrialFixtureSetupDependencies {
  readonly createHash: typeof import('node:crypto').createHash;
  readonly dirname: typeof import('node:path').dirname;
  readonly join: typeof import('node:path').join;
  readonly lstatSync: typeof import('node:fs').lstatSync;
  readonly readFileSync: typeof import('node:fs').readFileSync;
}

/**
 * Serialize this whole factory into the managed tool. Its injected dependencies
 * and every rule binding stay inside that boundary when a bundler renames them.
 */
export function createTrialFixtureSetupRules({
  createHash,
  dirname,
  join,
  lstatSync,
  readFileSync,
}: TrialFixtureSetupDependencies) {
  class TrialPlanFixtureSetupError extends Error {
    constructor(
      message: string,
      readonly affectedCases: NonNullable<ChatPipelineTrialPlanRequest['affectedCases']>,
    ) {
      super(message);
    }
  }

  function caseExecutionHash(testCase: ChatPipelineTrialPlanCase): string {
    const { title: _title, objective: _objective, ...execution } = testCase;
    return createHash('sha256').update(JSON.stringify(execution)).digest('hex');
  }

  function validateFixtureSetup(
    plan: ChatPipelineTrialPlan,
    stagedYamlPath: string,
    relativeYamlPath: string,
  ): void {
    const namespace = dirname(relativeYamlPath).replace(/\\/g, '/');
    const fingerprint = (content: string | Uint8Array | null): string | null =>
      content === null ? null : createHash('sha256').update(content).digest('hex');
    const base = new Map<string, string | null>();
    const readBase = (path: string): string | null => {
      if (base.has(path)) return base.get(path)!;
      let value: string | null = null;
      if (path.startsWith(`${namespace}/`)) {
        const suffix = path.slice(namespace.length + 1);
        let current = dirname(stagedYamlPath);
        for (const segment of suffix.split('/')) {
          current = join(current, segment);
          try {
            if (lstatSync(current).isSymbolicLink())
              throw new Error('Trial fixtures must not address symlinks.');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              base.set(path, null);
              return null;
            }
            throw error;
          }
        }
        if (!lstatSync(current).isFile())
          throw new Error('Trial file fixtures must address regular files.');
        value = fingerprint(readFileSync(current));
      }
      base.set(path, value);
      return value;
    };
    for (const negative of plan.cases) {
      if (
        negative.baselineCaseId ||
        negative.evidence?.some((item) => item.type !== 'source-preservation') ||
        (negative.environment?.length ?? 0) > 0 ||
        (negative.deniedManualTaskIds?.length ?? 0) > 0
      )
        continue;
      for (const positive of plan.cases) {
        if (
          positive === negative ||
          positive.baselineCaseId ||
          positive.evidence?.some((item) => item.type !== 'source-preservation') ||
          (positive.environment?.length ?? 0) > 0 ||
          JSON.stringify([...positive.targetTaskIds].sort()) !==
            JSON.stringify([...negative.targetTaskIds].sort())
        )
          continue;
        const contradictsSuccess = negative.expectations.some(
          (item) =>
            item.type === 'task-status' &&
            item.status !== 'success' &&
            positive.expectations.some(
              (other) =>
                other.type === 'task-status' &&
                other.taskId === item.taskId &&
                other.status === 'success',
            ),
        );
        if (!contradictsSuccess) continue;
        const left = new Map(
          positive.fixtures.map((item) => [item.path, fingerprint(item.content)]),
        );
        const right = new Map(
          negative.fixtures.map((item) => [item.path, fingerprint(item.content)]),
        );
        const omittedPaths = [...left.keys()].filter((path) => !right.has(path));
        if (omittedPaths.length > 0) {
          throw new TrialPlanFixtureSetupError(
            `Case ${negative.id} omits a file input controlled by positive case ${positive.id}. Omission keeps the staged file; it does not construct absence. Explicitly fixture the negative input (content: null for missing, a string for present bytes) before testing a contradictory task outcome. Correct the plan, not the pipeline.`,
            [
              {
                caseId: negative.id,
                failedExpectationTypes: ['task-status'],
                originalCaseHash: caseExecutionHash(negative),
                ...(omittedPaths.length === 1
                  ? { requiredFixture: { path: omittedPaths[0]!, content: null } }
                  : {}),
              },
            ],
          );
        }
        const paths = new Set([...left.keys(), ...right.keys()]);
        if (
          [...paths].every(
            (path) =>
              (left.has(path) ? left.get(path) : readBase(path)) ===
              (right.has(path) ? right.get(path) : readBase(path)),
          )
        ) {
          throw new TrialPlanFixtureSetupError(
            `Case ${negative.id} expects a different task outcome from ${positive.id} with the same effective file inputs and targets. fixtures: [] retains copied support files. Correct the plan's setup; use content: null to remove a required file and assert path-not-exists. Do not repair the pipeline to satisfy an unchanged negative setup.`,
            [
              {
                caseId: negative.id,
                failedExpectationTypes: ['task-status'],
                originalCaseHash: caseExecutionHash(negative),
              },
            ],
          );
        }
      }
    }
  }

  return { FixtureSetupError: TrialPlanFixtureSetupError, caseExecutionHash, validateFixtureSetup };
}
