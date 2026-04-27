// ═══ @tagma/types ═══
//
// Shared type surface for the tagma-sdk engine, the editor server, and
// the editor client. Plugins depend on this so they stay decoupled from
// the engine's internal modules while remaining type-synchronized with it.
//
// Runtime code is kept to an absolute minimum — currently one protocol
// constant (TASK_LOG_CAP) that must agree across SDK + server + client
// (see "Wire Protocol Constants" below). Everything else here is types.

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

export type PipelineExecutionMode = 'trusted' | 'safe';

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

// ═══ Binding Types ═══
//
// `inputs` / `outputs` are the public task-level dataflow model. Optional
// `type` metadata turns a binding into a strict, coerced contract; omitted
// `type` keeps the binding as a lightweight pass-through value.
//
// `PortDef` / `TaskPorts` are internal prompt-contract shapes used by core
// dataflow inference helpers. YAML task configs expose typed `inputs` /
// `outputs`; there is no public `ports` field.

export type PortType = 'string' | 'number' | 'boolean' | 'enum' | 'json';

export interface PortDef {
  readonly name: string;
  readonly type: PortType;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  /**
   * Optional explicit upstream binding. Accepts either a bare port name
   * (must be unambiguous among the task's direct upstreams) or a
   * fully-qualified `taskId.portName` reference. Only meaningful for
   * inputs. Unset = match by name against all direct upstream outputs,
   * with ambiguity flagged at validation time.
   */
  readonly from?: string;
}

export interface TaskPorts {
  readonly inputs?: readonly PortDef[];
  readonly outputs?: readonly PortDef[];
}

