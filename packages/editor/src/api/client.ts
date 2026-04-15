// ═══ Pipeline types — direct re-export from @tagma/types ═══
//
// Prior to 2026-04 this file hand-wrote a local copy of every pipeline
// shape (RawPipelineConfig, RawTaskConfig, Permissions, ...) and guarded
// against drift with a block of `_drift*` assertions at the bottom. With
// the monorepo in place, we consume `@tagma/types` directly so drift is
// impossible. The only adjustment we still make is stripping `readonly`
// — the Zustand-backed editor store uses spread-based updates and some
// call sites assign to entire slots, which doesn't compose with SDK's
// fully-readonly interfaces. Everything else flows through unchanged.
import type {
  Permissions as SdkPermissions,
  HookCommand as SdkHookCommand,
  HooksConfig as SdkHooksConfig,
  MiddlewareConfig as SdkMiddlewareConfig,
  TriggerConfig as SdkTriggerConfig,
  CompletionConfig as SdkCompletionConfig,
  RawPipelineConfig as SdkRawPipelineConfig,
  RawTrackConfig as SdkRawTrackConfig,
  RawTaskConfig as SdkRawTaskConfig,
  TaskStatus as SdkTaskStatus,
  ApprovalOutcome as SdkApprovalOutcome,
  ApprovalRequest as SdkApprovalRequest,
  DriverCapabilities as SdkDriverCapabilities,
  PluginCategory as SdkPluginCategory,
  TemplateParamDef as SdkTemplateParamDef,
} from '@tagma/types';

// Recursively strip `readonly` from object fields and array element
// wrappers. Primitives, unions of primitives, and untyped index
// signatures pass through unchanged.
type Mutable<T> =
  T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

export type Permissions = Mutable<SdkPermissions>;
export type HookCommand = Mutable<SdkHookCommand>;
export type HooksConfig = Mutable<SdkHooksConfig>;
export type RawPipelineConfig = Mutable<SdkRawPipelineConfig>;
export type RawTrackConfig = Mutable<SdkRawTrackConfig>;
export type RawTaskConfig = Mutable<SdkRawTaskConfig>;
export type DriverCapabilities = Mutable<SdkDriverCapabilities>;
export type TemplateParamDef = Mutable<SdkTemplateParamDef>;
export type TaskStatus = SdkTaskStatus;
export type ApprovalOutcome = SdkApprovalOutcome;
export type PluginCategory = SdkPluginCategory;

// The SDK's MiddlewareConfig / TriggerConfig / CompletionConfig are all
// `{ type: string; [key: string]: unknown }`. The named fields below are
// editor-side hints: they give us autocomplete in the form panels while
// still satisfying the SDK base's open index signature at the protocol
// level.
export type MiddlewareConfig = Mutable<SdkMiddlewareConfig> & {
  file?: string;
  label?: string;
};

export type TriggerConfig = Mutable<SdkTriggerConfig> & {
  message?: string;
  timeout?: string;
  path?: string;
  metadata?: Record<string, unknown>;
};

export type CompletionConfig = Mutable<SdkCompletionConfig> & {
  expect?: number | number[];
  path?: string;
  kind?: 'file' | 'dir' | 'any';
  min_size?: number;
  check?: string;
  timeout?: string;
};

// Historical alias — the editor UI surface names it `ApprovalRequestInfo`
// while the SDK calls it `ApprovalRequest`. Shape is identical.
export type ApprovalRequestInfo = Mutable<SdkApprovalRequest>;

const BASE = '/api';

/**
 * Serialize an object to JSON, converting undefined → null so the server
 * receives "clear this field" instead of silently dropping the key.
 * Single choke-point: every API method uses this instead of JSON.stringify.
 */
function jsonBody(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => (value === undefined ? null : value));
}

// ── Revision / ETag (C6) ──
//
// The server stamps every ServerState response with `revision: number`. The
// client caches the most-recently-observed revision here and attaches it as
// `If-Match: <revision>` to every mutation call. On 409 the server returns
// `{ error, currentState }`; `request()` converts that into a
// `RevisionConflictError` so callers (future pipeline-store work) can detect
// the conflict and replace local state with `currentState`.
//
// NOTE: pipeline-store is owned by a different refactor group and must NOT be
// touched in this cycle. The client support lives here so the store can
// consume it in a follow-up cycle.
let lastRevision: number | null = null;

