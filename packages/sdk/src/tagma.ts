import {
  PluginRegistry,
  runPipeline,
  type EngineResult,
  type RunPipelineOptions,
} from '@tagma/core';
import { bootstrapBuiltins } from './bootstrap';
import { validateConfig } from './schema';
import { bunRuntime } from '@tagma/runtime-bun';
import type { TagmaRuntime } from '@tagma/core';
import type { PipelineConfig, TagmaPlugin } from '@tagma/types';

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
  /**
   * Package-level capability plugins to register into this SDK instance.
   */
  readonly plugins?: readonly TagmaPlugin[];
  /**
   * Runtime implementation used for command and driver process execution.
   * Defaults to the SDK's Bun runtime.
   */
  readonly runtime?: TagmaRuntime;
}

export interface TagmaRunOptions extends Omit<RunPipelineOptions, 'registry' | 'runtime'> {
  readonly cwd: string;
}

export interface Tagma {
  readonly registry: PluginRegistry;
  run(config: PipelineConfig, options: TagmaRunOptions): Promise<EngineResult>;
  validate(config: PipelineConfig): readonly string[];
}

export function createTagma(options: CreateTagmaOptions = {}): Tagma {
  const registry = options.registry ?? new PluginRegistry();
  const runtime = options.runtime ?? bunRuntime();
  if (options.builtins !== false) {
    bootstrapBuiltins(registry);
  }
  for (const plugin of options.plugins ?? []) {
    registry.registerTagmaPlugin(plugin);
  }

  return {
    registry,
    run(config, { cwd, ...runOptions }) {
      return runPipeline(config, cwd, {
        ...runOptions,
        registry,
        runtime,
      });
    },
    validate(config) {
      return validateConfig(config);
    },
  };
}
