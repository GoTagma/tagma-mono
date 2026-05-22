import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  generateRunId,
  isValidTaskId,
  runPipeline,
  validatePath,
  type EngineResult,
  type RunPipelineOptions,
} from '@tagma/core';
import type {
  PipelineGraphAbortReason,
  PipelineGraphConfig,
  PipelineGraphEventPayload,
  PipelineGraphNodeState,
  PipelineGraphNodeStatus,
  PipelineGraphPipelineConfig,
  RawWorkflowConfig,
  RawWorkflowPipelineConfig,
  WorkflowConfig,
  WorkflowFailurePolicy,
} from '@tagma/types';
import { PipelineValidationError, loadPipeline } from './schema';
import type { ValidationError } from './validate-raw';

export type {
  PipelineGraphAbortReason,
  PipelineGraphConfig,
  PipelineGraphEventPayload,
  PipelineGraphNodeState,
  PipelineGraphNodeStatus,
  PipelineGraphPipelineConfig,
  RawWorkflowConfig,
  RawWorkflowPipelineConfig,
  WorkflowConfig,
  WorkflowFailurePolicy,
  WorkflowPipelineConfig,
} from '@tagma/types';
export type { EngineResult };

export interface PipelineGraphPipelineResult extends PipelineGraphNodeState {
  readonly result: EngineResult | null;
}

export interface PipelineGraphResult {
  readonly graphRunId: string;
  readonly success: boolean;
  readonly abortReason: PipelineGraphAbortReason;
  readonly pipelines: readonly PipelineGraphPipelineResult[];
}

export interface PipelineGraphRunnerOptions extends Omit<RunPipelineOptions, 'signal' | 'onEvent'> {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: PipelineGraphEventPayload) => void;
}

interface MutableNodeState {
  pipelineId: string;
  path: string | null;
  dependsOn: string[];
  status: PipelineGraphNodeStatus;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: EngineResult | null;
}

const VALID_FAILURE_POLICIES: ReadonlySet<WorkflowFailurePolicy> = new Set([
  'stop_all',
  'continue_independent',
]);
const WORKFLOW_YAML_DUMP_OPTIONS = {
  lineWidth: 120,
  indent: 2,
  noCompatMode: true,
} as Parameters<typeof yaml.dump>[1] & { noCompatMode: boolean };

export class WorkflowValidationError extends PipelineValidationError {
  constructor(diagnostics: readonly ValidationError[]) {
    super(diagnostics);
    this.name = 'WorkflowValidationError';
  }
}

export function parseWorkflowYaml(content: string): RawWorkflowConfig {
  const doc = yaml.load(content) as { workflow?: unknown };
  if (!doc?.workflow) {
    throw new Error('YAML must contain a top-level "workflow" key');
  }
  if (typeof doc.workflow !== 'object' || Array.isArray(doc.workflow)) {
    throw new Error('workflow must be an object');
  }
  const workflow = doc.workflow as RawWorkflowConfig;
  if (!Array.isArray(workflow.pipelines)) {
    throw new Error('workflow.pipelines must be an array');
  }
  for (let i = 0; i < workflow.pipelines.length; i++) {
    const pipeline = workflow.pipelines[i] as unknown;
    if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) {
      throw new Error(`workflow.pipelines[${i}] must be an object`);
    }
  }
  return workflow;
}

export function serializeWorkflow(config: RawWorkflowConfig | WorkflowConfig): string {
  return yaml.dump({ workflow: stripLoadedPipelines(config) }, WORKFLOW_YAML_DUMP_OPTIONS);
}

function stripLoadedPipelines(config: RawWorkflowConfig | WorkflowConfig): RawWorkflowConfig {
  return {
    name: config.name,
    ...(config.max_concurrency !== undefined ? { max_concurrency: config.max_concurrency } : {}),
    ...(config.failure_policy ? { failure_policy: config.failure_policy } : {}),
    pipelines: config.pipelines.map((pipeline) => ({
      id: pipeline.id,
      path: pipeline.path,
      ...(pipeline.depends_on?.length ? { depends_on: pipeline.depends_on } : {}),
      ...(pipeline.position ? { position: pipeline.position } : {}),
    })),
  };
}

export function validateRawWorkflow(config: RawWorkflowConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  validateGraphHeader(config, errors);
  if (!Array.isArray(config.pipelines)) {
    errors.push({ path: 'pipelines', message: 'workflow.pipelines must be an array' });
    return errors;
  }
  if (config.pipelines.length === 0) {
    errors.push({ path: 'pipelines', message: 'At least one pipeline is required' });
    return errors;
  }

  validatePipelineNodes(config.pipelines, errors, true);
  errors.push(...detectPipelineCycles(config.pipelines));
  return errors;
}