export function getClientRevision(): number | null {
  return lastRevision;
}

export function setClientRevision(rev: number | null | undefined): void {
  if (typeof rev === 'number' && Number.isFinite(rev)) lastRevision = rev;
}

export class RevisionConflictError extends Error {
  readonly currentState: ServerState;
  readonly expected: number | null;
  readonly current: number;
  constructor(currentState: ServerState, expected: number | null, current: number) {
    super('revision mismatch');
    this.name = 'RevisionConflictError';
    this.currentState = currentState;
    this.expected = expected;
    this.current = current;
  }
}

function isMutation(options?: RequestInit): boolean {
  const m = (options?.method ?? 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Attach If-Match on mutations when we have a known revision.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (isMutation(options) && lastRevision !== null) {
    headers['If-Match'] = String(lastRevision);
  }

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 409) {
    // Revision conflict — parse payload and throw a typed error so future
    // pipeline-store work can detect and re-apply state.
    const payload = await res.json().catch(() => null) as {
      error?: string;
      expected?: number;
      current?: number;
      currentState?: ServerState;
    } | null;
    if (payload?.currentState) {
      setClientRevision(payload.currentState.revision);
      throw new RevisionConflictError(
        payload.currentState,
        typeof payload.expected === 'number' ? payload.expected : null,
        typeof payload.current === 'number' ? payload.current : -1,
      );
    }
    throw new Error(payload?.error ?? 'Revision conflict');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Promote server-supplied error kind to a typed property so callers can
    // render localized hints without scraping English substrings out of the
    // message body.
    const apiErr = new Error(err.error ?? 'Request failed') as Error & { kind?: string };
    if (typeof err.kind === 'string') apiErr.kind = err.kind;
    throw apiErr;
  }
  if (res.headers.get('content-type')?.includes('text/yaml')) {
    return (await res.text()) as unknown as T;
  }
  const data = await res.json();
  // Opportunistically pick up revision from any ServerState-shaped response.
  if (data && typeof data === 'object' && 'revision' in data && typeof (data as { revision?: unknown }).revision === 'number') {
    setClientRevision((data as { revision: number }).revision);
  }
  return data;
}

export interface EditorLayout {
  positions: Record<string, { x: number }>;
}

/**
 * Per-workspace editor preferences persisted in `.tagma/editor-settings.json`.
 * These are user-level toggles that don't belong in the pipeline YAML
 * (which is meant to be portable). Mirrors the server-side EditorSettings shape.
 */
export interface EditorSettings {
  /**
   * When true, opening a workspace will auto-install plugins declared in
   * the YAML's `plugins` array but missing from `node_modules`. Default off
   * because pulling arbitrary npm packages on YAML open is a security smell —
   * the user must opt in per workspace.
   */
  autoInstallDeclaredPlugins: boolean;
}

/**
 * Read-only snapshot of plugins declared anywhere in the current workspace
 * (every YAML in `.tagma/`) plus their install/load status. Used by the
 * Editor Settings panel to preview what Apply will do without triggering
 * any installs.
 */
export interface PluginDeclaredResult {
  /** Union of pipeline.plugins[] across every YAML in the workspace. */
  declared: string[];
  /** Subset of `declared` that is already in node_modules. */
  installed: string[];
  /** Subset of `declared` that is NOT yet in node_modules. */
  missing: string[];
  /** Subset of `declared` that has been imported into the SDK registry. */
  loaded: string[];
  settings: EditorSettings;
}

/**
 * Result shape of `POST /api/plugins/refresh` — re-runs the auto-load +
 * (when enabled) auto-install sweep against the workspace's declared plugins
 * and returns a structured before/after report so the UI can tell the user
 * exactly what happened.
 */
export interface PluginRefreshResult {
  settings: EditorSettings;
  /** Workspace-wide declared plugins (union across every YAML in `.tagma/`). */
  declared: string[];
  /** Declared plugins that are still missing from node_modules after this call. */
  missing: string[];
  /** Plugins this call freshly installed (i.e. became installed during the sweep). */
  installed: string[];
  /** Plugins this call freshly loaded into the SDK registry. */
  loaded: string[];
  /** Per-plugin failures from the most recent sweep, mirroring /api/plugins. */
  errors: Array<{ name: string; message: string }>;
  registry: PluginRegistry;
}