// Unified task-level bindings. `type` is optional: omit it for lightweight
// pass-through values, add it when the task wants a strict public I/O contract.
export interface TaskInputBinding {
  /** Literal value. When set, it wins over `from`. */
  readonly value?: unknown;
  /**
   * Source expression. Supported forms:
   *   - `taskId.outputs.name`
   *   - `taskId.stdout`
   *   - `taskId.stderr`
   *   - `taskId.normalizedOutput`
   *   - `outputs.name` (name-match across direct upstream outputs)
   */
  readonly from?: string;
  /** Fallback when `from` is missing or unresolved. */
  readonly default?: unknown;
  /** When true, unresolved values block the task before it starts. */
  readonly required?: boolean;
  readonly type?: PortType;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface TaskOutputBinding {
  /** Literal value. When set, it wins over `from`. */
  readonly value?: unknown;
  /**
   * Output source. Defaults to `json.<outputName>`.
   * Supported forms: `json.name`, `stdout`, `stderr`, `normalizedOutput`.
   */
  readonly from?: string;
  /** Fallback when the selected source is missing. */
  readonly default?: unknown;
  readonly type?: PortType;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export type TaskInputBindings = Readonly<Record<string, TaskInputBinding>>;
export type TaskOutputBindings = Readonly<Record<string, TaskOutputBinding>>;

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
  readonly inputs?: TaskInputBindings;
  readonly outputs?: TaskOutputBindings;
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
  readonly inputs?: TaskInputBindings;
  readonly outputs?: TaskOutputBindings;
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
  readonly mode?: PipelineExecutionMode;
  readonly driver?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
  readonly timeout?: string;
  readonly plugins?: readonly string[];
  readonly hooks?: HooksConfig;
  readonly tracks: readonly TrackConfig[];
}

// ═══ Raw Pipeline Config (from YAML) ═══

export interface RawPipelineConfig {
  readonly name: string;
  readonly mode?: PipelineExecutionMode;
  readonly driver?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly permissions?: Permissions;
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

// ═══ Runtime Boundary ═══

export type EnvPolicy =
  | { readonly mode: 'minimal' }
  | { readonly mode: 'inherit' }
  | { readonly mode: 'allowlist'; readonly keys: readonly string[] };

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly maxStdoutTailBytes?: number;
  readonly maxStderrTailBytes?: number;
  readonly envPolicy?: EnvPolicy;
}

export type RuntimeWatchEventType = 'ready' | 'add' | 'change' | 'unlink';

export interface RuntimeWatchEvent {
  readonly type: RuntimeWatchEventType;
  /**
   * Runtime-specific path for the event. Bun runtime returns the same path
   * shape chokidar emits, so callers that pass `cwd` receive paths relative
   * to that directory.
   */
  readonly path: string;
}

export interface RuntimeWatchOptions {
  readonly cwd?: string;
  readonly depth?: number;
  readonly ignoreInitial?: boolean;
  readonly awaitWriteFinishMs?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeLogSink {
  readonly path: string;
  readonly dir: string;
  append(line: string): void;
  close(): void;
}

export interface OpenRunLogOptions {
  readonly workDir: string;
  readonly runId: string;
  readonly header: string;
}

export interface TaskOutputPathOptions {
  readonly workDir: string;
  readonly runId: string;
  readonly taskId: string;
  readonly stream: 'stdout' | 'stderr';
}

export interface PruneLogOptions {
  readonly workDir: string;
  readonly keep: number;
  readonly excludeRunId: string;
}

export interface RuntimeLogStore {
  openRunLog(options: OpenRunLogOptions): RuntimeLogSink;
  taskOutputPath(options: TaskOutputPathOptions): string;
  logsDir(workDir: string): string;
  prune?(options: PruneLogOptions): Promise<void>;
}

export interface TagmaRuntime {
  runSpawn(spec: SpawnSpec, driver: DriverPlugin | null, options?: RunOptions): Promise<TaskResult>;
  runCommand(command: string, cwd: string, options?: RunOptions): Promise<TaskResult>;
  ensureDir(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  watch(path: string, options?: RuntimeWatchOptions): AsyncIterable<RuntimeWatchEvent>;
  readonly logStore: RuntimeLogStore;
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
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
  readonly normalizedOutput?: string; // canonical text for continue_from handoff
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

// ═══ Prompt Document ═══
//
// Structured view of the prompt being assembled for a task. Replaces the
// historical "just a string" model at the middleware/driver boundary.
// Middlewares add labeled context blocks to `contexts`; the user's task
// instruction sits in `task` and should not be mutated. At driver time,
// either read `ctx.promptDoc` directly for structured access, or read
// `task.prompt` which the engine pre-serializes into the default format
// (blocks prepended, blank-line separated, no implicit [Task] header).

export interface PromptContextBlock {
  /** Section label rendered as `[<label>]` above the content. */
  readonly label: string;
  /** Context body — raw text. Serializer does not escape anything. */
  readonly content: string;
}

export interface PromptDocument {
  /** Ordered context blocks; serializer prepends them before `task`. */
  readonly contexts: ReadonlyArray<PromptContextBlock>;
  /** The user's original task instruction. Middlewares MUST preserve this. */
  readonly task: string;
}

// ═══ Driver Context ═══

export interface DriverContext {
  readonly sessionMap: Map<string, string>;
  // Canonical text for continue_from handoff (driver-normalized).
  readonly normalizedMap: Map<string, string>;
  readonly workDir: string;
  /**
   * Structured prompt after the middleware chain has run. Drivers may
   * either read this for fine-grained control over serialization (e.g.
   * inserting `[Previous Output]` between contexts and task for
   * continue_from text-fallback) or ignore it and read `task.prompt`,
   * which the engine pre-serializes via `serializePromptDocument(doc)`.
   */
  readonly promptDoc: PromptDocument;
  /**
   * Resolved port inputs for the current task. Keyed by input port name,
   * coerced to the declared port type. Defaults/optional-missing values
   * have already been applied — drivers can treat this as authoritative.
   * Empty object when the task declares no inputs.
   *
   * Drivers that need to re-render `{{inputs.foo}}` placeholders
   * themselves (e.g. when they wrap `task.prompt` in a custom envelope
   * and want substitution to happen inside their envelope instead of
   * before it) should read this map and call
   * `substituteInputs(text, inputs)` from `@tagma/sdk`. The default
   * engine path substitutes upfront, so most drivers can ignore this.
   */
  readonly inputs: Readonly<Record<string, unknown>>;
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
  | {
      readonly type: 'resolved';
      readonly request: ApprovalRequest;
      readonly decision: ApprovalDecision;
    }
  | { readonly type: 'expired'; readonly request: ApprovalRequest }
  | { readonly type: 'aborted'; readonly request: ApprovalRequest; readonly reason: string };

export type ApprovalListener = (event: ApprovalEvent) => void;

export interface ApprovalGateway {
  request(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequestHandle;
  resolve(
    approvalId: string,
    decision: Omit<ApprovalDecision, 'approvalId' | 'decidedAt'>,
  ): boolean;
  pending(): readonly ApprovalRequest[];
  subscribe(listener: ApprovalListener): () => void;
  abortAll(reason: string): void;
}

export interface ApprovalRequestHandle {
  readonly request: ApprovalRequest;
  readonly decision: Promise<ApprovalDecision>;
  abort(reason: string): void;
}

// ═══ Trigger Plugin ═══

export interface TriggerContext {
  readonly taskId: string;
  readonly trackId: string;
  readonly workDir: string;
  readonly signal: AbortSignal;
  readonly approvalGateway: ApprovalGateway;
  readonly runtime: TagmaRuntime;
}

export interface TriggerWatchHandle {
  readonly fired: Promise<unknown>;
  dispose(reason?: string): void | Promise<void>;
}

export class TriggerBlockedError extends Error {
  readonly code = 'TRIGGER_BLOCKED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerBlockedError';
  }
}

export class TriggerTimeoutError extends Error {
  readonly code = 'TRIGGER_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerTimeoutError';
  }
}

export interface TriggerPlugin {
  readonly name: string;
  /**
   * Starts the trigger watcher and returns a handle owned by the engine.
   * `fired` resolves when the trigger condition is met. `dispose()` must
   * release every watcher/listener/server/approval resource, even when
   * `fired` has not settled. The engine calls it on success, failure,
   * task timeout, and pipeline abort.
   */
  readonly schema?: PluginSchema;
  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle;
}

// ═══ Completion Plugin ═══

export interface CompletionContext {
  readonly workDir: string;
  readonly signal?: AbortSignal;
  readonly runtime: TagmaRuntime;
  readonly envPolicy?: EnvPolicy;
}

export interface CompletionPlugin {
  readonly name: string;
  readonly schema?: PluginSchema;
  check(
    config: Record<string, unknown>,
    result: TaskResult,
    ctx: CompletionContext,
  ): Promise<boolean>;
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
  /**
   * Augment the structured `PromptDocument` and return a new document.
   * Middlewares run in declaration order; each receives the previous output.
   *
   * Composition contract: append context blocks and preserve `doc.task`
   * unless the middleware deliberately transforms the user's instruction.
   */
  enhanceDoc(
    doc: PromptDocument,
    config: Record<string, unknown>,
    ctx: MiddlewareContext,
  ): Promise<PromptDocument>;
}

// ═══ Capability Plugin Packages ═══

export type CapabilityHandler = DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;

export interface PluginCapabilities {
  readonly drivers?: Readonly<Record<string, DriverPlugin>>;
  readonly triggers?: Readonly<Record<string, TriggerPlugin>>;
  readonly completions?: Readonly<Record<string, CompletionPlugin>>;
  readonly middlewares?: Readonly<Record<string, MiddlewarePlugin>>;
}

export interface TagmaPlugin {
  readonly name: string;
  readonly capabilities?: PluginCapabilities;
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
export type TaskFailureKind = 'timeout' | 'spawn_error' | 'exit_nonzero' | 'parse_error' | null;

export interface TaskResult {
  readonly exitCode: number;
  /**
   * Bounded tail of the child's stdout. When the child produced more than
   * the configured cap (see `RunOptions.maxStdoutTailBytes` in the SDK),
   * this is only the LAST `cap` bytes and is prefixed with a marker like
   * `[...N bytes truncated from head — full output: <path>]`. The full
   * content is at `stdoutPath` on disk.
   */
  readonly stdout: string;
  /** Same contract as `stdout` but for stderr; see `stderrPath`. */
  readonly stderr: string;
  /**
   * Absolute path to the full stdout on disk. Set by the SDK runner when
   * the caller provides `RunOptions.stdoutPath` (the engine always does).
   * Null when output wasn't persisted (pre-spawn failures, memory-only
   * callers). The file is exactly what the child wrote — byte-identical.
   */
  readonly stdoutPath: string | null;
  /** Same contract as `stdoutPath` but for stderr. */
  readonly stderrPath: string | null;
  /**
   * Total bytes the child wrote to stdout before tail-truncation, so UIs
   * can display "32 MB (truncated)" without re-stat'ing the file.
   * Undefined on legacy TaskResult literals predating streaming.
   */
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly durationMs: number;
  readonly sessionId: string | null;
  readonly normalizedOutput: string | null;
  readonly failureKind: TaskFailureKind;
  /**
   * Published output values — populated by the engine after a task terminates
   * successfully when `task.outputs` are declared or when a prompt task has an
   * inferred output contract from downstream typed inputs.
   * `null` = task had no declared or inferred outputs.
   */
  readonly outputs?: Readonly<Record<string, unknown>> | null;
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

export interface CapabilityPluginModule {
  readonly default: TagmaPlugin;
}

export type PluginModule = CapabilityPluginModule;

/**
 * Manifest a plugin package MUST declare under the `tagmaPlugin` field of
 * its `package.json`. The presence of this field is the canonical signal
 * that a package is a tagma pipeline plugin (not a library or
 * unrelated helper sharing the same npm scope). Auto-discovery in hosts
 * reads only `package.json` and trusts this field — no module import
 * required, which is both faster and safer (no top-level side effects).
 *
 * The manifest MUST stay in sync with the capability key the package
 * provides (for example `capabilities.drivers.codex`). Multi-capability
 * packages may choose the primary capability they want discovery UIs to show.
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

// ═══ Wire Protocol: Run Events ═══
//
// The engine, editor server, and editor client all speak the same event
// vocabulary for a pipeline run. Earlier revisions maintained three
// separate type families (SDK `PipelineEvent`, server `RunEvent`, client
// `RunEvent`) plus a translation layer in `run.ts` — this was a source of
// drift bugs and is replaced by the unified types below.
//
// Contract:
//   - The SDK engine emits `RunEventPayload` values through `runPipeline`'s
//     `onEvent` callback. Every payload carries a `runId` (domain id);
//     the SDK does not stamp `seq`.
//   - The editor server's `RunSession` stamps each broadcast with a
//     monotonic per-run `seq`, producing `WireRunEvent`. The server also
//     emits `run_snapshot` (server-only: payload shape isn't something the
//     SDK produces) as part of the same wire union.
//   - The client folds `WireRunEvent` values through a pure reducer. Dedup
//     is keyed by `(runId, seq)` — when `runId` changes, the reducer
//     discards the previous run's seq high-water mark and adopts the new
//     one. This removes the cross-run stale-seq hazard that existed while
//     `seq` was a single global counter.

// ═══ Wire Protocol Constants ═══

/**
 * Protocol version for the SSE event stream between the editor server and
 * the editor client. Bumped whenever the wire shape of RunEventPayload or
 * WireRunEvent changes incompatibly. The server echoes this on connect
 * (header `X-Tagma-Run-Protocol`) and the client refuses to fold events
 * from a mismatched server. This is the forward-compat seam we use
 * instead of trying to keep every old shape working.
 */
export const RUN_PROTOCOL_VERSION = 1;

/**
 * Maximum log lines retained per task (and for pipeline-level logs) in the
 * SSE snapshot buffer on the server and in the reducer on the client. The
 * two must agree — divergence silently hides log lines. Defined here so
 * the SDK, server, and client all import the same value.
 */
export const TASK_LOG_CAP = 500;

// ═══ Task Log Line ═══

export type TaskLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet';

export interface TaskLogLine {
  readonly level: TaskLogLevel;
  /** HH:MM:SS.mmm — mirrors pipeline.log formatting. */
  readonly timestamp: string;
  /** Fully-formatted line as written to the log file. */
  readonly text: string;
}

// ═══ Wire Task State ═══
//
// Projection of the engine's internal `TaskState` onto the wire. Flat
// shape (no nested `result`) so the reducer can merge partial updates
// with `??` semantics. Mirrors the existing `RunTaskState` the editor
// client used to declare locally.

export interface RunTaskState {
  readonly taskId: string;
  readonly trackId: string;
  readonly taskName: string;
  readonly status: TaskStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutPath: string | null;
  readonly stderrPath: string | null;
  readonly stdoutBytes: number | null;
  readonly stderrBytes: number | null;
  readonly sessionId: string | null;
  readonly normalizedOutput: string | null;
  /**
   * Extracted port output values for this task. Null until the task
   * completes successfully, or when the task declares no output ports.
   * Carried on the wire so the editor can render resolved port values
   * on node bubbles and so downstream nodes' "inputs" panels can be
   * populated live as a run progresses.
   */
  readonly outputs: Readonly<Record<string, unknown>> | null;
  /**
   * Resolved port inputs for this task — the values that the engine
   * substituted into placeholders / rendered into the `[Inputs]` block.
   * Exposed primarily for the editor's task-panel; stays null until the
   * task starts.
   */
  readonly inputs: Readonly<Record<string, unknown>> | null;
  /** Resolved after inheritance. Null until the task starts. */
  readonly resolvedDriver: string | null;
  readonly resolvedModel: string | null;
  readonly resolvedPermissions: Permissions | null;
  /** Streamed log lines. Capped at TASK_LOG_CAP. */
  readonly logs: readonly TaskLogLine[];
  /** Running total of log lines emitted (including dropped tail-truncated ones). */
  readonly totalLogCount: number;
}

// ═══ Approval Info (wire alias) ═══
//
// The editor historically called this `ApprovalRequestInfo`. Shape is
// identical to `ApprovalRequest`; kept as an alias for readability at
// the wire layer.

export type ApprovalRequestInfo = ApprovalRequest;

// ═══ Abort Reason ═══
//
// When `run_end` fires with `success: false`, `abortReason` disambiguates
// WHY. Null means the pipeline ran to completion but contained failed
// tasks. `timeout` means the pipeline hit its own timeout. `stop_all`
// means a task failed with `on_failure: stop_all`. `external` means the
// host (editor abort button, SIGINT, etc.) aborted the run.
export type AbortReason = 'timeout' | 'stop_all' | 'external';

// ═══ SDK-Emitted Event Payloads ═══
//
// The engine emits these through `runPipeline`'s `onEvent` callback.
// Every payload carries a `runId` for routing; the server stamps a
// per-run `seq` before broadcasting, producing a `WireRunEvent`.

export type RunEventPayload =
  | {
      readonly type: 'run_start';
      readonly runId: string;
      readonly tasks: readonly RunTaskState[];
    }
  | {
      readonly type: 'task_update';
      readonly runId: string;
      readonly taskId: string;
      readonly status: TaskStatus;
      readonly startedAt?: string;
      readonly finishedAt?: string;
      readonly durationMs?: number;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly stdoutPath?: string | null;
      readonly stderrPath?: string | null;
      readonly stdoutBytes?: number | null;
      readonly stderrBytes?: number | null;
      readonly sessionId?: string | null;
      readonly normalizedOutput?: string | null;
      readonly outputs?: Readonly<Record<string, unknown>> | null;
      readonly inputs?: Readonly<Record<string, unknown>> | null;
      readonly resolvedDriver?: string | null;
      readonly resolvedModel?: string | null;
      readonly resolvedPermissions?: Permissions | null;
    }
  | {
      readonly type: 'task_log';
      readonly runId: string;
      readonly taskId: string | null;
      readonly level: TaskLogLevel;
      readonly timestamp: string;
      readonly text: string;
    }
  | {
      readonly type: 'run_end';
      readonly runId: string;
      readonly success: boolean;
      /**
       * Non-null when the run did not complete on its own steam.
       * Historically this was carried separately via a hardcoded string
       * in the pipeline_error hook — now it's part of the event and the
       * hook payload derives from the same value.
       */
      readonly abortReason: AbortReason | null;
    }
  | {
      readonly type: 'run_error';
      readonly runId: string;
      readonly error: string;
    }
  | {
      readonly type: 'approval_request';
      readonly runId: string;
      readonly request: ApprovalRequestInfo;
    }
  | {
      readonly type: 'approval_resolved';
      readonly runId: string;
      readonly requestId: string;
      readonly outcome: ApprovalOutcome;
    };

// ═══ Server-Only Event Payload ═══
//
// Emitted by the editor server on SSE (re)connect so a client can rebuild
// its task map + pending approvals + pipeline-level logs even after the
// bounded replay buffer has dropped older events. Not produced by the SDK.

export interface RunSnapshotPayload {
  readonly type: 'run_snapshot';
  readonly runId: string;
  readonly tasks: readonly RunTaskState[];
  readonly pendingApprovals: readonly ApprovalRequestInfo[];
  /**
   * Pipeline-level log lines (taskId=null on the original task_log event).
   * Server aggregates these into a bounded buffer alongside per-task logs
   * so a reconnecting client can reconstruct header/DAG-topology output.
   */
  readonly pipelineLogs: readonly TaskLogLine[];
}

// ═══ Wire Event (stamped) ═══
//
// The on-the-wire event that the server broadcasts and the client folds.
// Every variant has `runId` and `seq`. Client dedup is keyed by
// `(runId, seq)`: when `runId` changes, the reducer resets its high-water
// mark — no cross-run stale-seq hazard possible.

export type WireRunEvent = (RunEventPayload | RunSnapshotPayload) & {
  readonly seq: number;
};

// ═══ Runtime Utilities ═══
export { parseDurationSafe } from './duration.js';
