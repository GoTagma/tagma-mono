import type { RunContext } from './run-context';
import type { TaskWaitReason } from '../types';
import { isTerminal, skippedTaskResult } from './run-state';
import { nowISO } from '../utils';

/**
 * Return waiting tasks whose dependency states are terminal and which are not
 * already in flight. The caller owns actually launching them.
 */
export function findLaunchableTasks(
  ctx: RunContext,
  runningTaskIds: ReadonlySet<string>,
): string[] {
  const launchable: string[] = [];
  for (const id of ctx.dag.sorted) {
    const state = ctx.states.get(id);
    if (!state) continue;
    if (state.status !== 'waiting' || runningTaskIds.has(id)) continue;
    const node = ctx.dag.nodes.get(id)!;
    const allDepsTerminal =
      node.dependsOn.length === 0 ||
      node.dependsOn.every((depId) => isTerminal(ctx.states.get(depId)!.status));
    if (allDepsTerminal) launchable.push(id);
  }
  return launchable;
}

export function dependencyWaitReason(ctx: RunContext, taskId: string): TaskWaitReason | null {
  const node = ctx.dag.nodes.get(taskId);
  if (!node) return null;
  const taskIds = node.dependsOn.filter((depId) => {
    const dependency = ctx.states.get(depId);
    return dependency !== undefined && !isTerminal(dependency.status);
  });
  return taskIds.length > 0 ? { kind: 'dependencies', taskIds } : null;
}

/** Refresh only tasks not already executing (including trigger watchers). */
export function refreshDependencyWaitReasons(
  ctx: RunContext,
  runningTaskIds: ReadonlySet<string>,
): void {
  for (const taskId of ctx.dag.sorted) {
    const state = ctx.states.get(taskId);
    if (!state || state.status !== 'waiting' || runningTaskIds.has(taskId)) continue;
    ctx.setTaskWaitReason(taskId, dependencyWaitReason(ctx, taskId));
  }
}

export function allTasksTerminal(ctx: RunContext): boolean {
  return [...ctx.states.values()].every((state) => isTerminal(state.status));
}

/**
 * Abort cleanup helper: after in-flight tasks settle, any remaining
 * non-terminal tasks are waiting/idle tasks that were never started.
 */
export function skipNonTerminalTasks(ctx: RunContext, finishedAt = nowISO()): void {
  for (const [id, state] of ctx.states) {
    if (isTerminal(state.status)) continue;
    state.finishedAt = finishedAt;
    state.result = skippedTaskResult('skipped because the pipeline ended before this task started');
    ctx.setTaskStatus(id, 'skipped');
  }
}