export interface RecentWorkspaceEntry {
  path: string;
  openedAt: number;
  exists: boolean;
}

export interface ServerState {
  config: RawPipelineConfig;
  validationErrors: ValidationError[];
  dag: { nodes: Record<string, any>; edges: DagEdge[] };
  yamlPath: string | null;
  yamlMtimeMs?: number | null;
  workDir: string;
  layout: EditorLayout;
  /**
   * Monotonic mutation counter (C6). Always present on responses from the
   * current server; marked optional for backward compatibility with older
   * servers that do not yet stamp it.
   */
  revision?: number;
}

/**
 * H8: non-blocking style hints vs fatal errors. `ValidationError` lives in
 * `@tagma/sdk` (not `@tagma/types`) so we keep the local shape for now; the
 * editor only ever reads these three fields off the payload.
 */
export interface ValidationError {
  path: string;
  message: string;
  /** H8: 'warning' entries are non-blocking style hints; undefined / 'error' are fatal. */
  severity?: 'error' | 'warning';
}

export interface DagEdge {
  from: string;
  to: string;
}

/**
 * F10: Plugin schema metadata. Optional on the registry — the SDK's built-in
 * plugins do not currently expose declarative schemas, so the client falls
 * back to hand-written descriptors in `SchemaForm.tsx`. When/if the SDK
 * starts exposing schemas, the server should echo them here and the client
 * will merge-prefer server-provided schemas over the hand-written fallback.
 *
 * Kept intentionally loose (`unknown`) so this type stays compatible with
 * both hand-written descriptors and any future zod/JSON-Schema payload.
 */
export interface PluginSchemaDescriptor {
  readonly fields?: readonly {
    readonly key: string;
    readonly type: string;
    readonly required?: boolean;
    readonly description?: string;
    readonly default?: unknown;
    readonly enum?: readonly string[];
    readonly min?: number;
    readonly max?: number;
  }[];
  readonly [key: string]: unknown;
}

/**
 * F1: A template manifest discovered from `@tagma/template-*` packages in the
 * current workspace's node_modules. `ref` is the value users drop into
 * `task.use`; `params` drives the generated parameter form. `tasks` is kept
 * as `unknown[]` because the editor only cares about the count for display;
 * the server already validates the real shape against the SDK.
 */
export interface TemplateManifest {
  readonly ref: string;
  readonly name: string;
  readonly description?: string;
  readonly params?: Record<string, TemplateParamDef>;
  readonly tasks?: readonly unknown[];
}

export interface PluginRegistry {
  drivers: string[];
  triggers: string[];
  completions: string[];
  middlewares: string[];
  /**
   * F2: capabilities keyed by driver name. Optional for compatibility with
   * older servers; use `useDriverCapability` to look up safely.
   */
  driverCapabilities?: Record<string, DriverCapabilities>;
  /**
   * F10: schema descriptors keyed by plugin type, grouped by category.
   * The server reads these from each plugin's declarative `schema` field
   * (SDK `PluginSchema`); client falls back to hand-written data for
   * plugins that don't expose a schema.
   */
  triggerSchemas?: Record<string, PluginSchemaDescriptor>;
  completionSchemas?: Record<string, PluginSchemaDescriptor>;
  middlewareSchemas?: Record<string, PluginSchemaDescriptor>;
  /**
   * F1: installed template manifests discovered from the current workspace.
   */
  templates?: TemplateManifest[];
}

export interface PluginInfo {
  name: string;
  installed: boolean;
  loaded: boolean;
  version: string | null;
  description: string | null;
  categories: string[];
}

/** Coarse server-side error classification — mirrors PluginManager's ErrorKind. */
export type PluginErrorKind = 'network' | 'permission' | 'version' | 'notfound' | 'invalid' | 'unknown';

export interface PluginActionResult {
  plugin: PluginInfo;
  registry: PluginRegistry;
  warning?: string;
  note?: string;
  /** Set when the action partially failed (e.g. installed but failed to load). */
  kind?: PluginErrorKind;
}

export interface PluginListResult {
  plugins: PluginInfo[];
  /** Errors collected during the most recent autoLoadInstalledPlugins() pass. */
  autoLoadErrors?: ReadonlyArray<{ name: string; message: string }>;
}

