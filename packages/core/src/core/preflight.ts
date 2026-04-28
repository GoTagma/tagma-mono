import {
  DEFAULT_PERMISSIONS,
  type CompletionPlugin,
  type DriverPlugin,
  type MiddlewarePlugin,
  type PipelineConfig,
  type PipelineExecutionMode,
  type TaskConfig,
  type TriggerPlugin,
} from '../types';
import type { Dag } from '../dag';
import { validatePluginConfig, type PluginRegistry } from '../registry';

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
export function preflight(
  config: PipelineConfig,
  dag: Dag,
  registry: PluginRegistry,
  mode: PipelineExecutionMode = 'trusted',
): void {
  const errors: string[] = [];

  for (const [, node] of dag.nodes) {
    const task = node.task;
    const track = node.track;
    const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';

    const isCommand = isCommandOnly(task);

    const driver = !isCommand && registry.hasHandler('drivers', driverName)
      ? registry.getHandler<DriverPlugin>('drivers', driverName)
      : null;

    if (!isCommand && driver === null) {
      errors.push(`Task "${node.taskId}": driver "${driverName}" not registered`);
    }

    if (mode === 'safe' && !isCommand && driver !== null) {
      const permissions = task.permissions ?? track.permissions ?? config.permissions ?? DEFAULT_PERMISSIONS;
      if (permissions.write && driver.capabilities.enforcesPermissions !== true) {
        errors.push(
          `Task "${node.taskId}": safe mode blocks write permission for driver "${driverName}" ` +
            `because it does not declare capabilities.enforcesPermissions`,
        );
      }
    }

    if (task.trigger) {
      if (!registry.hasHandler('triggers', task.trigger.type)) {
        errors.push(`Task "${node.taskId}": trigger type "${task.trigger.type}" not registered`);
      } else {
        const trigger = registry.getHandler<TriggerPlugin>('triggers', task.trigger.type);
        errors.push(
          ...validatePluginConfig(trigger.schema, task.trigger, `Task "${node.taskId}" trigger`),
        );
      }
    }

    if (task.completion) {
      if (!registry.hasHandler('completions', task.completion.type)) {
        errors.push(
          `Task "${node.taskId}": completion type "${task.completion.type}" not registered`,
        );
      } else {
        const completion = registry.getHandler<CompletionPlugin>(
          'completions',
          task.completion.type,
        );
        errors.push(
          ...validatePluginConfig(
            completion.schema,
            task.completion,
            `Task "${node.taskId}" completion`,
          ),
        );
      }
    }

    const mws = task.middlewares ?? track.middlewares ?? [];
    for (const mw of mws) {
      if (!registry.hasHandler('middlewares', mw.type)) {
        errors.push(`Task "${node.taskId}": middleware type "${mw.type}" not registered`);
      } else {
        const middleware = registry.getHandler<MiddlewarePlugin>('middlewares', mw.type);
        errors.push(
          ...validatePluginConfig(middleware.schema, mw, `Task "${node.taskId}" middleware`),
        );
      }
    }

    if (task.continue_from && driver !== null) {
      const upstreamId = node.resolvedContinueFrom;
      if (upstreamId) {
        const upstream = dag.nodes.get(upstreamId);
        if (upstream) {
          const upstreamDriverName =
            upstream.task.driver ?? upstream.track.driver ?? config.driver ?? 'opencode';
          const upstreamDriver = registry.hasHandler('drivers', upstreamDriverName)
            ? registry.getHandler<DriverPlugin>('drivers', upstreamDriverName)
            : null;
          const canResumeNative =
            driver.capabilities.sessionResume && upstreamDriverName === driverName;
          const canNormalize = typeof upstreamDriver?.parseResult === 'function';

          if (!canResumeNative && !canNormalize) {
            errors.push(
              `Task "${node.taskId}" uses continue_from: "${task.continue_from}", ` +
                `but upstream task "${upstreamId}" its driver ` +
                `does not implement parseResult for text-injection handoff. ` +
                `Use a same-driver resume path, a driver with parseResult, or remove continue_from.`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Preflight validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}
