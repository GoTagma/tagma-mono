// ═══ @tagma/types ═══
//
// Shared type surface for the tagma-sdk engine and all plugins.
// This package contains ONLY types — no runtime code, no constants.
// Plugins depend on this so they stay decoupled from the engine's
// internal modules while remaining type-synchronized with it.

// ═══ Task Status ═══

export type TaskStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'blocked';

/**
 * What to do when a task in this track fails.
 *  - `ignore`          : downstream tasks see the failure as success (best-effort).
 *  - `skip_downstream` : downstream tasks of the failed task get marked skipped.
 *  - `stop_all`        : H3 — abort the *entire pipeline* (signals the abort
 *                        controller, marks every still-waiting task as
 *                        skipped). Up until 2026-04 this only stopped the
 *                        track containing the failure, which contradicted
 *                        the name and surprised users.
 */
export type OnFailure = 'ignore' | 'skip_downstream' | 'stop_all';

// ═══ Permissions ═══

export interface Permissions {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

// ═══ Plugin Schema ═══
//
// Declarative metadata a plugin can expose so editors/UIs can render a typed
// form for its config instead of falling back to a raw key/value editor.
// Schema is purely descriptive — plugins still perform their own runtime
// validation. Declaring a field here is optional.

export type PluginParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'path'
  | 'duration'
  | 'number-or-list';

export interface PluginParamDef {
  readonly type: PluginParamType;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
}

export interface PluginSchema {
  readonly description?: string;
  readonly fields: Readonly<Record<string, PluginParamDef>>;
}

// ═══ Trigger / Completion / Middleware Configs ═══

export interface TriggerConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CompletionConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface MiddlewareConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

// ═══ Task Config (after inheritance resolution) ═══

export interface TaskConfig {
  readonly id: string;
  readonly name: string;
  readonly prompt?: string;
  readonly command?: string;
  readonly depends_on?: readonly string[];
  readonly trigger?: TriggerConfig;
  readonly continue_from?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly timeout?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly completion?: CompletionConfig;
  readonly agent_profile?: string;
  readonly cwd?: string;
}

// ═══ Raw Task Config (from YAML, before inheritance) ═══

export interface RawTaskConfig {
  readonly id: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly command?: string;
  readonly depends_on?: readonly string[];
  readonly trigger?: TriggerConfig;
  readonly continue_from?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly timeout?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly completion?: CompletionConfig;
  readonly agent_profile?: string;
  readonly cwd?: string;
}

// ═══ Track Config ═══

export interface TrackConfig {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly agent_profile?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly cwd?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly on_failure?: OnFailure;
  readonly tasks: readonly TaskConfig[];
}

// ═══ Raw Track Config (from YAML) ═══

export interface RawTrackConfig {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly agent_profile?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
  readonly driver?: string;
  readonly cwd?: string;
  readonly middlewares?: readonly MiddlewareConfig[];
  readonly on_failure?: OnFailure;
  readonly tasks: readonly RawTaskConfig[];
}

// ═══ Hooks Config ═══

export type HookCommand = string | readonly string[];

export interface HooksConfig {
  readonly pipeline_start?: HookCommand;
  readonly task_start?: HookCommand;
  readonly task_success?: HookCommand;
  readonly task_failure?: HookCommand;
  readonly pipeline_complete?: HookCommand;
  readonly pipeline_error?: HookCommand;
}

// ═══ Pipeline Config ═══

export interface PipelineConfig {
  readonly name: string;
  readonly driver?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly timeout?: string;
  readonly plugins?: readonly string[];
  readonly hooks?: HooksConfig;
  readonly tracks: readonly TrackConfig[];
}

// ═══ Raw Pipeline Config (from YAML) ═══

export interface RawPipelineConfig {
  readonly name: string;
  readonly driver?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly timeout?: string;
  readonly plugins?: readonly string[];
  readonly hooks?: HooksConfig;
  readonly tracks: readonly RawTrackConfig[];
}

// ═══ SpawnSpec: Driver returns this to Engine ═══

export interface SpawnSpec {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

// ═══ Driver Capabilities ═══

export interface DriverCapabilities {
  readonly sessionResume: boolean;
  readonly systemPrompt: boolean;
  readonly outputFormat: boolean;
}

// ═══ Driver Result Metadata ═══

export interface DriverResultMeta {
  readonly sessionId?: string;
  readonly normalizedOutput?: string;  // canonical text for continue_from handoff
  /**
   * M12: drivers can mark a task as failed even when the underlying process
   * exited 0. Common case: the CLI returns `{type:"error"}` JSON with exit
   * code 0 (opencode does this for transient API failures). Engine.ts
   * inspects this flag in step 6 (terminal status determination) and treats
   * a true value as if the exitCode were non-zero, with the optional
   * `forceFailureReason` appended to stderr for visibility.
   */
  readonly forceFailure?: boolean;
  readonly forceFailureReason?: string;
}

// ═══ Driver Context ═══

export interface DriverContext {
  readonly sessionMap: Map<string, string>;
  // Canonical text for continue_from handoff (driver-normalized).
  readonly normalizedMap: Map<string, string>;
  readonly workDir: string;
}

// ═══ Driver Plugin ═══

export interface DriverPlugin {
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  buildCommand(task: TaskConfig, track: TrackConfig, ctx: DriverContext): Promise<SpawnSpec>;
  parseResult?(stdout: string, stderr?: string): DriverResultMeta;
  resolveModel?(): string;
  resolveTools?(permissions: Permissions): string;
}

// ═══ Approval (used by Trigger plugins) ═══

export interface ApprovalRequest {
  readonly id: string;
  readonly taskId: string;
  readonly trackId?: string;
  readonly message: string;
  readonly createdAt: string;
  readonly timeoutMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout' | 'aborted';

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  readonly actor?: string;
  readonly reason?: string;
  readonly decidedAt: string;
}

export type ApprovalEvent =
  | { readonly type: 'requested'; readonly request: ApprovalRequest }
  | { readonly type: 'resolved'; readonly request: ApprovalRequest; readonly decision: ApprovalDecision }
  | { readonly type: 'expired'; readonly request: ApprovalRequest }
  | { readonly type: 'aborted'; readonly request: ApprovalRequest; readonly reason: string };

export type ApprovalListener = (event: ApprovalEvent) => void;

export interface ApprovalGateway {
  request(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): Promise<ApprovalDecision>;
  resolve(
    approvalId: string,
    decision: Omit<ApprovalDecision, 'approvalId' | 'decidedAt'>,
  ): boolean;
  pending(): readonly ApprovalRequest[];
  subscribe(listener: ApprovalListener): () => void;
  abortAll(reason: string): void;
}

// ═══ Trigger Plugin ═══

export interface TriggerContext {
  readonly taskId: string;
  readonly trackId: string;
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly approvalGateway: ApprovalGateway;
}

export interface TriggerPlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown>;
}

// ═══ Completion Plugin ═══

export interface CompletionContext {
  readonly workDir: string;
  readonly signal?: AbortSignal;
}

export interface CompletionPlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  check(config: Record<string, unknown>, result: TaskResult, ctx: CompletionContext): Promise<boolean>;
}