export interface PluginUninstallImpactEntry {
  /** Workspace-relative YAML path, e.g. ".tagma/build.yaml". */
  file: string;
  /** Human-readable location within the file. */
  location: string;
  trackId: string;
  taskId: string | null;
}

export interface PluginUninstallImpact {
  name: string;
  /** Null when the plugin couldn't be classified; `impacts` is empty in that case. */
  category: PluginCategory | null;
  type: string | null;
  impacts: readonly PluginUninstallImpactEntry[];
}

// ── Marketplace types ──
//
// The SDK defines exactly four plugin categories (see tagma-sdk/src/registry.ts
// VALID_CATEGORIES). Anything else returned from an upstream source is
// considered invalid and is filtered out server-side.

export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string | null;
  /** Resolved from the package's own `package.json.tagmaPlugin` field. */
  category: PluginCategory;
  /** Resolved from the package's own `package.json.tagmaPlugin.type`. */
  type: string;
  /** `keywords` array from package.json (may be empty). */
  keywords: readonly string[];
  /** Primary author name if resolvable. */
  author: string | null;
  /** Last publish timestamp reported by the npm search index. */
  date: string | null;
  /** Package homepage if declared. */
  homepage: string | null;
  /** Source repository URL if declared. */
  repository: string | null;
  /** npm weekly download count (null if the downloads API failed). */
  weeklyDownloads: number | null;
}

export interface MarketplaceSearchResult {
  query: string;
  category: PluginCategory | null;
  entries: MarketplaceEntry[];
  /** Number of raw results fetched from npm before tagmaPlugin validation. */
  totalRaw: number;
  /** Timestamp when the cached payload was produced. */
  fetchedAt: string;
  /**
   * If set, the upstream npm registry call failed (or partially failed) while
   * producing this response. `entries` may still be non-empty if one of the
   * two upstream queries succeeded — the client should still render them but
   * can surface the message so the user knows the list may be incomplete.
   */
  upstreamError?: string | null;
}

export interface MarketplacePackageDetail extends MarketplaceEntry {
  readme: string | null;
  license: string | null;
  /** All published versions, newest first. */
  versions: readonly string[];
}

export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface FsListResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

// ── Run types ──

export type TaskLogLevel = 'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet';

export interface TaskLogLine {
  level: TaskLogLevel;
  timestamp: string; // HH:MM:SS.mmm — mirrors pipeline.log formatting
  text: string;       // fully-formatted line as written to the log file
}

export interface RunTaskState {
  taskId: string;
  trackId: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  // ── Extended fields from SDK TaskResult ──
  // These mirror @tagma/sdk TaskResult and are populated by the server when
  // it observes a task_status_change event with a finished TaskState. They
  // stay null until the task actually completes.
  outputPath: string | null;
  stderrPath: string | null;
  sessionId: string | null;
  normalizedOutput: string | null;
  // Resolved runtime config. The SDK resolves inheritance (task → track →
  // pipeline → default) once a task starts, and the authoritative values are
  // captured here so the Run-side panel can display what actually ran.
  resolvedDriver: string | null;
  resolvedModel: string | null;
  resolvedPermissions: Permissions | null;
  // Streamed process log lines sourced from the SDK Logger (same content as
  // pipeline.log). Capped by the reducer so an excessively chatty task does
  // not grow the store without bound.
  logs: TaskLogLine[];
  // C6: Total number of log lines received (including those truncated from
  // the buffer). Used to show "showing N of M lines" when truncated.
  totalLogCount: number;
}

export interface RunState {
  runId: string | null;
  status: 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'aborted' | 'error';
  tasks: RunTaskState[];
  error: string | null;
}

export type RunEvent =
  | { type: 'run_start'; runId: string; tasks: RunTaskState[]; seq?: number }
  | {
      type: 'run_snapshot';
      runId: string;
      tasks: RunTaskState[];
      pendingApprovals: ApprovalRequestInfo[];
      seq?: number;
    }
  | {
      type: 'task_update';
      runId?: string;
      taskId: string;
      status: TaskStatus;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      outputPath?: string | null;
      stderrPath?: string | null;
      sessionId?: string | null;
      normalizedOutput?: string | null;
      resolvedDriver?: string | null;
      resolvedModel?: string | null;
      resolvedPermissions?: Permissions | null;
      seq?: number;
    }
  | { type: 'run_end'; runId?: string; success: boolean; seq?: number }
  | { type: 'run_error'; runId?: string; error: string; seq?: number }
  | {
      type: 'task_log';
      runId?: string;
      taskId: string | null;
      level: TaskLogLevel;
      timestamp: string;
      text: string;
      seq?: number;
    }
  | { type: 'approval_request'; runId?: string; request: ApprovalRequestInfo; seq?: number }
  | { type: 'approval_resolved'; runId?: string; requestId: string; outcome: ApprovalOutcome; seq?: number };

