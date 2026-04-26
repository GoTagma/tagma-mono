import type { DriverPlugin, SpawnSpec, TaskResult } from './types';
import { runCommand, runSpawn, type RunOptions } from './runner';

export type { RunOptions };

export interface TagmaRuntime {
  runSpawn(
    spec: SpawnSpec,
    driver: DriverPlugin | null,
    options?: RunOptions,
  ): Promise<TaskResult>;
  runCommand(command: string, cwd: string, options?: RunOptions): Promise<TaskResult>;
}

export function bunRuntime(): TagmaRuntime {
  return {
    runSpawn,
    runCommand,
  };
}
