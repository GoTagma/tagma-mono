import {
  PluginRegistry,
  runPipeline,
  type EngineResult,
  type RunPipelineOptions,
} from '@tagma/core';
import yaml from 'js-yaml';
import { bootstrapBuiltins } from './bootstrap';
import {
  PipelineValidationError,
  loadPipeline,
  validateConfig,
  validateConfigDiagnostics,
} from './schema';
import { bunRuntime } from '@tagma/runtime-bun';
import type { TagmaRuntime } from '@tagma/core';
import type { PipelineConfig, PipelineGraphConfig, TagmaPlugin, WorkflowConfig } from '@tagma/types';
import {
  loadWorkflow,
  runPipelineGraph,
  type PipelineGraphResult,
  type PipelineGraphRunnerOptions,
} from './workflow';

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

export interface TagmaGraphRunOptions
  extends Omit<PipelineGraphRunnerOptions, 'registry' | 'runtime'> {
  readonly cwd: string;
}

export type TagmaRunnableConfig = PipelineConfig | PipelineGraphConfig;

export type TagmaYamlDocument =
  | { readonly kind: 'pipeline'; readonly config: PipelineConfig }
  | { readonly kind: 'workflow'; readonly config: WorkflowConfig };

export type TagmaYamlRunResult =
  | { readonly kind: 'pipeline'; readonly result: EngineResult }
  | { readonly kind: 'workflow'; readonly result: PipelineGraphResult };

export interface Tagma {
  readonly registry: PluginRegistry;
  run(config: PipelineConfig, options: TagmaRunOptions): Promise<EngineResult>;
  run(config: PipelineGraphConfig, options: TagmaGraphRunOptions): Promise<PipelineGraphResult>;
  run(
    config: TagmaRunnableConfig,
    options: TagmaRunOptions | TagmaGraphRunOptions,
  ): Promise<EngineResult | PipelineGraphResult>;
  runYaml(
    content: string,
    options: TagmaRunOptions | TagmaGraphRunOptions,
  ): Promise<TagmaYamlRunResult>;
  validate(config: PipelineConfig): readonly string[];
}

export function detectTagmaYamlKind(content: string): TagmaYamlDocument['kind'] {
  const doc = yaml.load(content) as Record<string, unknown> | null;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const hasPipeline = Object.prototype.hasOwnProperty.call(doc, 'pipeline');
    const hasWorkflow = Object.prototype.hasOwnProperty.call(doc, 'workflow');
    if (hasPipeline && hasWorkflow) {
      throw new Error('YAML must not contain both top-level "pipeline" and "workflow" keys');
    }
    if (hasPipeline) return 'pipeline';
    if (hasWorkflow) return 'workflow';
  }
  throw new Error('YAML must contain a top-level "pipeline" or "workflow" key');
}

export async function loadTagmaYaml(content: string, workDir: string): Promise<TagmaYamlDocument> {
  const kind = detectTagmaYamlKind(content);
  if (kind === 'pipeline') return { kind, config: await loadPipeline(content, workDir) };
  return { kind, config: await loadWorkflow(content, workDir) };
}

function isPipelineGraphConfig(config: TagmaRunnableConfig): config is PipelineGraphConfig {
  return Array.isArray((config as { pipelines?: unknown }).pipelines);
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

  async function run(config: PipelineConfig, options: TagmaRunOptions): Promise<EngineResult>;
  async function run(
    config: PipelineGraphConfig,
    options: TagmaGraphRunOptions,
  ): Promise<PipelineGraphResult>;
  async function run(
    config: TagmaRunnableConfig,
    { cwd, ...runOptions }: TagmaRunOptions | TagmaGraphRunOptions,
  ): Promise<EngineResult | PipelineGraphResult> {
    if (isPipelineGraphConfig(config)) {
      return await runPipelineGraph(config, cwd, {
        ...(runOptions as Omit<TagmaGraphRunOptions, 'cwd'>),
        registry,
        runtime,
      });
    }
    const diagnostics = validateConfigDiagnostics(config, cwd);
    if (diagnostics.length > 0) {
      throw new PipelineValidationError(diagnostics);
    }
    return await runPipeline(config, cwd, {
      ...(runOptions as Omit<TagmaRunOptions, 'cwd'>),
      registry,
      runtime,
    });
  }

  return {
    registry,
    run,
    async runYaml(content, options) {
      const document = await loadTagmaYaml(content, options.cwd);
      if (document.kind === 'pipeline') {
        return { kind: 'pipeline', result: await run(document.config, options as TagmaRunOptions) };
      }
      return {
        kind: 'workflow',
        result: await run(document.config, options as TagmaGraphRunOptions),
      };
    },
    validate(config) {
      return validateConfig(config);
    },
  };
}