export interface RunHistoryTaskCounts {
  total: number;
  success: number;
  failed: number;
  timeout: number;
  skipped: number;
  blocked: number;
  running: number;
  waiting: number;
  idle: number;
}

export interface RunHistoryEntry {
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  success?: boolean;
  finishedAt?: string;
  taskCounts?: RunHistoryTaskCounts;
}

export interface RunSummaryTask {
  taskId: string;
  trackId: string;
  trackName: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  driver: string | null;
  model: string | null;
  depends_on?: string[];
}

export interface RunSummaryTrack {
  id: string;
  name: string;
  color?: string;
}

export interface RunSummary {
  runId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  error: string | null;
  tasks: RunSummaryTask[];
  tracks: RunSummaryTrack[];
}

// ── External state events (C5) ──
//
// Emitted by the server when the backing YAML file changes on disk outside
// of the editor. `external-change` means the server has already reloaded
// (client should adopt `newState`); `external-conflict` means the server
// detected a change but its in-memory state is dirty and cannot be safely
// replaced — the client must decide what to do.
export type ServerStateEvent =
  | { type: 'external-change'; newState: ServerState }
  | { type: 'external-conflict'; path: string; error?: string }
  | { type: 'state_sync'; newState: ServerState; seq: number };

export const api = {
  getState: () => request<ServerState>('/state'),

  getRegistry: () => request<PluginRegistry>('/registry'),

  updatePipeline: (fields: Record<string, unknown>) =>
    request<ServerState>('/pipeline', { method: 'PATCH', body: jsonBody(fields) }),

  addTrack: (id: string, name: string, color?: string) =>
    request<ServerState>('/tracks', { method: 'POST', body: jsonBody({ id, name, color }) }),

  updateTrack: (trackId: string, fields: Record<string, unknown>) =>
    request<ServerState>(`/tracks/${trackId}`, { method: 'PATCH', body: jsonBody(fields) }),

  deleteTrack: (trackId: string) =>
    request<ServerState>(`/tracks/${trackId}`, { method: 'DELETE' }),

  reorderTrack: (trackId: string, toIndex: number) =>
    request<ServerState>('/tracks/reorder', { method: 'POST', body: jsonBody({ trackId, toIndex }) }),

  addTask: (trackId: string, task: RawTaskConfig) =>
    request<ServerState>('/tasks', { method: 'POST', body: jsonBody({ trackId, task }) }),

  updateTask: (trackId: string, taskId: string, patch: Partial<RawTaskConfig>) =>
    request<ServerState>(`/tasks/${trackId}/${taskId}`, { method: 'PATCH', body: jsonBody(patch) }),

  deleteTask: (trackId: string, taskId: string) =>
    request<ServerState>(`/tasks/${trackId}/${taskId}`, { method: 'DELETE' }),

  transferTask: (fromTrackId: string, taskId: string, toTrackId: string) =>
    request<ServerState>('/tasks/transfer', { method: 'POST', body: jsonBody({ fromTrackId, taskId, toTrackId }) }),

  addDependency: (fromTrackId: string, fromTaskId: string, toTrackId: string, toTaskId: string) =>
    request<ServerState>('/dependencies', { method: 'POST', body: jsonBody({ fromTrackId, fromTaskId, toTrackId, toTaskId }) }),

  removeDependency: (trackId: string, taskId: string, depRef: string) =>
    request<ServerState>('/dependencies', { method: 'DELETE', body: jsonBody({ trackId, taskId, depRef }) }),

  exportYaml: () => request<string>('/export'),

  importYaml: (yaml: string) =>
    request<ServerState>('/import', { method: 'POST', body: jsonBody({ yaml }) }),

  /**
   * Replace the in-memory pipeline config wholesale, optionally with a layout
   * snapshot in the same atomic call. The server runs the same normalizations
   * (reconcilePipelinePlugins, reconcileContinueFrom) every other write path runs
   * and rejects payloads that fail deep structural checks. Used by undo/redo.
   */
  replaceConfig: (config: RawPipelineConfig, positions?: Record<string, { x: number }>) =>
    request<ServerState>('/config/replace', {
      method: 'POST',
      body: jsonBody(positions ? { config, layout: { positions } } : { config }),
    }),

  loadDemo: () => request<ServerState>('/demo', { method: 'POST' }),

  listDir: (path?: string, opts?: { picker?: boolean }) => {
    // C3: `picker=1` opts a request out of the workspace fence so the
    // dedicated workspace-root / import / export pickers can walk the host
    // filesystem. Mutation endpoints still enforce their own fences.
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (opts?.picker) params.set('picker', '1');
    const qs = params.toString();
    return request<FsListResult>(`/fs/list${qs ? `?${qs}` : ''}`);
  },

  listWorkspaceYamls: () =>
    request<{ entries: { name: string; path: string; pipelineName: string | null }[] }>(
      '/workspace/yamls',
    ),

  listRoots: () =>
    request<{ roots: string[] }>('/fs/roots'),

  mkdir: (path: string) =>
    request<{ path: string }>('/fs/mkdir', { method: 'POST', body: jsonBody({ path }) }),

  reveal: (path: string) =>
    request<{ ok: boolean }>('/fs/reveal', { method: 'POST', body: jsonBody({ path }) }),

  setWorkDir: (workDir: string) =>
    request<ServerState>('/workspace', { method: 'PATCH', body: jsonBody({ workDir }) }),

  listRecentWorkspaces: () =>
    request<{ recent: RecentWorkspaceEntry[] }>('/recent-workspaces'),

  addRecentWorkspace: (path: string) =>
    request<{ recent: RecentWorkspaceEntry[] }>('/recent-workspaces', {
      method: 'POST',
      body: jsonBody({ path }),
    }),

  removeRecentWorkspace: (path: string) =>
    request<{ recent: RecentWorkspaceEntry[] }>('/recent-workspaces', {
      method: 'DELETE',
      body: jsonBody({ path }),
    }),

  getEditorSettings: () =>
    request<EditorSettings>('/editor-settings'),

  updateEditorSettings: (patch: Partial<EditorSettings>) =>
    request<EditorSettings>('/editor-settings', { method: 'PATCH', body: jsonBody(patch) }),

  getDeclaredPlugins: () =>
    request<PluginDeclaredResult>('/plugins/declared'),

  refreshPlugins: () =>
    request<PluginRefreshResult>('/plugins/refresh', { method: 'POST' }),

  openFile: (path: string) =>
    request<ServerState>('/open', { method: 'POST', body: jsonBody({ path }) }),

  saveFile: () =>
    request<ServerState>('/save', { method: 'POST' }),

  saveFileAs: (path: string) =>
    request<ServerState>('/save-as', { method: 'POST', body: jsonBody({ path }) }),

  newPipeline: (name?: string) =>
    request<ServerState>('/new', { method: 'POST', body: jsonBody({ name }) }),

  importFile: (sourcePath: string) =>
    request<ServerState>('/import-file', { method: 'POST', body: jsonBody({ sourcePath }) }),

  exportFile: (destDir: string) =>
    request<{ ok: boolean; path: string }>('/export-file', { method: 'POST', body: jsonBody({ destDir }) }),

  deleteFile: (path: string) =>
    request<ServerState>('/delete-file', { method: 'POST', body: jsonBody({ path }) }),

  saveLayout: (positions: Record<string, { x: number }>) =>
    request<{ ok: boolean }>('/layout', { method: 'PATCH', body: jsonBody({ positions }) }),

  startRun: () =>
    request<{ ok: boolean }>('/run/start', { method: 'POST' }),

  abortRun: () =>
    request<{ ok: boolean }>('/run/abort', { method: 'POST' }),

  subscribeRunEvents: (
    onEvent: (event: RunEvent) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): (() => void) => {
    // C8: EventSource natively sends Last-Event-ID on reconnect when the
    // server stamps events with `id:` fields (which our server does).
    // We just need to track connection state for UI feedback.
    const es = new EventSource(`${BASE}/run/events`);
    es.addEventListener('run_event', (e) => {
      try {
        const event: RunEvent = JSON.parse(e.data);
        onEvent(event);
      } catch {}
    });
    es.onopen = () => {
      onConnectionChange?.(true);
    };
    es.onerror = () => {
      // EventSource auto-reconnects; notify UI of disconnect.
      onConnectionChange?.(false);
    };
    return () => es.close();
  },

  // ── Plugin management ──

  listPlugins: () =>
    request<PluginListResult>('/plugins'),

  getPluginInfo: (name: string) =>
    request<PluginInfo>(`/plugins/info?name=${encodeURIComponent(name)}`),

  installPlugin: (name: string) =>
    request<PluginActionResult>('/plugins/install', { method: 'POST', body: jsonBody({ name }) }),

  uninstallPlugin: (name: string) =>
    request<PluginActionResult>('/plugins/uninstall', { method: 'POST', body: jsonBody({ name }) }),

  /**
   * Pre-flight check for uninstall: returns the YAML locations that
   * reference the plugin's (category, type) so the UI can show a confirm
   * dialog before orphaning tasks. Safe to ignore for plugins that can't
   * be classified — `category` is null in that case.
   */
  uninstallImpact: (name: string) =>
    request<PluginUninstallImpact>(`/plugins/uninstall-impact?name=${encodeURIComponent(name)}`),

  loadPlugin: (name: string) =>
    request<PluginActionResult>('/plugins/load', { method: 'POST', body: jsonBody({ name }) }),

  importLocalPlugin: (path: string) =>
    request<PluginActionResult>('/plugins/import-local', { method: 'POST', body: jsonBody({ path }) }),

  // ── Plugin marketplace (npm registry proxy) ──
  // The server proxies and caches npm registry queries so we can strip
  // packages that don't declare `tagmaPlugin` in their manifest, enrich
  // results with weekly downloads, and shield the client from CORS +
  // rate-limit quirks.

  searchMarketplace: (query: string, category?: PluginCategory) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    const qs = params.toString();
    return request<MarketplaceSearchResult>(`/marketplace/search${qs ? `?${qs}` : ''}`);
  },

  getMarketplacePackage: (name: string) =>
    request<MarketplacePackageDetail>(`/marketplace/package?name=${encodeURIComponent(name)}`),

  // ── Run history (F8 / §3.12) ──
  listRunHistory: () =>
    request<{ runs: RunHistoryEntry[] }>('/run/history'),

  getRunLog: (runId: string) =>
    request<{ runId: string; content: string }>(`/run/history/${encodeURIComponent(runId)}`),

  getRunSummary: (runId: string) =>
    request<RunSummary>(`/run/history/${encodeURIComponent(runId)}/summary`),

  // ── Approvals (F3) ──
  resolveApproval: (requestId: string, outcome: 'approved' | 'rejected') =>
    request<{ ok: boolean; stubbed?: boolean }>(`/run/approval/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: jsonBody({ outcome }),
    }),

  // ── State events (C5) ──
  // Polling fallback for clients that can't use SSE.
  reloadState: () => request<ServerState>('/state/reload'),

  // SSE subscription: returns an unsubscribe function. Fires for every
  // external-change / external-conflict event emitted server-side.
  subscribeStateEvents: (
    onEvent: (event: ServerStateEvent) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): (() => void) => {
    const es = new EventSource(`${BASE}/state/events`);
    es.addEventListener('state_event', (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as ServerStateEvent;
        // C4 (P1-H1 lost-update fix): only bump the client revision on
        // `external-change`, where the server has already reloaded the file
        // and the App.tsx handler unconditionally calls init() so the local
        // store will be replaced with the new state. For `state_sync` (a
        // reconnect catch-up) the consumer may *skip* applying the new state
        // when there are unsaved local edits — bumping the revision here
        // would mean the next mutation passes the If-Match check against an
        // unrelated baseline, silently overwriting whoever wrote that newer
        // revision. The consumer is responsible for calling setClientRevision
        // (via applyState) only when it actually adopts the new state.
        if (event.type === 'external-change' && event.newState?.revision !== undefined) {
          setClientRevision(event.newState.revision);
        }
        onEvent(event);
      } catch {
        // malformed payload — ignore
      }
    });
    es.onopen = () => {
      onConnectionChange?.(true);
    };
    es.onerror = () => {
      // EventSource auto-reconnects; notify UI of disconnect.
      onConnectionChange?.(false);
    };
    return () => es.close();
  },
};