export async function loadWorkflow(content: string, workDir: string): Promise<WorkflowConfig> {
  const raw = parseWorkflowYaml(content);
  const diagnostics = validateRawWorkflow(raw);
  if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);

  const pipelines = await Promise.all(
    raw.pipelines.map(async (pipeline) => {
      const resolved = validatePath(pipeline.path, workDir);
      const pipelineYaml = readFileSync(resolved, 'utf8');
      const config = await loadPipeline(pipelineYaml, workDir);
      return {
        id: pipeline.id,
        path: pipeline.path,
        cwd: workDir,
        depends_on: pipeline.depends_on,
        position: pipeline.position,
        config,
      };
    }),
  );

  return {
    name: raw.name,
    max_concurrency: raw.max_concurrency,
    failure_policy: raw.failure_policy,
    pipelines,
  };
}

export async function runPipelineGraph(
  config: PipelineGraphConfig,
  workDir: string,
  options: PipelineGraphRunnerOptions,
): Promise<PipelineGraphResult> {
  return await new PipelineGraphRunner(config, workDir, options).start();
}

export class PipelineGraphRunner {
  readonly graphRunId: string;

  private readonly order: readonly string[];
  private readonly nodes = new Map<string, MutableNodeState>();
  private readonly nodeConfigs = new Map<string, PipelineGraphPipelineConfig>();
  private readonly handlers = new Set<(event: PipelineGraphEventPayload) => void>();
  private readonly activeControllers = new Map<string, AbortController>();
  private result: Promise<PipelineGraphResult> | null = null;
  private abortReason: PipelineGraphAbortReason = null;
  private aborted = false;

  constructor(
    private readonly config: PipelineGraphConfig,
    private readonly workDir: string,
    private readonly options: PipelineGraphRunnerOptions,
  ) {
    const diagnostics = validatePipelineGraphConfig(config);
    if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);
    this.graphRunId = generateRunId();
    this.order = topologicalPipelineOrder(config.pipelines);

