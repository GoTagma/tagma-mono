import type { PipelineConfig, TaskConfig, DriverPlugin } from '../types';
import type { Dag } from '../dag';
import type { PluginRegistry } from '../registry';

function isCommandOnly(
  task: TaskConfig,
): task is TaskConfig & { readonly command: string; readonly prompt?: undefined } {
  return task.command !== undefined && task.prompt === undefined;
}

/**
 * Validate that every plugin referenced by the pipeline (drivers,
 * triggers, completions, middlewares) is registered, and that
 * `continue_from` is only used between drivers that can hand off via
 * sessionResume or text-injection. Throws with all errors aggregated
 * into one message so the caller sees every misconfiguration in a
 * single pass.
 */
export function preflight(config: PipelineConfig, dag: Dag, registry: PluginRegistry): void {
  const errors: string[] = [];

  for (const [, node] of dag.nodes) {
    const task = node.task;
    const track = node.track;
    const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';

    const isCommand = isCommandOnly(task);

    if (!isCommand && !registry.hasHandler('drivers', driverName)) {
      errors.push(`Task "${node.taskId}": driver "${driverName}" not registered`);
    }

    if (task.trigger && !registry.hasHandler('triggers', task.trigger.type)) {
      errors.push(`Task "${node.taskId}": trigger type "${task.trigger.type}" not registered`);
    }

    if (task.completion && !registry.hasHandler('completions', task.completion.type)) {
      errors.push(
        `Task "${node.taskId}": completion type "${task.completion.type}" not registered`,
      );
    }

    const mws = task.middlewares ?? track.middlewares ?? [];
    for (const mw of mws) {
      if (!registry.hasHandler('middlewares', mw.type)) {
        errors.push(`Task "${node.taskId}": middleware type "${mw.type}" not registered`);
      }
    }

    if (task.continue_from && registry.hasHandler('drivers', driverName)) {
      const driver = registry.getHandler<DriverPlugin>('drivers', driverName);
      if (!driver.capabilities.sessionResume) {
        const upstreamId = node.resolvedContinueFrom;
        if (upstreamId) {
          const upstream = dag.nodes.get(upstreamId);
          if (upstream) {
            const upstreamDriverName =
              upstream.task.driver ?? upstream.track.driver ?? config.driver ?? 'opencode';
            const upstreamDriver = registry.hasHandler('drivers', upstreamDriverName)
              ? registry.getHandler<DriverPlugin>('drivers', upstreamDriverName)
              : null;
            const canNormalize = typeof upstreamDriver?.parseResult === 'function';

            if (!canNormalize) {
              errors.push(
                `Task "${node.taskId}" uses continue_from: "${task.continue_from}", ` +
                  `but upstream task "${upstreamId}" its driver ` +
                  `does not implement parseResult for text-injection handoff. ` +
                  `Use a driver with parseResult, or remove continue_from.`,
              );
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Preflight validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}
