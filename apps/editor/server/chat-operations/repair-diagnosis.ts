import { createHash } from 'node:crypto';
import {
  isChatRepairDiagnosis,
  isChatRepairExecutionContext,
  isChatRepairRelativePath,
  fitChatRepairDiagnosis,
  type ChatRepairDiagnosis,
} from '../../shared/chat-repair-diagnosis';
import type { ChatPipelineTrialRunResult } from '../chat-pipeline-trial-run';

export function buildChatRepairDiagnosis(
  trial: ChatPipelineTrialRunResult,
  repairAttempt: number,
): ChatRepairDiagnosis | undefined {
  if (!trial.ran || trial.repairAuthorization !== 'pipeline-change-allowed') return undefined;
  const passedCases = new Set(
    (trial.cases ?? []).filter((item) => item.success).map((item) => item.id),
  );
  const failures = (trial.tasks ?? []).filter(
    (task) =>
      task.repairScope === 'pipeline-artifact' &&
      task.status === 'failed' &&
      (task.caseId === null || !passedCases.has(task.caseId)),
  );
  if (failures.length === 0) return undefined;
  const tasks = failures.slice(0, 8).map((task) => {
    const execution = isChatRepairExecutionContext(task.executionContext)
      ? task.executionContext
      : null;
    return {
      taskId: task.taskId,
      status: task.status,
      failureKind: task.failureKind,
      exitCode: task.exitCode,
      effectiveCwd: execution?.effectiveCwd ?? null,
      completionType: execution?.completion?.type ?? null,
      completionPath: execution?.completion?.resolvedPath ?? null,
      completionRegularFile: execution?.completion?.regularFile ?? null,
    };
  });
  const cases = (trial.cases ?? []).filter((item) => !item.success);
  const expectations = cases.flatMap((item) =>
    (item.expectations ?? []).filter(
      (item) => !item.passed && item.repairScope === 'pipeline-artifact',
    ),
  );
  const failedExpectationTypes = [...new Set(expectations.map((item) => item.type))].sort();
  const files = cases.flatMap((item) =>
    (item.expectations ?? []).flatMap((expectation) =>
      expectation.fileObservation && isChatRepairRelativePath(expectation.fileObservation.path)
        ? [expectation.fileObservation]
        : [],
    ),
  );
  const observedFiles = [
    ...new Map(files.map((file) => [JSON.stringify(file), file])).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const signature = JSON.stringify({
    tasks: [...tasks].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    expectations: expectations
      .map((item) => ({ type: item.type, detail: item.detail }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    successfulTasks: (trial.tasks ?? [])
      .filter(
        (task) =>
          task.status === 'success' && (task.caseId === null || !passedCases.has(task.caseId)),
      )
      .map((task) => task.taskId)
      .sort(),
    files: observedFiles,
  });
  const diagnosis: ChatRepairDiagnosis = {
    schemaVersion: 1,
    failureSignature: createHash('sha256').update(signature).digest('hex'),
    repairAttempt,
    consecutiveFailures: 1,
    complete:
      failures.length <= 8 &&
      observedFiles.length <= 8 &&
      observedFiles.every((file) => file.regularFile !== null) &&
      (trial.omittedTaskCount ?? 0) === 0 &&
      (trial.notRunCaseCount ?? 0) === 0 &&
      tasks.every(
        (task) =>
          task.effectiveCwd !== null &&
          (task.failureKind !== 'completion_failed' ||
            (task.completionType === 'file_exists' &&
              task.completionPath !== null &&
              task.completionRegularFile !== null)),
      ),
    tasks,
    failedExpectationTypes,
    files: observedFiles.slice(0, 8),
    omittedTaskCount: Math.max(0, failures.length - tasks.length) + (trial.omittedTaskCount ?? 0),
    omittedFileCount: Math.max(0, observedFiles.length - 8),
  };
  return fitChatRepairDiagnosis(diagnosis, 2048) ?? undefined;
}

export function advanceChatRepairDiagnosis(
  current: ChatRepairDiagnosis,
  previous: unknown,
): ChatRepairDiagnosis {
  if (
    !isChatRepairDiagnosis(previous) ||
    !previous.complete ||
    !current.complete ||
    previous.failureSignature !== current.failureSignature ||
    current.repairAttempt !== previous.repairAttempt + 1
  )
    return current;
  return { ...current, consecutiveFailures: previous.consecutiveFailures + 1 };
}