    for (const pipeline of config.pipelines) {
      this.nodeConfigs.set(pipeline.id, pipeline);
      this.nodes.set(pipeline.id, {
        pipelineId: pipeline.id,
        path: pipeline.path ?? null,
        dependsOn: [...(pipeline.depends_on ?? [])],
        status: 'waiting',
        runId: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        result: null,
      });
    }
  }

  start(): Promise<PipelineGraphResult> {
    if (this.result) return this.result;

    if (this.options.signal?.aborted) this.abort('external');
    const onAbort = () => this.abort('external');
    this.options.signal?.addEventListener('abort', onAbort, { once: true });

    this.result = this.runGraph().finally(() => {
      this.options.signal?.removeEventListener('abort', onAbort);
    });
    return this.result;
  }

  abort(_reason?: string): void {
    if (this.abortReason === null) this.abortReason = 'external';
    this.aborted = true;
    for (const controller of this.activeControllers.values()) {
      controller.abort(_reason);
    }
  }

  subscribe(handler: (event: PipelineGraphEventPayload) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private async runGraph(): Promise<PipelineGraphResult> {
    this.emit({
      type: 'graph_start',
      graphRunId: this.graphRunId,
      workflowName: this.config.name,
      pipelines: this.snapshotNodes(),
    });

    const running = new Map<string, Promise<void>>();
    const maxConcurrency = this.config.max_concurrency ?? 1;

    while (!this.allTerminal()) {
      if (this.aborted) {
        this.skipWaitingNodes();
      } else {
        this.skipNodesWithFailedDeps();
        this.launchReadyNodes(running, maxConcurrency);
      }

      if (this.allTerminal()) break;

      if (running.size === 0) {
        const message = 'Pipeline graph scheduler stalled with non-terminal pipelines';
        this.emit({ type: 'graph_error', graphRunId: this.graphRunId, error: message });
        this.failWaitingNodes(message);
        break;
      }

      await Promise.race(running.values());
    }

    if (running.size > 0) {
      await Promise.allSettled(running.values());
    }

    const pipelines = this.snapshotResults();
    const success = pipelines.every((pipeline) => pipeline.status === 'success');
    const result: PipelineGraphResult = {
      graphRunId: this.graphRunId,
      success,
      abortReason: this.abortReason,
      pipelines,
    };
    this.emit({
      type: 'graph_end',
      graphRunId: this.graphRunId,
      success,
      abortReason: this.abortReason,
      pipelines: this.snapshotNodes(),
    });
    return result;
  }

  private launchReadyNodes(running: Map<string, Promise<void>>, maxConcurrency: number): void {
    for (const pipelineId of this.order) {
      if (running.size >= maxConcurrency) return;
      const state = this.nodes.get(pipelineId)!;
      if (state.status !== 'waiting') continue;
      if (!state.dependsOn.every((dep) => this.nodes.get(dep)?.status === 'success')) continue;

      const task = this.runOnePipeline(pipelineId).finally(() => {
        running.delete(pipelineId);
      });
      running.set(pipelineId, task);
    }
  }

  private async runOnePipeline(pipelineId: string): Promise<void> {
    const pipeline = this.nodeConfigs.get(pipelineId)!;
    const controller = new AbortController();
    this.activeControllers.set(pipelineId, controller);
    this.updateNode(pipelineId, { status: 'running', startedAt: new Date().toISOString() });

    const { signal: _graphSignal, onEvent: _graphOnEvent, ...pipelineOptions } = this.options;

    try {
      const result = await runPipeline(pipeline.config, pipeline.cwd ?? this.workDir, {
        ...pipelineOptions,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'run_start') {
            this.updateNode(pipelineId, { runId: event.runId });
          }
          this.emit({
            type: 'pipeline_event',
            graphRunId: this.graphRunId,
            pipelineId,
            event,
          });
        },
      });

      const status: PipelineGraphNodeStatus = controller.signal.aborted
        ? 'aborted'
        : result.success
          ? 'success'
          : 'failed';
      this.updateNode(pipelineId, {
        status,
        result,
        finishedAt: new Date().toISOString(),
        error: status === 'failed' ? 'Pipeline failed' : null,
      });
      if (status === 'failed' && (this.config.failure_policy ?? 'stop_all') === 'stop_all') {
        this.stopAllForFailure();
      }
    } catch (err) {
      const status: PipelineGraphNodeStatus = controller.signal.aborted ? 'aborted' : 'failed';
      const error = errorMessage(err);
      this.updateNode(pipelineId, {
        status,
        error,
        finishedAt: new Date().toISOString(),
      });
      if (status === 'failed') {
        this.emit({ type: 'graph_error', graphRunId: this.graphRunId, error });
        if ((this.config.failure_policy ?? 'stop_all') === 'stop_all') this.stopAllForFailure();
      }
    } finally {
      this.activeControllers.delete(pipelineId);
    }
  }

  private stopAllForFailure(): void {
    if (this.abortReason === null) this.abortReason = 'stop_all';
    this.aborted = true;
    for (const controller of this.activeControllers.values()) controller.abort('stop_all');
    this.skipWaitingNodes();
  }

  private skipNodesWithFailedDeps(): void {
    for (const pipelineId of this.order) {
      const state = this.nodes.get(pipelineId)!;
      if (state.status !== 'waiting') continue;
      const deps = state.dependsOn.map((dep) => this.nodes.get(dep)!);
      if (!deps.every((dep) => isTerminal(dep.status))) continue;
      if (deps.some((dep) => dep.status !== 'success')) {
        this.updateNode(pipelineId, {
          status: 'skipped',
          finishedAt: new Date().toISOString(),
          error: 'Skipped because an upstream pipeline did not succeed',
        });
      }
    }
  }

  private skipWaitingNodes(): void {
    for (const pipelineId of this.order) {
      const state = this.nodes.get(pipelineId)!;
      if (state.status !== 'waiting') continue;
      this.updateNode(pipelineId, {
        status: 'skipped',
        finishedAt: new Date().toISOString(),
        error: 'Skipped because the pipeline graph was aborted',
      });
    }
  }

  private failWaitingNodes(message: string): void {
    for (const pipelineId of this.order) {
      const state = this.nodes.get(pipelineId)!;
      if (state.status !== 'waiting') continue;
      this.updateNode(pipelineId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      });
    }
  }

  private allTerminal(): boolean {
    for (const state of this.nodes.values()) {
      if (!isTerminal(state.status)) return false;
    }
    return true;
  }

  private updateNode(
    pipelineId: string,
    patch: Partial<Omit<MutableNodeState, 'pipelineId' | 'path' | 'dependsOn'>>,
  ): void {
    const state = this.nodes.get(pipelineId)!;
    Object.assign(state, patch);
    this.emit({
      type: 'pipeline_update',
      graphRunId: this.graphRunId,
      pipelineId,
      status: state.status,
      runId: state.runId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      error: state.error,
    });
  }

  private snapshotNodes(): PipelineGraphNodeState[] {
    return [...this.nodes.values()].map(({ result: _result, ...state }) => ({ ...state }));
  }

  private snapshotResults(): PipelineGraphPipelineResult[] {
    return [...this.nodes.values()].map((state) => ({
      pipelineId: state.pipelineId,
      path: state.path,
      dependsOn: [...state.dependsOn],
      status: state.status,
      runId: state.runId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      error: state.error,
      result: state.result,
    }));
  }

  private emit(event: PipelineGraphEventPayload): void {
    try {
      this.options.onEvent?.(event);
    } catch (err) {
      console.error('[PipelineGraphRunner] onEvent handler threw', err);
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error('[PipelineGraphRunner] subscriber threw while handling graph event', err);
      }
    }
  }
}

