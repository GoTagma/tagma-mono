import type {
  CommandConfig,
  DriverPlugin,
  RunOptions,
  SpawnSpec,
  TaskResult,
  TagmaRuntime,
} from '@tagma/types';
import {
  NativeExecutionService,
  createExecutionPlan,
  type ExecutionPlan,
} from './execution-service.js';

/**
 * Keeps the package-level TagmaRuntime contract while all process execution
 * travels through the sidecar-private native service. The plan remains an
 * explicitly host-specific transition shape; it is not a portable protocol.
 */
export function createLegacyRuntimeAdapter(
  base: TagmaRuntime,
  service: NativeExecutionService,
): TagmaRuntime {
  const execute = async (
    invocation: ExecutionPlan['invocation'],
    driver: DriverPlugin | null,
    options: RunOptions,
  ): Promise<TaskResult> => {
    const handle = await service.start(createExecutionPlan(invocation, options), {
      driver,
      options,
    });
    return await handle.result;
  };

  return {
    ...base,
    runSpawn(spec: SpawnSpec, driver: DriverPlugin | null, options: RunOptions = {}) {
      return execute({ kind: 'legacy-spawn', portability: 'host-specific', spec }, driver, options);
    },
    runCommand(command: CommandConfig, cwd: string, options: RunOptions = {}) {
      return execute(
        { kind: 'legacy-command', portability: 'host-specific', command, cwd },
        null,
        options,
      );
    },
  };
}
