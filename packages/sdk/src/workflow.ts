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
  PipelineGraphMaxRuns,
  PipelineGraphPipelineAttemptState,
  PipelineGraphPipelineConfig,
  PipelineGraphPipelineLifecycle,
  PipelineGraphStopWhen,
  PipelineConfig,
  RawWorkflowConfig,
  RawWorkflowPipelineConfig,
  WorkflowConfig,
  WorkflowDocumentKind,
  WorkflowFailurePolicy,
  WorkflowPipelineConfig,
} from '@tagma/types';
import { PipelineValidationError, loadPipeline, validateConfigDiagnostics } from './schema';
import type { ValidationError } from './validate-raw';
import { assertWorkDir } from './workdir';
import {
  validateDeclaredSdkRequirement,
  withInferredWorkflowSdkRequirement,
} from './compatibility';

export type {
  PipelineGraphAbortReason,
  PipelineGraphConfig,
  PipelineGraphEventPayload,
  PipelineGraphNodeState,
  PipelineGraphNodeStatus,
  PipelineGraphMaxRuns,
  PipelineGraphPipelineAttemptState,
  PipelineGraphPipelineConfig,
  PipelineGraphPipelineLifecycle,
  PipelineGraphStopWhen,
  RawWorkflowConfig,
  RawWorkflowPipelineConfig,
  WorkflowConfig,
  WorkflowDocumentKind,
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
  runCount: number;
  maxRuns: number | null;
  attempts: PipelineGraphPipelineAttemptState[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: EngineResult | null;
}

interface NormalizedPipelineLifecycle {
  readonly max_runs: number | null;
  readonly stop_when: PipelineGraphStopWhen;
}

const VALID_FAILURE_POLICIES: ReadonlySet<WorkflowFailurePolicy> = new Set([
  'stop_all',
  'continue_independent',
]);
const VALID_WORKFLOW_KINDS: ReadonlySet<WorkflowDocumentKind> = new Set(['workflow', 'graph']);
const VALID_PIPELINE_STOP_WHEN: ReadonlySet<PipelineGraphStopWhen> = new Set([
  'success',
  'failure',
  'always',
]);
const WORKFLOW_FIELDS: ReadonlySet<string> = new Set([
  'requires',
  'kind',
  'name',
  'max_concurrency',
  'failure_policy',
  'pipelines',
]);
const RAW_WORKFLOW_PIPELINE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'path',
  'depends_on',
  'position',
  'lifecycle',
]);
const GRAPH_PIPELINE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'config',
  'cwd',
  'path',
  'depends_on',
  'position',
  'lifecycle',
]);
const WORKFLOW_POSITION_FIELDS: ReadonlySet<string> = new Set(['x', 'y']);
const PIPELINE_LIFECYCLE_FIELDS: ReadonlySet<string> = new Set(['max_runs', 'stop_when']);
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
  return yaml.dump(
    { workflow: withInferredWorkflowSdkRequirement(stripLoadedPipelines(config)) },
    WORKFLOW_YAML_DUMP_OPTIONS,
  );
}

function stripLoadedPipelines(config: RawWorkflowConfig | WorkflowConfig): RawWorkflowConfig {
  return {
    ...(config.requires ? { requires: config.requires } : {}),
    kind: config.kind ?? 'graph',
    name: config.name,
    ...(config.max_concurrency !== undefined ? { max_concurrency: config.max_concurrency } : {}),
    ...(config.failure_policy ? { failure_policy: config.failure_policy } : {}),
    pipelines: config.pipelines.map((pipeline) => ({
      id: pipeline.id,
      path: pipeline.path,
      ...(pipeline.depends_on?.length ? { depends_on: pipeline.depends_on } : {}),
      ...(pipeline.position ? { position: pipeline.position } : {}),
      ...(pipeline.lifecycle ? { lifecycle: stripDefaultLifecycle(pipeline.lifecycle) } : {}),
    })),
  };
}