export interface CreatePipelineGroupOptions {
  readonly name?: string;
  readonly maxConcurrency?: number;
  readonly failurePolicy?: WorkflowFailurePolicy;
}

export interface PipelineGroupAddOptions {
  readonly id: string;
  readonly config: PipelineGraphPipelineConfig['config'];
  readonly cwd?: string;
  readonly path?: string;
  readonly dependsOn?: readonly string[];
}

export class PipelineGroup {
  private readonly pipelines: PipelineGraphPipelineConfig[] = [];

  constructor(private readonly options: CreatePipelineGroupOptions = {}) {}

  add(options: PipelineGroupAddOptions): this {
    this.pipelines.push({
      id: options.id,
      config: options.config,
      cwd: options.cwd,
      path: options.path,
      depends_on: options.dependsOn,
    });
    return this;
  }

  toConfig(): PipelineGraphConfig {
    return {
      name: this.options.name ?? 'pipeline-group',
      max_concurrency: this.options.maxConcurrency,
      failure_policy: this.options.failurePolicy,
      pipelines: this.pipelines,
    };
  }

  run(workDir: string, options: PipelineGraphRunnerOptions): Promise<PipelineGraphResult> {
    return runPipelineGraph(this.toConfig(), workDir, options);
  }
}

export function createPipelineGroup(options: CreatePipelineGroupOptions = {}): PipelineGroup {
  return new PipelineGroup(options);
}

function validatePipelineGraphConfig(config: PipelineGraphConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  validateGraphHeader(config, errors);
  if (!Array.isArray(config.pipelines)) {
    errors.push({ path: 'pipelines', message: 'workflow.pipelines must be an array' });
    return errors;
  }
  if (config.pipelines.length === 0) {
    errors.push({ path: 'pipelines', message: 'At least one pipeline is required' });
    return errors;
  }
  validatePipelineNodes(config.pipelines, errors, false);
  errors.push(...detectPipelineCycles(config.pipelines));
  return errors;
}

function validateGraphHeader(
  config: Pick<PipelineGraphConfig, 'name' | 'max_concurrency' | 'failure_policy'>,
  errors: ValidationError[],
): void {
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    errors.push({ path: 'name', message: 'Workflow name is required' });
  }
  if (
    config.max_concurrency !== undefined &&
    (!Number.isInteger(config.max_concurrency) || config.max_concurrency < 1)
  ) {
    errors.push({ path: 'max_concurrency', message: 'max_concurrency must be a positive integer' });
  }
  if (config.failure_policy !== undefined && !VALID_FAILURE_POLICIES.has(config.failure_policy)) {
    errors.push({
      path: 'failure_policy',
      message: 'failure_policy must be "stop_all" or "continue_independent"',
    });
  }
}

function validatePipelineNodes(
  pipelines: readonly (RawWorkflowPipelineConfig | PipelineGraphPipelineConfig)[],
  errors: ValidationError[],
  requirePath: boolean,
): void {
  const seen = new Set<string>();
  const ids = new Set<string>();

  pipelines.forEach((pipeline, index) => {
    const path = `pipelines[${index}]`;
    if (typeof pipeline.id !== 'string' || pipeline.id.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'Pipeline id is required' });
    } else if (!isValidTaskId(pipeline.id)) {
      errors.push({
        path: `${path}.id`,
        message: `Pipeline id "${pipeline.id}" is invalid`,
      });
    } else if (seen.has(pipeline.id)) {
      errors.push({ path: `${path}.id`, message: `Duplicate pipeline id "${pipeline.id}"` });
    } else {
      seen.add(pipeline.id);
      ids.add(pipeline.id);
    }

    if (requirePath)
      validateWorkflowPath((pipeline as RawWorkflowPipelineConfig).path, path, errors);
    validateWorkflowPosition(
      (pipeline as RawWorkflowPipelineConfig | PipelineGraphPipelineConfig).position,
      path,
      errors,
    );
  });

  pipelines.forEach((pipeline, index) => {
    const deps = pipeline.depends_on;
    if (deps === undefined) return;
    if (!Array.isArray(deps)) {
      errors.push({
        path: `pipelines[${index}].depends_on`,
        message: 'depends_on must be an array',
      });
      return;
    }
    for (let di = 0; di < deps.length; di++) {
      const dep = deps[di];
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        errors.push({
          path: `pipelines[${index}].depends_on[${di}]`,
          message: 'depends_on entries must be non-empty strings',
        });
        continue;
      }
      if (!ids.has(dep)) {
        errors.push({
          path: `pipelines[${index}].depends_on`,
          message: `Pipeline "${pipeline.id}" depends_on "${dep}" - no such pipeline found`,
        });
      }
    }
  });
}

