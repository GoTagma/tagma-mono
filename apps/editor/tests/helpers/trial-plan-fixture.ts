import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export function writeAuthenticatedTrialPlanTelemetry(
  stagedPath: string,
  toolAttemptCount = 1,
  successfulWriteCount = 1,
): void {
  if (
    !Number.isInteger(toolAttemptCount) ||
    !Number.isInteger(successfulWriteCount) ||
    toolAttemptCount < 0 ||
    successfulWriteCount < 0 ||
    successfulWriteCount > toolAttemptCount
  ) {
    throw new Error('Trial plan fixture telemetry counters are invalid.');
  }
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf8')).digest('hex');
  const agentTagmaDir = dirname(dirname(stagedPath));
  const relativeYamlPath = relative(agentTagmaDir, stagedPath).replace(/\\/g, '/');
  const stageRoot = dirname(dirname(agentTagmaDir));
  const key = createHash('sha256')
    .update(relativeYamlPath + String.fromCharCode(0) + yamlHash)
    .digest('hex');
  const telemetryDir = join(stageRoot, '.trial-plan-telemetry');
  const validationRejectionCount = toolAttemptCount - successfulWriteCount;
  const planPath = stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
  const committedPlanHash =
    successfulWriteCount > 0
      ? createHash('sha256').update(readFileSync(planPath, 'utf8')).digest('hex')
      : null;
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(
    join(telemetryDir, `${key}.json`),
    JSON.stringify({
      version: 2,
      yamlHash,
      relativeYamlPath,
      attemptIds: Array.from(
        { length: toolAttemptCount },
        (_, index) => `fixture-attempt-${index + 1}`,
      ),
      toolAttemptCount,
      validationRejectionCount,
      repeatedValidationRejectionCount: Math.max(0, validationRejectionCount - 1),
      successfulWriteCount,
      committedPlanHash,
      firstAttemptAt: toolAttemptCount === 0 ? null : 100,
      lastAttemptAt: toolAttemptCount === 0 ? null : 100 + toolAttemptCount * 75,
      rejections:
        validationRejectionCount === 0
          ? []
          : [
              {
                fingerprint: 'a'.repeat(64),
                count: validationRejectionCount,
                message: 'invalid plan',
              },
            ],
    }),
    'utf8',
  );
}