// ═══ Middleware Plugin ═══

export interface MiddlewareContext {
  readonly task: TaskConfig;
  readonly track: TrackConfig;
  readonly workDir: string;
}

export interface MiddlewarePlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  enhance(prompt: string, config: Record<string, unknown>, ctx: MiddlewareContext): Promise<string>;
}

// ═══ Task Result ═══

/**
 * H2: distinguishes the *reason* a task didn't return exitCode 0. The legacy
 * `exitCode === -1` overload was used by both timeout and pre-spawn errors
 * (e.g. ENOENT, bad SpawnSpec), which made spawn failures display as
 * "timeout" in the UI. Engines and UIs should branch on `failureKind`
 * instead of inferring from `exitCode`.
 *
 * `null` means "no failure" (success case).
 */
export type TaskFailureKind =
  | 'timeout'
  | 'spawn_error'
  | 'exit_nonzero'
  | null;

export interface TaskResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stderrPath: string | null;
  readonly durationMs: number;
  readonly sessionId: string | null;
  readonly normalizedOutput: string | null;
  /**
   * H2: optional for backward compatibility with existing TaskResult
   * literals scattered across drivers. New code (runner.ts, engine.ts)
   * always populates it. Defaults to `null` (success / no classification).
   */
  readonly failureKind?: TaskFailureKind;
}

// ═══ Runtime Task State (mutable engine state — exposed for hook context typing) ═══

export interface TaskState {
  readonly config: TaskConfig;
  readonly trackConfig: TrackConfig;
  status: TaskStatus;
  result: TaskResult | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ═══ Plugin Package Exports ═══

export type PluginCategory = 'drivers' | 'triggers' | 'completions' | 'middlewares';

export interface PluginModule {
  readonly pluginCategory: PluginCategory;
  readonly pluginType: string;
  readonly default: DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;
}

/**
 * Manifest a plugin package MUST declare under the `tagmaPlugin` field of
 * its `package.json`. The presence of this field is the canonical signal
 * that a package is a tagma pipeline plugin (not a library or
 * unrelated helper sharing the same npm scope). Auto-discovery in hosts
 * reads only `package.json` and trusts this field — no module import
 * required, which is both faster and safer (no top-level side effects).
 *
 * The manifest MUST stay in sync with the runtime exports (`pluginCategory`,
 * `pluginType`). Hosts may verify this on load and refuse to register a
 * plugin whose package.json and runtime contract disagree.
 *
 * Example `package.json`:
 *
 *     {
 *       "name": "@tagma/driver-codex",
 *       "version": "0.1.7",
 *       "tagmaPlugin": {
 *         "category": "drivers",
 *         "type": "codex"
 *       }
 *     }
 */
export interface PluginManifest {
  readonly category: PluginCategory;
  readonly type: string;
}
