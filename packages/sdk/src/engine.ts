import {
  runPipeline as runCorePipeline,
  TriggerBlockedError,
  TriggerTimeoutError,
  type EngineResult,
  type RunEventPayload,
  type RunPipelineOptions as CoreRunPipelineOptions,
} from '@tagma/core';
import { bunRuntime } from '@tagma/runtime-bun';
import type { PipelineConfig, TagmaRuntime } from './types';

export { TriggerBlockedError, TriggerTimeoutError };
export type { EngineResult, RunEventPayload };

export interface RunPipelineOptions extends Omit<CoreRunPipelineOptions, 'runtime'> {
  /**
   * Runtime implementation for command and driver process execution.
   * Defaults to the SDK's Bun runtime.
   */
  readonly runtime?: TagmaRuntime;
}

export function runPipeline(
  config: PipelineConfig,
  workDir: string,
  options: RunPipelineOptions,
): Promise<EngineResult> {
  return runCorePipeline(config, workDir, {
    ...options,
    runtime: options.runtime ?? bunRuntime(),
  });
}
