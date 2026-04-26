import { runPipeline, type EngineResult, type RunPipelineOptions } from './engine';
import { bootstrapBuiltins } from './bootstrap';
import { PluginRegistry } from './registry';
import { validateConfig } from './schema';
import type { PipelineConfig } from './types';

export interface CreateTagmaOptions {
  /**
   * Registry used by this SDK instance. Omit to create an isolated registry.
   */
  readonly registry?: PluginRegistry;
  /**
   * Register built-in drivers/triggers/completions/middlewares into the
   * instance registry. Defaults to true.
   */
  readonly builtins?: boolean;
}

export interface TagmaRunOptions extends Omit<RunPipelineOptions, 'registry'> {
  readonly cwd: string;
}

export interface Tagma {
  readonly registry: PluginRegistry;
  run(config: PipelineConfig, options: TagmaRunOptions): Promise<EngineResult>;
  validate(config: PipelineConfig): readonly string[];
}

export function createTagma(options: CreateTagmaOptions = {}): Tagma {
  const registry = options.registry ?? new PluginRegistry();
  if (options.builtins !== false) {
    bootstrapBuiltins(registry);
  }

  return {
    registry,
    run(config, { cwd, ...runOptions }) {
      return runPipeline(config, cwd, {
        ...runOptions,
        registry,
      });
    },
    validate(config) {
      return validateConfig(config);
    },
  };
}
