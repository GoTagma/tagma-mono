import type { RunContext } from './run-context';
import { isTerminal } from './run-state';
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
  for (const [id, state] of ctx.states) {
    if (state.status !== 'waiting' || runningTaskIds.has(id)) continue;
    const node = ctx.dag.nodes.get(id)!;
    const allDepsTerminal =
      node.dependsOn.length === 0 ||
      node.dependsOn.every((depId) => isTerminal(ctx.states.get(depId)!.status));
    if (allDepsTerminal) launchable.push(id);
  }
  return launchable;
}

export function allTasksTerminal(ctx: RunContext): boolean {
  return [...ctx.states.values()].every((state) => isTerminal(state.status));
}

/**
 * Abort cleanup helper: after in-flight tasks settle, any remaining
 * non-terminal tasks are waiting/idle tasks that were never started.
 */
export function skipNonTerminalTasks(
  ctx: RunContext,
  finishedAt = nowISO(),
): void {
  for (const [id, state] of ctx.states) {
    if (isTerminal(state.status)) continue;
    state.finishedAt = finishedAt;
    ctx.setTaskStatus(id, 'skipped');
  }
}