export function validateRawWorkflow(config: RawWorkflowConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  validateUnknownFields(
    config as unknown as Record<string, unknown>,
    WORKFLOW_FIELDS,
    '',
    'workflow',
    errors,
  );
  errors.push(...validateDeclaredSdkRequirement(config.requires, 'requires', 'workflow'));
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
  assertWorkDir(workDir);
  const raw = parseWorkflowYaml(content);
  const diagnostics = validateRawWorkflow(raw);
  if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);

  const pipelines: WorkflowPipelineConfig[] = [];
  const loadDiagnostics: ValidationError[] = [];

  for (let index = 0; index < raw.pipelines.length; index++) {
    const pipeline = raw.pipelines[index]!;
    try {
      const resolved = validatePath(pipeline.path, workDir);
      const pipelineYaml = readFileSync(resolved, 'utf8');
      const config = await loadPipeline(pipelineYaml, workDir);
      pipelines.push({
        id: pipeline.id,
        path: pipeline.path,
        cwd: workDir,
        depends_on: pipeline.depends_on,
        position: pipeline.position,
        lifecycle: pipeline.lifecycle,
        config,
      });
    } catch (err) {
      if (err instanceof PipelineValidationError) {
        loadDiagnostics.push(
          ...err.diagnostics.map((diagnostic) => ({
            path: `pipelines[${index}].config.${diagnostic.path}`,
            message: diagnostic.message,
            severity: diagnostic.severity,
          })),
        );
      } else {
        loadDiagnostics.push({
          path: `pipelines[${index}].path`,
          message: errorMessage(err),
        });
      }
    }
  }

  if (loadDiagnostics.length > 0) throw new WorkflowValidationError(loadDiagnostics);

  return {
    ...(raw.requires ? { requires: raw.requires } : {}),
    kind: raw.kind ?? 'graph',
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
    assertWorkDir(workDir);
    const diagnostics = validatePipelineGraphConfig(config);
    diagnostics.push(...validateGraphPipelineConfigs(config, workDir));
    if (diagnostics.length > 0) throw new WorkflowValidationError(diagnostics);
    this.graphRunId = generateRunId().replace(/^run_/, 'graph_');
    this.order = topologicalPipelineOrder(config.pipelines);

    for (const pipeline of config.pipelines) {
      const lifecycle = normalizePipelineLifecycle(pipeline.lifecycle);
      this.nodeConfigs.set(pipeline.id, pipeline);
      this.nodes.set(pipeline.id, {
        pipelineId: pipeline.id,
        path: pipeline.path ?? null,
        dependsOn: [...(pipeline.depends_on ?? [])],
        status: 'waiting',
        runId: null,
        runCount: 0,
        maxRuns: lifecycle.max_runs,
        attempts: [],
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
    const lifecycle = normalizePipelineLifecycle(pipeline.lifecycle);
    const maxRuns = lifecycle.max_runs;
    const stopWhen = lifecycle.stop_when ?? 'success';
    const { signal: _graphSignal, onEvent: _graphOnEvent, ...pipelineOptions } = this.options;

    for (let attempt = 1; maxRuns === null || attempt <= maxRuns; attempt++) {
      if (this.aborted) {
        const finishedAt = new Date().toISOString();
        this.updateNode(pipelineId, {
          status: 'aborted',
          finishedAt,
          error: 'Aborted before the next pipeline lifecycle attempt',
        });
        return;
      }

      const controller = new AbortController();
      this.activeControllers.set(pipelineId, controller);
      const startedAt = new Date().toISOString();
      this.updateNode(pipelineId, {
        status: 'running',
        runId: null,
        runCount: attempt,
        maxRuns,
        attempts: [
          ...this.nodes.get(pipelineId)!.attempts,
          { attempt, runId: null, status: 'running', startedAt, finishedAt: null, error: null },
        ],
        startedAt,
        finishedAt: null,
        error: null,
      });

      try {
        const result = await runPipeline(
          pipeline.config,
          graphPipelineWorkDir(pipeline.cwd, this.workDir),
          {
            ...pipelineOptions,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === 'run_start') {
                this.updateNode(pipelineId, {
                  runId: event.runId,
                  attempts: this.patchAttempt(pipelineId, attempt, { runId: event.runId }),
                });
              }
              this.emit({
                type: 'pipeline_event',
                graphRunId: this.graphRunId,
                pipelineId,
                attempt,
                event,
              });
            },
          },
        );

        const status: PipelineGraphNodeStatus = controller.signal.aborted
          ? 'aborted'
          : result.success
            ? 'success'
            : 'failed';
        const finishedAt = new Date().toISOString();
        const error = status === 'failed' ? 'Pipeline failed' : null;
        this.updateNode(pipelineId, {
          result,
          attempts: this.patchAttempt(pipelineId, attempt, { status, finishedAt, error }),
        });

        if (this.shouldFinishLifecycle(status, stopWhen, attempt, maxRuns)) {
          this.updateNode(pipelineId, {
            status,
            result,
            finishedAt,
            error,
          });
          if (status === 'failed' && (this.config.failure_policy ?? 'stop_all') === 'stop_all') {
            this.stopAllForFailure();
          }
          return;
        }
      } catch (err) {
        const status: PipelineGraphNodeStatus = controller.signal.aborted ? 'aborted' : 'failed';
        const error = errorMessage(err);
        const finishedAt = new Date().toISOString();
        this.updateNode(pipelineId, {
          attempts: this.patchAttempt(pipelineId, attempt, { status, finishedAt, error }),
        });
        if (this.shouldFinishLifecycle(status, stopWhen, attempt, maxRuns)) {
          this.updateNode(pipelineId, {
            status,
            error,
            finishedAt,
          });
          if (status === 'failed') {
            this.emit({ type: 'graph_error', graphRunId: this.graphRunId, error });
            if ((this.config.failure_policy ?? 'stop_all') === 'stop_all') this.stopAllForFailure();
          }
          return;
        }
      } finally {
        this.activeControllers.delete(pipelineId);
      }
    }
  }

  private shouldFinishLifecycle(
    status: PipelineGraphNodeStatus,
    stopWhen: PipelineGraphStopWhen,
    attempt: number,
    maxRuns: number | null,
  ): boolean {
    if (status === 'aborted' || status === 'skipped') return true;
    if (stopWhen === 'always') return maxRuns !== null && attempt >= maxRuns;
    if (stopWhen === 'success' && status === 'success') return true;
    if (stopWhen === 'failure' && status === 'failed') return true;
    return maxRuns !== null && attempt >= maxRuns;
  }

  private patchAttempt(
    pipelineId: string,
    attempt: number,
    patch: Partial<Omit<PipelineGraphPipelineAttemptState, 'attempt'>>,
  ): PipelineGraphPipelineAttemptState[] {
    const state = this.nodes.get(pipelineId)!;
    return state.attempts.map((entry) =>
      entry.attempt === attempt ? { ...entry, ...patch } : entry,
    );
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
      runCount: state.runCount,
      maxRuns: state.maxRuns,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      error: state.error,
    });
  }

  private snapshotNodes(): PipelineGraphNodeState[] {
    return [...this.nodes.values()].map(({ result: _result, ...state }) => ({
      ...state,
      dependsOn: [...state.dependsOn],
      attempts: state.attempts.map((attempt) => ({ ...attempt })),
    }));
  }

  private snapshotResults(): PipelineGraphPipelineResult[] {
    return [...this.nodes.values()].map((state) => ({
      pipelineId: state.pipelineId,
      path: state.path,
      dependsOn: [...state.dependsOn],
      status: state.status,
      runId: state.runId,
      runCount: state.runCount,
      maxRuns: state.maxRuns,
      attempts: state.attempts.map((attempt) => ({ ...attempt })),
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
  readonly lifecycle?: PipelineGraphPipelineLifecycle;
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
      lifecycle: options.lifecycle,
    });
    return this;
  }

  toConfig(): PipelineGraphConfig {
    return {
      kind: 'graph',
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
  validateUnknownFields(
    config as unknown as Record<string, unknown>,
    WORKFLOW_FIELDS,
    '',
    'workflow',
    errors,
  );
  errors.push(...validateDeclaredSdkRequirement(config.requires, 'requires', 'workflow'));
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

function validateGraphPipelineConfigs(
  config: PipelineGraphConfig,
  workDir: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Array.isArray(config.pipelines)) return errors;

  config.pipelines.forEach((pipeline, index) => {
    if (!isRecord(pipeline)) return;
    const graphNode = pipeline as { config?: unknown; cwd?: unknown };
    if (
      !graphNode.config ||
      typeof graphNode.config !== 'object' ||
      Array.isArray(graphNode.config)
    ) {
      errors.push({
        path: `pipelines[${index}].config`,
        message: 'pipeline config is required',
      });
      return;
    }

    const hasCwd = graphNode.cwd !== undefined;
    const validCwd =
      !hasCwd || (typeof graphNode.cwd === 'string' && graphNode.cwd.trim().length > 0);
    if (!validCwd) {
      errors.push({
        path: `pipelines[${index}].cwd`,
        message: 'pipeline cwd must be a non-empty string',
      });
    }

    let pipelineWorkDir = workDir;
    if (validCwd && typeof graphNode.cwd === 'string') {
      try {
        pipelineWorkDir = graphPipelineWorkDir(graphNode.cwd, workDir);
      } catch (err) {
        errors.push({
          path: `pipelines[${index}].cwd`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const diagnostic of validateConfigDiagnostics(
      graphNode.config as PipelineConfig,
      pipelineWorkDir,
    )) {
      errors.push({
        path: `pipelines[${index}].config.${diagnostic.path}`,
        message: diagnostic.message,
      });
    }
  });

  return errors;
}

function graphPipelineWorkDir(cwd: string | undefined, workDir: string): string {
  if (cwd === undefined) return workDir;
  if (isAbsolute(cwd)) return resolve(cwd);
  return validatePath(cwd, workDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateUnknownFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  basePath: string,
  label: string,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) return;
  for (const field of Object.keys(value)) {
    if (allowed.has(field)) continue;
    errors.push({
      path: basePath ? `${basePath}.${field}` : field,
      message: `Unknown ${label} field "${field}"`,
    });
  }
}

function validateGraphHeader(
  config: Pick<PipelineGraphConfig, 'kind' | 'name' | 'max_concurrency' | 'failure_policy'>,
  errors: ValidationError[],
): void {
  if (config.kind !== undefined && !VALID_WORKFLOW_KINDS.has(config.kind)) {
    errors.push({ path: 'kind', message: 'workflow.kind must be "workflow" or "graph"' });
  }
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
  pipelines: readonly unknown[],
  errors: ValidationError[],
  requirePath: boolean,
): void {
  const seen = new Set<string>();
  const ids = new Set<string>();

  pipelines.forEach((pipeline, index) => {
    const path = `pipelines[${index}]`;
    if (!isRecord(pipeline)) {
      errors.push({ path, message: 'Pipeline node must be an object' });
      return;
    }
    validateUnknownFields(
      pipeline,
      requirePath ? RAW_WORKFLOW_PIPELINE_FIELDS : GRAPH_PIPELINE_FIELDS,
      path,
      'workflow pipeline',
      errors,
    );
    const node = pipeline as unknown as RawWorkflowPipelineConfig | PipelineGraphPipelineConfig;
    if (typeof node.id !== 'string' || node.id.trim().length === 0) {
      errors.push({ path: `${path}.id`, message: 'Pipeline id is required' });
    } else if (!isValidTaskId(node.id)) {
      errors.push({
        path: `${path}.id`,
        message: `Pipeline id "${node.id}" is invalid`,
      });
    } else if (seen.has(node.id)) {
      errors.push({ path: `${path}.id`, message: `Duplicate pipeline id "${node.id}"` });
    } else {
      seen.add(node.id);
      ids.add(node.id);
    }

    const pipelinePath = node.path;
    if (requirePath || pipelinePath !== undefined) {
      validateWorkflowPath(pipelinePath, path, errors);
    }
    validateWorkflowPosition(node.position, path, errors);
    validatePipelineLifecycle(node.lifecycle, path, errors);
  });

  pipelines.forEach((pipeline, index) => {
    if (!isRecord(pipeline)) return;
    const node = pipeline as unknown as RawWorkflowPipelineConfig | PipelineGraphPipelineConfig;
    const deps = node.depends_on;
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
          message: `Pipeline "${node.id}" depends_on "${dep}" - no such pipeline found`,
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
  const pos = value as Record<string, unknown>;
  validateUnknownFields(
    pos,
    WORKFLOW_POSITION_FIELDS,
    `${basePath}.position`,
    'workflow position',
    errors,
  );
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

function validatePipelineLifecycle(
  value: unknown,
  basePath: string,
  errors: ValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: `${basePath}.lifecycle`, message: 'lifecycle must be an object' });
    return;
  }
  const lifecycle = value as Record<string, unknown> & PipelineGraphPipelineLifecycle;
  validateUnknownFields(
    lifecycle,
    PIPELINE_LIFECYCLE_FIELDS,
    `${basePath}.lifecycle`,
    'workflow lifecycle',
    errors,
  );
  if (
    lifecycle.max_runs !== undefined &&
    lifecycle.max_runs !== 'infinite' &&
    (!Number.isInteger(lifecycle.max_runs) || lifecycle.max_runs < 1)
  ) {
    errors.push({
      path: `${basePath}.lifecycle.max_runs`,
      message: 'lifecycle.max_runs must be a positive integer or "infinite"',
    });
  }
  if (lifecycle.stop_when !== undefined && !VALID_PIPELINE_STOP_WHEN.has(lifecycle.stop_when)) {
    errors.push({
      path: `${basePath}.lifecycle.stop_when`,
      message: 'lifecycle.stop_when must be "success", "failure", or "always"',
    });
  }
}

function normalizePipelineLifecycle(
  lifecycle: PipelineGraphPipelineLifecycle | undefined,
): NormalizedPipelineLifecycle {
  return {
    max_runs: normalizeMaxRuns(lifecycle?.max_runs),
    stop_when: lifecycle?.stop_when ?? 'success',
  };
}

function normalizeMaxRuns(value: PipelineGraphMaxRuns | undefined): number | null {
  if (value === 'infinite') return null;
  return value ?? 1;
}

function stripDefaultLifecycle(
  lifecycle: PipelineGraphPipelineLifecycle,
): PipelineGraphPipelineLifecycle {
  return {
    ...(lifecycle.max_runs !== undefined ? { max_runs: lifecycle.max_runs } : {}),
    ...(lifecycle.stop_when !== undefined ? { stop_when: lifecycle.stop_when } : {}),
  };
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

function detectPipelineCycles(pipelines: readonly unknown[]): ValidationError[] {
  const pipelineNodes = pipelines.filter(isRecord) as unknown as readonly (
    | RawWorkflowPipelineConfig
    | PipelineGraphPipelineConfig
  )[];
  const ids = new Set(
    pipelineNodes
      .map((pipeline) => pipeline.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const depsById = new Map<string, string[]>();
  for (const pipeline of pipelineNodes) {
    if (!ids.has(pipeline.id)) continue;
    depsById.set(
      pipeline.id,
      Array.isArray(pipeline.depends_on)
        ? pipeline.depends_on.filter((dep): dep is string => ids.has(dep))
        : [],
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