function validateWorkflowPosition(
  value: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: `${basePath}.position`, message: 'position must be an object' });
    return;
  }
  const pos = value as { x?: unknown; y?: unknown };
  if (
    typeof pos.x !== 'number' ||
    !Number.isFinite(pos.x) ||
    typeof pos.y !== 'number' ||
    !Number.isFinite(pos.y)
  ) {
    errors.push({
      path: `${basePath}.position`,
      message: 'position.x and position.y must be finite numbers',
    });
  }
}

function validateWorkflowPath(value: unknown, basePath: string, errors: ValidationError[]): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ path: `${basePath}.path`, message: 'pipeline path must be a non-empty string' });
    return;
  }
  const parts = value.split(/[\\/]+/);
  if (isAbsolute(value) || parts.includes('..')) {
    errors.push({
      path: `${basePath}.path`,
      message: 'pipeline path must be workspace-relative and cannot contain ".."',
    });
  }
  if (!/\.ya?ml$/i.test(value)) {
    errors.push({
      path: `${basePath}.path`,
      message: 'pipeline path must be a .yaml or .yml file',
    });
  }
}

function detectPipelineCycles(
  pipelines: readonly (RawWorkflowPipelineConfig | PipelineGraphPipelineConfig)[],
): ValidationError[] {
  const ids = new Set(
    pipelines
      .map((pipeline) => pipeline.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const depsById = new Map<string, string[]>();
  for (const pipeline of pipelines) {
    if (!ids.has(pipeline.id)) continue;
    depsById.set(
      pipeline.id,
      (pipeline.depends_on ?? []).filter((dep): dep is string => ids.has(dep)),
    );
  }

  const errors: ValidationError[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();

  function dfs(id: string): void {
    if (inStack.has(id)) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start);
      const key = [...cycle].sort().join(',');
      if (!reported.has(key)) {
        reported.add(key);
        errors.push({
          path: 'pipelines',
          message: `Circular dependency detected: ${[...cycle, id].join(' -> ')}`,
        });
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    inStack.add(id);
    stack.push(id);
    for (const dep of depsById.get(id) ?? []) dfs(dep);
    stack.pop();
    inStack.delete(id);
  }

  for (const id of depsById.keys()) dfs(id);
  return errors;
}

function topologicalPipelineOrder(
  pipelines: readonly (RawWorkflowPipelineConfig | PipelineGraphPipelineConfig)[],
): string[] {
  const nodes = new Set(pipelines.map((pipeline) => pipeline.id));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of nodes) {
    inDegree.set(id, 0);
    children.set(id, []);
  }
  for (const pipeline of pipelines) {
    for (const dep of pipeline.depends_on ?? []) {
      children.get(dep)!.push(pipeline.id);
      inDegree.set(pipeline.id, (inDegree.get(pipeline.id) ?? 0) + 1);
    }
  }

  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const sorted: string[] = [];
  let index = 0;
  while (index < ready.length) {
    const id = ready[index++]!;
    sorted.push(id);
    const newlyReady: string[] = [];
    for (const child of children.get(id) ?? []) {
      const degree = inDegree.get(child)! - 1;
      inDegree.set(child, degree);
      if (degree === 0) newlyReady.push(child);
    }
    newlyReady.sort();
    ready.push(...newlyReady);
  }
  return sorted;
}

function isTerminal(status: PipelineGraphNodeStatus): boolean {
  return (
    status === 'success' || status === 'failed' || status === 'skipped' || status === 'aborted'
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

export function resolveWorkflowPipelinePath(workDir: string, path: string): string {
  return resolve(validatePath(path, workDir));
}
