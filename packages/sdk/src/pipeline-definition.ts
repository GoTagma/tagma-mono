import type { RawPipelineConfig } from './types';

export function definePipeline<T extends RawPipelineConfig>(pipeline: T): T {
  return pipeline;
}
