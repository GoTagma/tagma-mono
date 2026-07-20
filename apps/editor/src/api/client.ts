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
  CommandConfig as SdkCommandConfig,
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
  TaskLogLevel as SdkTaskLogLevel,
  TaskLogLine as SdkTaskLogLine,
  RunTaskState as SdkRunTaskState,
  AbortReason as SdkAbortReason,
  WireRunEvent as SdkWireRunEvent,
  PipelineGraphEventPayload as SdkPipelineGraphEventPayload,
  PipelineGraphNodeState as SdkPipelineGraphNodeState,
  PipelineGraphNodeStatus as SdkPipelineGraphNodeStatus,
  PipelineGraphAbortReason as SdkPipelineGraphAbortReason,
  PipelineGraphPipelineLifecycle as SdkPipelineGraphPipelineLifecycle,
  PortType as SdkPortType,
  PortDef as SdkPortDef,
  TaskInputBinding as SdkTaskInputBinding,
  TaskOutputBinding as SdkTaskOutputBinding,
  TaskInputBindings as SdkTaskInputBindings,
  TaskOutputBindings as SdkTaskOutputBindings,
} from '@tagma/types';

// Recursively strip `readonly` from object fields and array element
// wrappers. Primitives, unions of primitives, and untyped index
// signatures pass through unchanged.
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

export type Permissions = Mutable<SdkPermissions>;
export type CommandConfig = Mutable<SdkCommandConfig>;
export type HookCommand = Mutable<SdkHookCommand>;
export type HooksConfig = Mutable<SdkHooksConfig>;
export type RawPipelineConfig = Mutable<SdkRawPipelineConfig>;
export type RawTrackConfig = Mutable<SdkRawTrackConfig>;
export type RawTaskConfig = Mutable<SdkRawTaskConfig>;
export type DriverCapabilities = Mutable<SdkDriverCapabilities>;
export type TaskStatus = SdkTaskStatus;
export type ApprovalOutcome = SdkApprovalOutcome;
export type PluginCategory = SdkPluginCategory;

// Binding helper types carry only primitive / readonly-array fields, but the
// editor mutates them through the same Zustand-backed update path as the rest
// of the pipeline config, so strip readonly for form handlers.
export type PortType = SdkPortType;
export type PortDef = Mutable<SdkPortDef>;
export type TaskInputBinding = Mutable<SdkTaskInputBinding>;
export type TaskOutputBinding = Mutable<SdkTaskOutputBinding>;
export type TaskInputBindings = Mutable<SdkTaskInputBindings>;
export type TaskOutputBindings = Mutable<SdkTaskOutputBindings>;

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

export interface YamlCompileResult {
  timestamp: string;
  sourceName: string;
  success: boolean;
  parseOk: boolean;
  validation: {
    errors: Array<{ path: string; message: string }>;
    warnings: Array<{ path: string; message: string }>;
  };
  summary: string;
}

export interface WorkspaceYamlEntry {
  name: string;
  path: string;
  pipelineName: string | null;
  contentHash: string;
  layoutHash: string | null;
  layoutMtimeMs: number | null;
  layoutSize: number | null;
  mtimeMs: number;
  size: number;
}

export interface ChatYamlStageEntry extends WorkspaceYamlEntry {
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
  requirementsHash: string | null;
}

export interface ChatYamlStageDescriptor {
  id: string;
  rootDir: string;
  baseWorkspaceDir: string;
  agentWorkspaceDir: string;
  agentTagmaDir: string;
  activeRelativePath: string | null;
  activeStagedPath: string | null;
  entries: ChatYamlStageEntry[];
}

export type ChatPipelineTrialRunKind =
  | 'passed'
  | 'failed'
  | 'compile-failed'
  | 'preflight-failed'
  | 'setup-failed'
  | 'timed-out'
  | 'busy';

export interface ChatPipelineTrialTaskResult {
  taskId: string;
  status: string;
  exitCode: number | null;
  failureKind: string | null;
  stdout: string;
  stderr: string;
}

export interface ChatPipelineTrialRunResult {
  version: 1;
  success: boolean;
  kind: ChatPipelineTrialRunKind;
  ran: boolean;
  runId: string | null;
  summary: string;
  durationMs: number;
  totalTaskCount: number;
  omittedTaskCount: number;
  tasks: ChatPipelineTrialTaskResult[];
}

export type ChatYamlStageConflict =
  | 'local-branch-changed'
  | 'source-changed-on-disk'
  | 'path-moved'
  | 'compile-failed'
  | 'trial-run-failed'
  | 'destination-exists';

export interface ChatYamlStageFinalizeInput {
  stageId: string;
  relativePath: string;
  localBranch?: {
    sourcePath: string;
    yaml: string;
    layout?: EditorLayout | null;
    changed: boolean;
  } | null;
  forceFork?: boolean;
  forceForkReason?: 'path-moved' | 'compile-failed' | 'trial-run-failed';
  allowInvalid?: boolean;
}

export interface ChatYamlStageFinalizeResult {
  outcome: 'unchanged' | 'adopted' | 'forked' | 'created';
  entry: ChatYamlStageEntry | null;
  conflicts: ChatYamlStageConflict[];
  localBranchPersisted: boolean;
  compile: YamlCompileResult;
  revision: number;
  state: ServerState;
}

export interface ChatPipelineCopyResult {
  entry: WorkspaceYamlEntry;
  revision: number;
  restoredOriginal: boolean;
}

export interface WorkflowPipelineEntry {
  id: string;
  path: string;
  depends_on: string[];
  position?: { x: number; y: number };
  lifecycle?: Mutable<SdkPipelineGraphPipelineLifecycle>;
}

export interface WorkflowYamlEntry {
  name: string;
  path: string;
  workflowName: string | null;
  contentHash: string;
  mtimeMs: number;
  size: number;
  pipelines: WorkflowPipelineEntry[];
}

export interface CreateWorkflowResult {
  ok: true;
  workflow: WorkflowYamlEntry;
}

export interface UpdateWorkflowResult {
  ok: true;
  workflow: WorkflowYamlEntry;
}

export interface UsageRecord {
  ts: number;
  messageID: string;
  sessionID: string;
  providerID: string;
  modelID: string;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  finish: string;
}

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
  if (rev === null) {
    lastRevision = null;
    return;
  }
  if (typeof rev === 'number' && Number.isFinite(rev)) lastRevision = rev;
}

// ── Workspace header (multi-window sidecar routing) ──
//
// A single sidecar process now hosts every Electron window. Each window has
// its own `WorkspaceState` on the server, keyed by absolute workspace path,
// and the server's `resolveWorkspace` middleware reads `X-Tagma-Workspace`
// (or `?ws=` for SSE, since EventSource can't set headers) to pick the right
// one. The store calls `setClientWorkspace` whenever the user opens or
// switches a workspace so every subsequent fetch carries the matching key.
let workspaceKey: string | null = null;
const AUTH_STORAGE_KEY = 'tagma.authToken';
const AUTH_COOKIE_NAME = 'tagma_auth';
const yamlEditLockBypassStack: string[] = [];

function writeAuthCookie(token: string | null): void {
  if (typeof document === 'undefined') return;
  if (token) {
    document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api; SameSite=Strict`;
  } else {
    document.cookie = `${AUTH_COOKIE_NAME}=; Path=/api; Max-Age=0; SameSite=Strict`;
  }
}

function scrubQueryParam(param: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(param)) return;
  url.searchParams.delete(param);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function scrubHashParam(param: string): void {
  if (typeof window === 'undefined') return;
  if (!window.location.hash) return;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  if (!params.has(param)) return;
  params.delete(param);
  const nextHash = params.toString();
  const url = new URL(window.location.href);
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ''}`,
  );
}

function readInitialAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  const urlToken = new URL(window.location.href).searchParams.get('auth');
  const hashToken = new URLSearchParams(
    window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash,
  ).get('auth');
  const token = hashToken ?? urlToken ?? window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (hashToken) scrubHashParam('auth');
  if (urlToken) scrubQueryParam('auth');
  if (token && token.trim().length > 0) {
    const trimmed = token.trim();
    window.sessionStorage.setItem(AUTH_STORAGE_KEY, trimmed);
    writeAuthCookie(trimmed);
    return trimmed;
  }
  return token && token.trim().length > 0 ? token : null;
}

let authToken: string | null = readInitialAuthToken();

export function getClientWorkspace(): string | null {
  return workspaceKey;
}

type WorkspaceListener = (key: string | null) => void;
const workspaceListeners = new Set<WorkspaceListener>();

// Subscribers fire on every successful change to the client workspace key.
// The yaml-edit-lock store uses this to recompute `active` when the user
// switches workspaces mid-chat — a chat lock acquired in workspace A no
// longer leaks into workspace B's UI.
export function subscribeClientWorkspace(listener: WorkspaceListener): () => void {
  workspaceListeners.add(listener);
  return () => {
    workspaceListeners.delete(listener);
  };
}

export function setClientWorkspace(key: string | null | undefined): void {
  const next = typeof key === 'string' && key.trim().length > 0 ? key : null;
  if (next === workspaceKey) return;
  // `lastRevision` is per-workspace on the server (C6). When the client
  // switches workspaces we MUST drop the cached baseline — a fresh
  // WorkspaceState starts at revision 0 on the server, but if we keep the
  // previous workspace's lastRevision around the next mutation's If-Match
  // header will 409 on the very first switch-then-edit round trip.
  lastRevision = null;
  workspaceKey = next;
  for (const listener of workspaceListeners) {
    try {
      listener(next);
    } catch {
      /* listener errors must not break the workspace switch */
    }
  }
}

export function getClientAuthToken(): string | null {
  return authToken;
}

export function setClientAuthToken(token: string | null | undefined): void {
  const next = typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
  authToken = next;
  if (typeof window !== 'undefined') {
    if (next) {
      window.sessionStorage.setItem(AUTH_STORAGE_KEY, next);
    } else {
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
    }
    writeAuthCookie(next);
  }
}

export async function withYamlEditLockRequestBypass<T>(
  lockId: string,
  op: () => Promise<T>,
): Promise<T> {
  yamlEditLockBypassStack.push(lockId);
  try {
    return await op();
  } finally {
    yamlEditLockBypassStack.pop();
  }
}

/** Append query params to a URL for EventSource, since it can't set headers. */
function withWorkspaceParam(path: string): string {
  const params = new URLSearchParams();
  if (workspaceKey) params.set('ws', workspaceKey);
  const qs = params.toString();
  if (!qs) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${qs}`;
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

function buildJsonRequestHeaders(
  options?: RequestInit,
  workspaceKeyOverride?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  // Attach If-Match on mutations when we have a known revision.
  if (isMutation(options) && lastRevision !== null) {
    headers['If-Match'] = String(lastRevision);
  }
  // Multi-window sidecar: route every fetch to the current workspace. Omitted
  // when no workspace is bound (welcome page, pre-open), which the server
  // treats as "no workspace" — endpoints that need one will 400 explicitly.
  const targetWorkspaceKey =
    workspaceKeyOverride === undefined ? workspaceKey : workspaceKeyOverride;
  if (targetWorkspaceKey) {
    headers['X-Tagma-Workspace'] = targetWorkspaceKey;
  }
  const yamlEditLockBypassId = yamlEditLockBypassStack[yamlEditLockBypassStack.length - 1];
  if (isMutation(options) && yamlEditLockBypassId) {
    headers['X-Tagma-Yaml-Lock-Id'] = yamlEditLockBypassId;
  }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

async function throwApiResponseError(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({ error: res.statusText }));
  // Promote server-supplied error kind to a typed property so callers can
  // render localized hints without scraping English substrings out of the
  // message body. `body` carries the full payload so callers handling
  // structured errors (e.g. requirements_missing) can read sibling fields.
  const apiErr = new Error(err.error ?? 'Request failed') as Error & {
    kind?: string;
    status?: number;
    body?: unknown;
  };
  if (typeof err.kind === 'string') apiErr.kind = err.kind;
  apiErr.status = res.status;
  apiErr.body = err;
  throw apiErr;
}

async function request<T>(
  path: string,
  options?: RequestInit,
  workspaceKeyOverride?: string | null,
): Promise<T> {
  const headers = buildJsonRequestHeaders(options, workspaceKeyOverride);

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 409) {
    // Revision conflict — parse payload and throw a typed error so future
    // pipeline-store work can detect and re-apply state.
    const payload = (await res.json().catch(() => null)) as {
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
    await throwApiResponseError(res);
  }
  if (res.headers.get('content-type')?.includes('text/yaml')) {
    return (await res.text()) as unknown as T;
  }
  const data = await res.json();
  // Opportunistically pick up revision from any ServerState-shaped response.
  if (
    data &&
    typeof data === 'object' &&
    'revision' in data &&
    typeof (data as { revision?: unknown }).revision === 'number'
  ) {
    setClientRevision((data as { revision: number }).revision);
  }
  return data;
}

export function buildInstallPluginRequest(
  name: string,
  version?: string,
): { path: string; options: RequestInit } {
  return {
    path: '/plugins/install',
    options: {
      method: 'POST',
      body: jsonBody(version ? { name, version } : { name }),
    },
  };
}

async function requestPlatformExportFile(
  destDir: string,
  targetPlatform: PlatformExportTarget,
  model: PlatformExportModel | null | undefined,
  onProgress: ((event: PlatformExportProgressEvent) => void) | undefined,
  capabilityToken: string,
): Promise<PlatformExportDoneEvent> {
  const res = await fetch(`${BASE}/export-file/platform`, {
    method: 'POST',
    headers: buildJsonRequestHeaders({ method: 'POST' }),
    body: jsonBody({
      destDir,
      targetPlatform,
      ...(model ? { model } : {}),
      capabilityToken,
    }),
  });

  if (!res.ok) {
    await throwApiResponseError(res);
  }
  if (!res.body) {
    throw new Error('Platform export returned no response stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: PlatformExportDoneEvent | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = JSON.parse(trimmed) as PlatformExportStreamEvent;
    if (event.type === 'progress') {
      onProgress?.(event);
      return;
    }
    if (event.type === 'error') {
      throw new Error(event.error || 'Platform export failed');
    }
    if (event.type === 'done') {
      result = event;
    }
  };

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (!result) {
    throw new Error('Platform export ended before returning a result');
  }
  return result;
}

/**
 * Editor-only grouping of tracks into a collapsible folder. Folders live
 * exclusively in `.layout.json` (NOT in the pipeline YAML) so the YAML stays
 * portable. A track may belong to at most one folder; tracks not in any
 * folder render at the top level. Mirrors the server-side TrackFolder shape.
 */
export interface TrackFolder {
  id: string;
  name: string;
  /** Optional accent color (hex). Falls back to neutral muted token. */
  color?: string;
  /** Track IDs that belong to this folder, in display order. */
  trackIds: string[];
  collapsed: boolean;
}

export interface LayoutTaskPosition {
  x: number;
  y?: number;
}

export interface EditorLayout {
  positions: Record<string, LayoutTaskPosition>;
  /** Per-track editor lane heights in canvas pixels. Older layout files omit it. */
  trackHeights?: Record<string, number>;
  /** Optional editor-only track grouping. Older layout files omit it. */
  folders?: TrackFolder[];
}

/**
 * Per-workspace editor preferences persisted in `.tagma/editor-settings.json`.
 * These are user-level toggles that don't belong in the pipeline YAML
 * (which is meant to be portable). Mirrors the server-side EditorSettings shape.
 */
/**
 * Strategy for resolving a "user has unsaved canvas edits + chat agent writes
 * the same YAML on disk" conflict. Mirrors the server-side enum.
 *
 *   - 'ask'          — prompt the user per incident (default).
 *   - 'prefer-user'  — keep the user's canvas; agent's disk version will be
 *                      overwritten on next save.
 *   - 'prefer-agent' — silently adopt the agent's disk version; canvas edits
 *                      are discarded. Matches pre-setting behavior.
 */
export type ChatDirtyConflictPolicy = 'ask' | 'prefer-user' | 'prefer-agent';

/**
 * Inspector density. `debug` exposes every field across Track / Task /
 * Pipeline inspectors (inheritance hints, dataflow editor, lifecycle hooks,
 * advanced trigger/completion config). `production` hides debug aids and
 * infrastructure plumbing for day-to-day pipeline operation.
 */
export type EditorViewMode = 'debug' | 'production';

export interface PythonAgentSettings {
  enabled: boolean;
  interpreterCommand: string | null;
  interpreterArgs: string[];
  interpreterVersion: string | null;
  venvPath: string | null;
  configuredAt: string | null;
}

export interface OpenCodeChatModelSelection {
  providerID: string;
  modelID: string;
}

/** OpenCode model variant id; null delegates to the model/provider default. */
export type OpenCodeChatReasoningEffort = string | null;

export interface GlobalSettings {
  /** Machine-wide upper bound for every Tagma-managed OpenCode agent. */
  opencodeAgentMaxSteps: number;
}

export interface EditorSettings {
  /**
   * When true, opening a workspace will auto-install plugins declared in
   * the YAML's `plugins` array but missing from `node_modules`. Default off
   * because pulling arbitrary npm packages on YAML open is a security smell —
   * the user must opt in per workspace.
   */
  autoInstallDeclaredPlugins: boolean;
  /** Resolution strategy for dirty-canvas vs chat-driven-write conflicts. */
  chatDirtyConflictPolicy: ChatDirtyConflictPolicy;
  /** Periodic disk-autosave toggle. Default true. */
  autoSaveEnabled: boolean;
  /** Disk-autosave interval in seconds. Server clamps to [5, 600]. */
  autoSaveIntervalSec: number;
  /** Inspector density. Default `production`. */
  viewMode: EditorViewMode;
  /** Workspace-local Python AI Agent configuration. */
  pythonAgent: PythonAgentSettings;
  /** Last OpenCode chat provider/model selection for this workspace. */
  opencodeChatModel: OpenCodeChatModelSelection | null;
  /** Last OpenCode chat reasoning effort selection for this workspace. */
  opencodeChatReasoningEffort: OpenCodeChatReasoningEffort;
  /** Trial-run changed OpenCode Chat pipelines before finalization. Default true. */
  opencodeChatTrialRunEnabled: boolean;
  /** Shared compile/trial repair budget. Default 2; 0 disables; server clamps to [0, 10]. */
  opencodeChatPipelineRepairMaxAttempts: number;
  /**
   * Disabled means unlimited. Enabled with 0 rounds means stateless.
   */
  chatContextLimitEnabled: boolean;
  /**
   * Maximum conversation rounds kept in the active chat session when enabled.
   * 0 = stateless; positive values start a fresh session after the limit.
   */
  chatContextRounds: number;
}

export interface CredentialBackendInfo {
  platform: NodeJS.Platform;
  kind: 'macos-keychain' | 'windows-credential-manager' | 'linux-secret-service' | 'unsupported';
  available: boolean;
  message: string;
}

export interface SecretEntry {
  id: string;
  envName: string;
  scope: 'workspace' | 'pipeline';
  pipelinePath: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  hasValue: boolean;
}

export interface SecretsListResult {
  backend: CredentialBackendInfo;
  secrets: SecretEntry[];
}

export interface SecretWriteInput {
  envName: string;
  value: string;
  pipelinePath: string | null;
  description?: string | null;
}

export interface PythonInterpreter {
  id: string;
  command: string;
  args: string[];
  version: string;
  source: string;
  default: boolean;
}

export interface PythonDetectionResult {
  platform: string;
  detected: PythonInterpreter[];
  defaultId: string | null;
  packageManager: 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | null;
  brewAvailable: boolean | null;
  errors: string[];
}

export interface PythonInstallPlan {
  label: string;
  command: string[];
  note: string;
}

export interface PythonAgentConfigureResult {
  settings: EditorSettings;
  interpreter: PythonInterpreter;
  venv: { venvPath: string; pythonPath: string; created: boolean };
  revision: number;
}

export interface PythonAgentInstallResult {
  plan: PythonInstallPlan;
  result: { exitCode: number; stdout: string; stderr: string };
  revision: number;
}

/**
 * Snapshot of the OpenCode CLI binary the sidecar can currently see, plus
 * the latest version available on npm. Drives the OpenCode CLI section of
 * the Editor Settings panel — shows "shipped vX / running vY / update to vZ".
 *
 * Shape mirrors server/routes/opencode.ts GET /api/opencode/info.
 */
export interface OpencodeInfo {
  /** Version pinned into the installer at desktop build time (null in dev). */
  bundledVersion: string | null;
  /** `opencode --version` result, or null when the CLI isn't resolvable. */
  runningVersion: string | null;
  /** Version of the user-installed override in userData, or null if none. */
  userInstalledVersion: string | null;
  /** Latest version published on npm (null if the registry lookup failed). */
  latestVersion: string | null;
  /** True when latestVersion is newer than whatever PATH currently resolves. */
  updateAvailable: boolean;
  /** False in non-desktop contexts — update endpoint returns 500 in that case. */
  canUpdate: boolean;
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * Snapshot of the Editor hot-update layer: which `dist/` the sidecar is
 * currently serving (bundled vs userData override), the latest advertised in
 * the channel's manifest, and whether an update is actionable. Shape mirrors
 * server/routes/editor.ts GET /api/editor/info.
 */
export interface EditorInfo {
  /** Version baked into the installer at desktop build time (null in dev). */
  bundledVersion: string | null;
  /** Version staged under userData/editor/dist, or null when none. */
  userInstalledVersion: string | null;
  /**
   * What express.static is actually serving right now (captured at sidecar
   * startup). Lags behind `userInstalledVersion` after a hot-update until
   * the user fully closes and reopens the app — `pendingRestart` reflects
   * that gap.
   */
  activeVersion: string | null;
  /** Latest version the remote manifest advertises (null if unreachable). */
  latestVersion: string | null;
  /**
   * True only when clicking Update would actually fetch something new. False
   * once the user has already downloaded the latest bundle but not yet
   * restarted — in that state `pendingRestart` is true instead.
   */
  updateAvailable: boolean;
  /** False when the sidecar has no writable userData or no manifest URL. */
  canUpdate: boolean;
  /**
   * A hot-update has been staged to userData but the running sidecar is
   * still serving the previous bundle. Clears on next full app relaunch.
   */
  pendingRestart: boolean;
  /** Installer floor the manifest requires (null if unreachable or ungated). */
  minShellVersion: string | null;
  /** False when the installed shell is older than the manifest's floor. */
  shellCompatible: boolean;
  /** Current release channel (stable / alpha / beta / rc). */
  channel: string | null;
  /** Resolved manifest URL the sidecar would poll (null when disabled). */
  manifestUrl: string | null;
  /** Release notes URL from the manifest, if supplied. */
  releaseNotesUrl: string | null;
}

/**
 * Snapshot of the sidecar hot-update layer: which sidecar binary is currently
 * running, whether a newer platform-specific sidecar has been staged into
 * userData, and whether a relaunch is needed to apply it.
 */
export interface SidecarInfo {
  /** Version baked into the installer at desktop build time (null in dev). */
  bundledVersion: string | null;
  /** Version staged under userData/editor-sidecar, or null when none. */
  userInstalledVersion: string | null;
  /** Version of the sidecar process serving this window right now. */
  activeVersion: string | null;
  /** Where the currently running sidecar came from. */
  activeSource: 'bundled' | 'user' | 'dev' | null;
  /** Latest version the remote manifest advertises for this platform/arch. */
  latestVersion: string | null;
  /** True only when clicking Update would fetch a newer sidecar. */
  updateAvailable: boolean;
  /** False when this build cannot stage sidecar updates. */
  canUpdate: boolean;
  /** True when a newer sidecar is staged but not yet active. */
  pendingRestart: boolean;
  /** Installer floor the manifest requires (null if unreachable or ungated). */
  minShellVersion: string | null;
  /** False when the installed shell is older than the manifest's floor. */
  shellCompatible: boolean;
  /** Current release channel (stable / alpha / beta / rc). */
  channel: string | null;
  /** Resolved manifest URL the sidecar would poll (null when disabled). */
  manifestUrl: string | null;
  /** Release notes URL from the manifest, if supplied. */
  releaseNotesUrl: string | null;
  /** Current machine target. */
  platform: NodeJS.Platform;
  /** Current machine target. */
  arch: string;
}

/**
 * Result shape of `POST /api/release/update` — the atomic editor + sidecar
 * update. Returns both versions on success; throws on any staging failure
 * (nothing was activated in that case, so the app state is unchanged).
 */
export interface ReleaseUpdateResult {
  ok: true;
  editorVersion: string;
  sidecarVersion: string;
  opencodeVersion: string;
}

export type HotupdateKind = 'editor' | 'sidecar' | 'opencode' | 'release';

export type HotupdateStatus =
  { active: false } | { active: true; kind: HotupdateKind; startedAt: string };

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

export interface YamlEditLockInfo {
  owner: 'chat';
  reason: string;
  acquiredAt: number;
  expiresAt: number;
  yamlPath: string | null;
}

export interface HeldYamlEditLockInfo extends YamlEditLockInfo {
  id: string;
}

export interface ServerState {
  config: RawPipelineConfig;
  validationErrors: ValidationError[];
  dag: { nodes: Record<string, unknown>; edges: DagEdge[] };
  yamlPath: string | null;
  manualNewPipelineYamlPath?: string | null;
  yamlMtimeMs?: number | null;
  /** Monotonic per-YAML run counter. 0 means this YAML has not been run yet. */
  yamlRunVersion?: number;
  workDir: string;
  hostPlatform?: PlatformExportTarget | null;
  layout: EditorLayout;
  /**
   * Monotonic mutation counter (C6). Always present on responses from the
   * current server; marked optional for backward compatibility with older
   * servers that do not yet stamp it.
   */
  revision?: number;
  /** Present while chat holds the cooperative YAML/layout edit lock. */
  yamlEditLock?: YamlEditLockInfo | null;
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

/** Lightweight severity-tagged message used by UI components (cards, panels, tooltips). */
export interface DiagnosticItem {
  message: string;
  severity: 'error' | 'warning';
}

export interface DagEdge {
  from: string;
  to: string;
  /**
   * 'explicit'  — from `depends_on` or `continue_from` (the user wrote it).
   * 'dataflow'  — inferred from inputs/outputs name matching or explicit `from`
   *                bindings. Rendered as a dashed edge in the canvas.
   * Defaults to 'explicit' when absent (backward compat with older server responses).
   */
  kind?: 'explicit' | 'dataflow';
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
export type PluginErrorKind =
  'network' | 'permission' | 'version' | 'notfound' | 'invalid' | 'unknown';

export interface PluginActionResult {
  plugin: PluginInfo;
  registry: PluginRegistry;
  revision?: number;
  declaredPluginAdded?: boolean;
  warning?: string;
  note?: string;
  /** Set when the action partially failed (e.g. installed but failed to load). */
  kind?: PluginErrorKind;
}

export interface PluginUpgradePlanEntry {
  name: string;
  fromVersion: string | null;
  toVersion: string;
  reason: 'target';
}

export interface PluginUpgradeBlocker {
  name: string;
  currentVersion: string | null;
  latestVersion: string | null;
  reason: string;
}

export type PluginUpgradePlan =
  | {
      status: 'ready';
      target: string;
      upgrades: PluginUpgradePlanEntry[];
      warnings: string[];
    }
  | {
      status: 'blocked';
      target: string;
      upgrades: PluginUpgradePlanEntry[];
      blockers: PluginUpgradeBlocker[];
      message: string;
      warnings: string[];
    };

export interface PluginUpgradeActionResult extends PluginActionResult {
  upgradePlan?: Extract<PluginUpgradePlan, { status: 'ready' }>;
  upgraded?: PluginUpgradePlanEntry[];
}

export interface PluginListResult {
  plugins: PluginInfo[];
  /** Errors collected during the most recent autoLoadInstalledPlugins() pass. */
  autoLoadErrors?: ReadonlyArray<{ name: string; message: string }>;
}

export interface PluginUninstallImpactEntry {
  /** Workspace-relative YAML path, e.g. ".tagma/build.yaml". */
  file: string;
  category?: PluginCategory;
  type?: string;
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
  capabilities?: ReadonlyArray<{ category: PluginCategory; type: string }>;
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
  entryCapabilityTokens?: Record<string, string>;
  capabilityToken?: string;
  capabilityExpiresAt?: number;
  pickerMkdirCapabilityToken?: string;
  pickerMkdirCapabilityExpiresAt?: number;
}

export type FsCapabilityPurpose = 'picker-mkdir' | 'import-file' | 'export-file' | 'import-plugin';

export type PlatformExportTarget = 'windows' | 'linux' | 'mac';

export interface PlatformExportModel {
  providerID: string;
  modelID: string;
}

export type PlatformExportStage =
  | 'preparing'
  | 'syncing'
  | 'opencode'
  | 'model'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'writing';

export interface PlatformExportProgressEvent {
  type: 'progress';
  stage: PlatformExportStage;
  detail?: string;
}

interface PlatformExportDoneEvent {
  type: 'done';
  ok: true;
  path: string;
  targetPlatform: PlatformExportTarget;
}

interface PlatformExportErrorEvent {
  type: 'error';
  error: string;
}

type PlatformExportStreamEvent =
  PlatformExportProgressEvent | PlatformExportDoneEvent | PlatformExportErrorEvent;

// ── Run types ──
//
// The canonical wire types live in `@tagma/types`. We alias them locally
// so every component in the editor can `import { RunEvent } from '../api/client'`
// without also having to know about `@tagma/types`. `RunEvent` is the
// stamped wire event (always carries runId + seq) — the same values the
// editor server broadcasts. `AbortReason` is re-exported for the RunView
// to render a human-readable "why this stopped" when run_end.abortReason
// is non-null.

export type TaskLogLevel = SdkTaskLogLevel;
export type TaskLogLine = Mutable<SdkTaskLogLine>;
export type RunTaskState = Mutable<SdkRunTaskState>;
export type AbortReason = SdkAbortReason;
export type RunEvent = SdkWireRunEvent;
export type WorkflowGraphEvent = Mutable<SdkPipelineGraphEventPayload> & { seq?: number };
export type WorkflowGraphNodeState = Mutable<SdkPipelineGraphNodeState>;
export type WorkflowGraphNodeStatus = SdkPipelineGraphNodeStatus;
export type WorkflowGraphAbortReason = SdkPipelineGraphAbortReason;

export interface WorkflowRunResult {
  graphRunId: string;
  success: boolean;
  abortReason: WorkflowGraphAbortReason;
  pipelines: WorkflowGraphNodeState[];
}

export interface StartWorkflowRunResult {
  ok: boolean;
  graphRunId?: string;
  running?: boolean;
  result: WorkflowRunResult | null;
  events: WorkflowGraphEvent[];
}

export interface WorkflowRunStatus {
  ok: boolean;
  graphRunId: string | null;
  running: boolean;
  result: WorkflowRunResult | null;
  events: WorkflowGraphEvent[];
}

export interface WorkflowRunPipelineCounts {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  aborted: number;
  running: number;
  waiting: number;
}

export interface WorkflowRunHistoryDetail {
  kind: 'graph';
  runId: string;
  graphRunId: string;
  workflowName: string;
  workflowPath: string | null;
  startedAt: string;
  finishedAt: string | null;
  success: boolean;
  running?: boolean;
  error: string | null;
  result: WorkflowRunResult | null;
  events: WorkflowGraphEvent[];
  workflow: WorkflowYamlEntry;
  pipelineCounts: WorkflowRunPipelineCounts;
}

export interface StartRunResult {
  ok: boolean;
  runId?: string;
  yamlRunVersion?: number;
  events?: RunEvent[];
}

export interface StartRunOptions {
  fromRunId?: string;
  skipPreflight?: boolean;
  targetTaskIds?: readonly string[];
  yamlPath?: string | null;
  configSnapshot?: RawPipelineConfig;
}

export function buildStartRunRequestBody(
  opts?: StartRunOptions,
): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  if (opts?.fromRunId) body.fromRunId = opts.fromRunId;
  if (opts?.skipPreflight) body.skipPreflight = true;
  if (opts?.targetTaskIds && opts.targetTaskIds.length > 0) {
    body.targetTaskIds = [...opts.targetTaskIds];
  }
  if (typeof opts?.yamlPath === 'string' && opts.yamlPath.trim().length > 0) {
    body.yamlPath = opts.yamlPath;
  }
  if (opts?.configSnapshot) {
    body.configSnapshot = opts.configSnapshot;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

export function formatCommand(command: CommandConfig | null | undefined): string {
  if (!command) return '';
  if (typeof command === 'string') return command;
  if ('shell' in command) return command.shell;
  return command.argv.join(' ');
}

export interface RunState {
  runId: string | null;
  status: 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'aborted' | 'error';
  tasks: RunTaskState[];
  error: string | null;
}

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
  kind?: 'pipeline' | 'graph';
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  yamlRunVersion?: number;
  success?: boolean;
  running?: boolean;
  finishedAt?: string;
  /** Source runId when this run was launched via Replay (one level only). */
  replayedFromRunId?: string;
  taskCounts?: RunHistoryTaskCounts;
  pipelineCounts?: WorkflowRunPipelineCounts;
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
  prompt?: string | null;
  command?: string | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  normalizedOutput?: string | null;
  sessionId?: string | null;
}

/** A single task's persisted console stream, read on demand from history. */
export interface RunTaskOutput {
  runId: string;
  taskId: string;
  stream: 'stdout' | 'stderr';
  content: string;
  /** Full on-disk byte size (may exceed `content.length` when truncated). */
  size: number;
  /** True when `content` is the last 1 MB of a larger file. */
  truncated: boolean;
}

export interface RunHistoryAskAiContext {
  label: string;
  content: string;
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
  finishedAt: string | null;
  yamlRunVersion?: number;
  success: boolean;
  running?: boolean;
  error: string | null;
  tasks: RunSummaryTask[];
  tracks: RunSummaryTrack[];
  positions?: Record<string, LayoutTaskPosition>;
  trackHeights?: Record<string, number>;
  hasYamlSnapshot?: boolean;
  /** Source runId when this run was launched via Replay (one level only). */
  replayedFromRunId?: string;
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
  | {
      type: 'external-conflict';
      path: string;
      error?: string;
      layoutHash?: string;
      layoutMtimeMs?: number | null;
      /** Chat owns the disk branch; keep renderer memory unchanged until turn reconciliation. */
      deferredByYamlEditLock?: boolean;
    }
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
    request<ServerState>('/tracks/reorder', {
      method: 'POST',
      body: jsonBody({ trackId, toIndex }),
    }),

  addTask: (trackId: string, task: RawTaskConfig) =>
    request<ServerState>('/tasks', { method: 'POST', body: jsonBody({ trackId, task }) }),

  updateTask: (trackId: string, taskId: string, patch: Partial<RawTaskConfig>) =>
    request<ServerState>(`/tasks/${trackId}/${taskId}`, { method: 'PATCH', body: jsonBody(patch) }),

  deleteTask: (trackId: string, taskId: string) =>
    request<ServerState>(`/tasks/${trackId}/${taskId}`, { method: 'DELETE' }),

  transferTask: (fromTrackId: string, taskId: string, toTrackId: string) =>
    request<ServerState>('/tasks/transfer', {
      method: 'POST',
      body: jsonBody({ fromTrackId, taskId, toTrackId }),
    }),

  addDependency: (fromTrackId: string, fromTaskId: string, toTrackId: string, toTaskId: string) =>
    request<ServerState>('/dependencies', {
      method: 'POST',
      body: jsonBody({ fromTrackId, fromTaskId, toTrackId, toTaskId }),
    }),

  removeDependency: (trackId: string, taskId: string, depRef: string) =>
    request<ServerState>('/dependencies', {
      method: 'DELETE',
      body: jsonBody({ trackId, taskId, depRef }),
    }),

  exportYaml: () => request<string>('/export'),

  importYaml: (yaml: string) =>
    request<ServerState>('/import', { method: 'POST', body: jsonBody({ yaml }) }),

  /**
   * Replace the in-memory pipeline config wholesale, optionally with a layout
   * snapshot in the same atomic call. The server runs the same normalizations
   * (reconcilePipelinePlugins, reconcileContinueFrom) every other write path runs
   * and rejects payloads that fail deep structural checks. Used by undo/redo.
   */
  replaceConfig: (
    config: RawPipelineConfig,
    layout?: {
      positions?: Record<string, LayoutTaskPosition>;
      folders?: TrackFolder[];
      trackHeights?: Record<string, number>;
    },
  ) =>
    request<ServerState>('/config/replace', {
      method: 'POST',
      body: jsonBody(layout ? { config, layout } : { config }),
    }),

  loadDemo: () => request<ServerState>('/demo', { method: 'POST' }),

  listDir: (
    path?: string,
    opts?: { picker?: boolean; capabilityPurpose?: FsCapabilityPurpose },
  ) => {
    // C3: `picker=1` opts a request out of the workspace fence so the
    // dedicated workspace-root / import / export pickers can walk the host
    // filesystem. Mutation endpoints still enforce their own fences.
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (opts?.picker) params.set('picker', '1');
    if (opts?.capabilityPurpose) params.set('capabilityPurpose', opts.capabilityPurpose);
    const qs = params.toString();
    return request<FsListResult>(`/fs/list${qs ? `?${qs}` : ''}`);
  },

  listWorkspaceYamls: () => request<{ entries: WorkspaceYamlEntry[] }>('/workspace/yamls'),

  startChatYamlStage: (activePath?: string | null, workspaceKeyOverride?: string | null) =>
    request<ChatYamlStageDescriptor>(
      '/workspace/chat-yaml-stage/start',
      {
        method: 'POST',
        body: jsonBody({ activePath: activePath ?? null }),
      },
      workspaceKeyOverride,
    ),

  listChatYamlStage: (stageId: string, workspaceKeyOverride?: string | null) =>
    request<ChatYamlStageDescriptor>(
      '/workspace/chat-yaml-stage/list',
      {
        method: 'POST',
        body: jsonBody({ stageId }),
      },
      workspaceKeyOverride,
    ),

  compileChatYamlStage: (
    stageId: string,
    relativePath: string,
    workspaceKeyOverride?: string | null,
  ) =>
    request<YamlCompileResult>(
      '/workspace/chat-yaml-stage/compile',
      {
        method: 'POST',
        body: jsonBody({ stageId, relativePath }),
      },
      workspaceKeyOverride,
    ),

  trialRunChatYamlStage: (
    stageId: string,
    relativePath: string,
    trialId: string,
    workspaceKeyOverride?: string | null,
  ) =>
    request<ChatPipelineTrialRunResult>(
      '/workspace/chat-yaml-stage/trial-run',
      {
        method: 'POST',
        body: jsonBody({ stageId, relativePath, trialId }),
      },
      workspaceKeyOverride,
    ),

  finalizeChatYamlStage: (body: ChatYamlStageFinalizeInput, workspaceKeyOverride?: string | null) =>
    request<ChatYamlStageFinalizeResult>(
      '/workspace/chat-yaml-stage/finalize',
      {
        method: 'POST',
        body: jsonBody(body),
      },
      workspaceKeyOverride,
    ),

  discardChatYamlStage: (stageId: string, workspaceKeyOverride?: string | null) =>
    request<{ discarded: boolean }>(
      '/workspace/chat-yaml-stage/discard',
      {
        method: 'POST',
        body: jsonBody({ stageId }),
      },
      workspaceKeyOverride,
    ),

  listWorkflowYamls: () => request<{ entries: WorkflowYamlEntry[] }>('/workspace/workflows'),

  createWorkflow: (body: { name: string; pipelinePaths?: string[] }) =>
    request<CreateWorkflowResult>('/workspace/workflows', {
      method: 'POST',
      body: jsonBody(body),
    }),

  updateWorkflow: (body: { path: string; pipelines: WorkflowPipelineEntry[] }) =>
    request<UpdateWorkflowResult>('/workspace/workflows', {
      method: 'PATCH',
      body: jsonBody(body),
    }),

  compileWorkspaceYaml: (path: string) =>
    request<YamlCompileResult>('/workspace/compile', {
      method: 'POST',
      body: jsonBody({ path }),
    }),

  copyChatResultPipeline: (body: {
    idempotencyKey?: string;
    sourcePath: string;
    restoreOriginal?: {
      path: string;
      yaml: string;
      layout: unknown;
    };
  }) =>
    request<ChatPipelineCopyResult>('/workspace/chat-result-copy', {
      method: 'POST',
      body: jsonBody(body),
    }),

  listUsage: () => request<{ records: UsageRecord[] }>('/workspace/usage'),

  appendUsage: (record: UsageRecord) =>
    request<{ ok: true }>('/workspace/usage/append', {
      method: 'POST',
      body: jsonBody(record),
    }),

  getYamlEditLock: () => request<{ lock: YamlEditLockInfo | null }>('/workspace/yaml-edit-lock'),

  acquireYamlEditLock: (
    opts?: {
      id?: string;
      reason?: string;
      ttlMs?: number;
      yamlPath?: string | null;
    },
    workspaceKeyOverride?: string | null,
  ) =>
    request<{ lock: HeldYamlEditLockInfo }>(
      '/workspace/yaml-edit-lock',
      {
        method: 'POST',
        body: jsonBody(opts ?? {}),
      },
      workspaceKeyOverride,
    ),

  releaseYamlEditLock: (id: string, workspaceKeyOverride?: string | null) =>
    request<{ ok: true; released: boolean }>(
      '/workspace/yaml-edit-lock',
      {
        method: 'DELETE',
        body: jsonBody({ id }),
      },
      workspaceKeyOverride,
    ),

  listRoots: () => request<{ roots: string[] }>('/fs/roots'),

  mkdir: async (path: string, opts?: { picker?: boolean; capabilityToken?: string | null }) => {
    const qs = opts?.picker ? '?picker=1' : '';
    return request<{ path: string }>(`/fs/mkdir${qs}`, {
      method: 'POST',
      body: jsonBody({ path, capabilityToken: opts?.capabilityToken ?? undefined }),
    });
  },

  reveal: (path: string) =>
    request<{ ok: boolean }>('/fs/reveal', { method: 'POST', body: jsonBody({ path }) }),

  setWorkDir: (workDir: string) =>
    request<ServerState>('/workspace', { method: 'PATCH', body: jsonBody({ workDir }) }),

  listRecentWorkspaces: () => request<{ recent: RecentWorkspaceEntry[] }>('/recent-workspaces'),

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

  getGlobalSettings: () => request<GlobalSettings>('/global-settings'),

  updateGlobalSettings: (patch: Partial<GlobalSettings>) =>
    request<GlobalSettings>('/global-settings', { method: 'PATCH', body: jsonBody(patch) }),

  getEditorSettings: () => request<EditorSettings>('/editor-settings'),

  updateEditorSettings: (patch: Partial<EditorSettings>) =>
    request<EditorSettings>('/editor-settings', { method: 'PATCH', body: jsonBody(patch) }),

  listSecrets: () => request<SecretsListResult>('/secrets'),

  upsertSecret: (input: SecretWriteInput) =>
    request<{ ok: true; secret: Omit<SecretEntry, 'hasValue'> }>('/secrets', {
      method: 'POST',
      body: jsonBody(input),
    }),

  deleteSecret: (id: string) =>
    request<{ ok: true }>(`/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  detectPythonAgent: () => request<PythonDetectionResult>('/python-agent/detect'),

  getPythonAgentInstallPlan: (version?: string, manager?: string | null) => {
    const params = new URLSearchParams();
    if (version) params.set('version', version);
    if (manager) params.set('manager', manager);
    const qs = params.toString();
    return request<PythonInstallPlan>(`/python-agent/install-plan${qs ? `?${qs}` : ''}`);
  },

  validatePythonAgentInterpreter: (command: string, args: string[] = []) =>
    request<PythonInterpreter>('/python-agent/validate', {
      method: 'POST',
      body: jsonBody({ command, args }),
    }),

  configurePythonAgent: (command: string, args: string[] = []) =>
    request<PythonAgentConfigureResult>('/python-agent/configure', {
      method: 'POST',
      body: jsonBody({ command, args }),
    }),

  installPythonAgent: (version?: string, manager?: string | null) =>
    request<PythonAgentInstallResult>('/python-agent/install', {
      method: 'POST',
      body: jsonBody({ version, manager }),
    }),

  disablePythonAgent: () =>
    request<{ settings: EditorSettings; revision: number }>('/python-agent/disable', {
      method: 'POST',
      body: jsonBody({}),
    }),

  getDeclaredPlugins: () => request<PluginDeclaredResult>('/plugins/declared'),

  refreshPlugins: () => request<PluginRefreshResult>('/plugins/refresh', { method: 'POST' }),

  getOpencodeInfo: () => request<OpencodeInfo>('/opencode/info'),

  restartOpencodeChat: (workspaceKeyOverride?: string | null, yamlEditLockId?: string | null) =>
    request<{ ok: true; baseUrl: string; authHeader?: string }>(
      '/opencode/chat/restart',
      {
        method: 'POST',
        ...(yamlEditLockId?.trim()
          ? { headers: { 'X-Tagma-Yaml-Lock-Id': yamlEditLockId.trim() } }
          : {}),
      },
      workspaceKeyOverride,
    ),

  updateOpencode: (version?: string) =>
    request<{ ok: true; version: string; path: string }>('/opencode/update', {
      method: 'POST',
      body: jsonBody(version ? { version } : {}),
    }),

  /**
   * Abort the in-flight opencode update's download. The /update request will
   * reject with `kind: 'canceled'` so the UI can show a "canceled" (not error)
   * state. Returns 409 if no update is in flight. Only the download phase is
   * cancellable — extract/activate run synchronously and finish too fast to
   * meaningfully cancel.
   */
  cancelOpencodeUpdate: () => request<{ ok: true }>('/opencode/update/cancel', { method: 'POST' }),

  getEditorInfo: (refresh?: boolean) =>
    request<EditorInfo>(`/editor/info${refresh ? '?refresh=1' : ''}`),

  updateEditor: () =>
    request<{ ok: true; version: string; distDir: string }>('/editor/update', {
      method: 'POST',
    }),

  /** See cancelOpencodeUpdate. */
  cancelEditorUpdate: () => request<{ ok: true }>('/editor/update/cancel', { method: 'POST' }),

  getSidecarInfo: (refresh?: boolean) =>
    request<SidecarInfo>(`/sidecar/info${refresh ? '?refresh=1' : ''}`),

  updateSidecar: () =>
    request<{ ok: true; version: string; path: string }>('/sidecar/update', {
      method: 'POST',
    }),

  /** See cancelOpencodeUpdate. */
  cancelSidecarUpdate: () => request<{ ok: true }>('/sidecar/update/cancel', { method: 'POST' }),

  /**
   * Atomically update editor-dist + sidecar binary + OpenCode in one transaction. Either
   * all components are staged and flipped, or none are — there is no
   * "editor new, sidecar old, OpenCode old" intermediate state. Caller must prompt the user
   * to restart (the bundled versions only go live after the app relaunches).
   */
  updateRelease: () => request<ReleaseUpdateResult>('/release/update', { method: 'POST' }),

  /** See cancelOpencodeUpdate. Cancels whichever component is currently downloading. */
  cancelReleaseUpdate: () => request<{ ok: true }>('/release/update/cancel', { method: 'POST' }),

  getHotupdateStatus: () => request<HotupdateStatus>('/hotupdate/status'),

  openFile: (path: string) =>
    request<ServerState>('/open', { method: 'POST', body: jsonBody({ path }) }),

  saveFile: () => request<ServerState>('/save', { method: 'POST' }),

  saveFileAs: (path: string) =>
    request<ServerState>('/save-as', { method: 'POST', body: jsonBody({ path }) }),

  newPipeline: (name?: string) =>
    request<ServerState>('/new', { method: 'POST', body: jsonBody({ name }) }),

  importFile: async (sourcePath: string, capabilityToken: string) =>
    request<ServerState>('/import-file', {
      method: 'POST',
      body: jsonBody({ sourcePath, capabilityToken }),
    }),

  exportFile: async (destDir: string, capabilityToken: string) =>
    request<{ ok: boolean; path: string }>('/export-file', {
      method: 'POST',
      body: jsonBody({ destDir, capabilityToken }),
    }),

  exportPlatformFile: async (
    destDir: string,
    targetPlatform: PlatformExportTarget,
    model: PlatformExportModel | null | undefined,
    onProgress: ((event: PlatformExportProgressEvent) => void) | undefined,
    capabilityToken: string,
  ) => requestPlatformExportFile(destDir, targetPlatform, model, onProgress, capabilityToken),

  deleteFile: (path: string) =>
    request<ServerState>('/delete-file', { method: 'POST', body: jsonBody({ path }) }),

  saveLayout: (
    positions: Record<string, LayoutTaskPosition>,
    folders?: TrackFolder[],
    trackHeights?: Record<string, number>,
  ) =>
    request<{ ok: boolean }>('/layout', {
      method: 'PATCH',
      body: jsonBody(
        folders !== undefined || trackHeights !== undefined
          ? { positions, folders, trackHeights }
          : { positions },
      ),
    }),

  // `fromRunId` triggers replay-from-history: the server loads
  // pipeline.yaml from that log dir and executes it instead of the
  // editor's S.config, without touching the editor state. A fresh
  // runId is still generated so the replay records itself as a new
  // history entry alongside the original.
  //
  // `skipPreflight: true` bypasses the requirements.md preflight check.
  // The pre-run modal sets this when the user clicks "Run anyway" after
  // being shown a missing-binaries warning.
  startRun: (opts?: StartRunOptions) => {
    const body = buildStartRunRequestBody(opts);
    return request<StartRunResult>('/run/start', {
      method: 'POST',
      body: body ? jsonBody(body) : undefined,
    });
  },

  startWorkflowRun: (path: string) =>
    request<StartWorkflowRunResult>('/run/workflow/start', {
      method: 'POST',
      body: jsonBody({ path, live: true }),
    }),

  getWorkflowRunStatus: (graphRunId?: string) => {
    const qs = graphRunId ? `?graphRunId=${encodeURIComponent(graphRunId)}` : '';
    return request<WorkflowRunStatus>(`/run/workflow/status${qs}`);
  },

  abortWorkflowRun: (graphRunId?: string) =>
    request<{ ok: boolean }>('/run/workflow/abort', {
      method: 'POST',
      body: graphRunId ? jsonBody({ graphRunId }) : undefined,
    }),

  subscribeWorkflowEvents: (
    onEvent: (event: WorkflowGraphEvent) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): (() => void) => {
    const es = new EventSource(`${BASE}${withWorkspaceParam('/run/workflow/events')}`);
    es.addEventListener('workflow_event', (e) => {
      try {
        onEvent(JSON.parse((e as MessageEvent).data) as WorkflowGraphEvent);
      } catch (_err) {
        console.warn('[workflow-events] failed to parse SSE message:', (e as MessageEvent).data);
      }
    });
    es.onopen = () => {
      onConnectionChange?.(true);
    };
    es.onerror = () => {
      onConnectionChange?.(false);
    };
    return () => es.close();
  },

  /**
   * Fetch the parsed `*.requirements.md` for the current workspace's pipeline
   * (or for an explicitly passed path). Used by the pre-run "requirements
   * missing" modal to render install snippets.
   */
  getRequirements: (path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return request<{
      path: string;
      raw: string;
      frontmatter: {
        schemaVersion: number;
        generatedFor: string;
        generatedAt: string;
        binaries: { name: string; probe?: string; usedBy: string[]; fromDriver?: string }[];
        env: { name: string; required?: boolean; description?: string }[];
        services: unknown[];
      } | null;
      body: string;
    }>(`/requirements${qs}`);
  },

  // Fetch everything the RunView needs to render a historical pipeline
  // as if it were the live one (config, DAG edges, positions). Paired
  // with startRun({ fromRunId }) — call this first to populate the
  // run-store, then kick off the run.
  getRunReplayInfo: (runId: string) =>
    request<{
      config: RawPipelineConfig;
      dagEdges: DagEdge[];
      positions: Record<string, LayoutTaskPosition>;
      trackHeights?: Record<string, number>;
    }>(`/run/history/${encodeURIComponent(runId)}/replay-info`),

  abortRun: (runId?: string) =>
    request<{ ok: boolean }>('/run/abort', {
      method: 'POST',
      body: runId ? jsonBody({ runId }) : undefined,
    }),

  subscribeRunEvents: (
    onEvent: (event: RunEvent) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): (() => void) => {
    // C8: EventSource natively sends Last-Event-ID on reconnect when the
    // server stamps events with `id:` fields (which our server does).
    // We just need to track connection state for UI feedback.
    const es = new EventSource(`${BASE}${withWorkspaceParam('/run/events')}`);
    es.addEventListener('run_event', (e) => {
      try {
        const event: RunEvent = JSON.parse(e.data);
        onEvent(event);
      } catch (_err) {
        console.warn('[run-events] failed to parse SSE message:', e.data);
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

  // ── Plugin management ──

  listPlugins: () => request<PluginListResult>('/plugins'),

  getPluginInfo: (name: string) =>
    request<PluginInfo>(`/plugins/info?name=${encodeURIComponent(name)}`),

  installPlugin: (name: string, version?: string) => {
    const installRequest = buildInstallPluginRequest(name, version);
    return request<PluginActionResult>(installRequest.path, installRequest.options);
  },

  planPluginUpgrade: (name: string) =>
    request<PluginUpgradePlan>('/plugins/upgrade-plan', {
      method: 'POST',
      body: jsonBody({ name }),
    }),

  upgradePlugin: (name: string) =>
    request<PluginUpgradeActionResult>('/plugins/upgrade', {
      method: 'POST',
      body: jsonBody({ name }),
    }),

  uninstallPlugin: (name: string, acknowledgedImpacts?: readonly PluginUninstallImpactEntry[]) =>
    request<PluginActionResult>('/plugins/uninstall', {
      method: 'POST',
      body: jsonBody({ name, acknowledgedImpacts }),
    }),

  /**
   * Pre-flight check for uninstall: returns the YAML locations that
   * reference the plugin package or its (category, type) capabilities so
   * the UI can show a confirm dialog before orphaning references. Safe to ignore for plugins that can't
   * be classified — `category` is null in that case.
   */
  uninstallImpact: (name: string) =>
    request<PluginUninstallImpact>(`/plugins/uninstall-impact?name=${encodeURIComponent(name)}`),

  loadPlugin: (name: string, opts?: { force?: boolean }) =>
    request<PluginActionResult>('/plugins/load', {
      method: 'POST',
      body: jsonBody({ name, force: opts?.force ?? false }),
    }),

  importLocalPlugin: (
    path: string,
    opts?: { declareInPipeline?: boolean; capabilityToken?: string },
  ) =>
    request<PluginActionResult>('/plugins/import-local', {
      method: 'POST',
      body: jsonBody({
        path,
        declareInPipeline: opts?.declareInPipeline,
        // Plugin import loads arbitrary local code. The server requires a
        // one-shot capability bound to (workspace, path, 'import-plugin').
        // Do not mint it here from the same raw path, or the token becomes
        // a self-service bypass. Callers must pass a token issued by a
        // trusted picker/native-dialog flow.
        capabilityToken: opts?.capabilityToken,
      }),
    }),

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
  listRunHistory: () => request<{ runs: RunHistoryEntry[] }>('/run/history'),

  getRunLog: (runId: string) =>
    request<{ runId: string; content: string }>(`/run/history/${encodeURIComponent(runId)}`),

  getRunSummary: (runId: string) =>
    request<RunSummary>(`/run/history/${encodeURIComponent(runId)}/summary`),

  getWorkflowRunHistory: (graphRunId: string) =>
    request<WorkflowRunHistoryDetail>(`/run/history/${encodeURIComponent(graphRunId)}/workflow`),

  /** Fetch a past task's full stdout/stderr. Resolves `null` when the run
   *  recorded no such stream (404) so callers can render an empty state
   *  instead of surfacing an error. */
  getRunTaskOutput: async (
    runId: string,
    taskId: string,
    stream: 'stdout' | 'stderr',
  ): Promise<RunTaskOutput | null> => {
    try {
      return await request<RunTaskOutput>(
        `/run/history/${encodeURIComponent(runId)}/task-output?taskId=${encodeURIComponent(
          taskId,
        )}&stream=${stream}`,
      );
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  },

  getRunHistoryAskAiContext: (runId: string, taskId: string) =>
    request<RunHistoryAskAiContext>(
      `/run/history/${encodeURIComponent(runId)}/ask-ai-context?taskId=${encodeURIComponent(
        taskId,
      )}`,
    ),

  getRunYamlSnapshot: async (runId: string): Promise<string | null> => {
    try {
      return await request<string>(`/run/history/${encodeURIComponent(runId)}/yaml`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  },

  // ── Approvals (F3) ──
  resolveApproval: (requestId: string, outcome: 'approved' | 'rejected') =>
    request<{ ok: boolean; stubbed?: boolean }>(`/run/approval/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: jsonBody({ outcome }),
    }),

  // ── State events (C5) ──
  // Polling fallback for clients that can't use SSE.
  reloadState: () => request<ServerState>('/state/reload'),

  // Force the server to re-read the currently-bound YAML (and sibling
  // `.layout.json`) off disk, replacing its in-memory state. Used by the
  // chat-driven external-conflict handler in App.tsx: the file-watcher's
  // conflict branch only notifies — it doesn't reload — so `getState()` would
  // otherwise return stale pre-chat-write content. This POST is the recovery
  // path that makes the silent hot-adopt actually see disk.
  reloadFromDisk: () =>
    request<ServerState>('/state/reload', { method: 'POST', body: jsonBody({}) }),

  // SSE subscription: returns an unsubscribe function. Fires for every
  // external-change / external-conflict event emitted server-side.
  subscribeStateEvents: (
    onEvent: (event: ServerStateEvent) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): (() => void) => {
    const es = new EventSource(`${BASE}${withWorkspaceParam('/state/events')}`);
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
        const eventWorkDir = event.type === 'external-change' ? event.newState?.workDir : undefined;
        const eventMatchesWorkspace =
          workspaceKey === null || eventWorkDir === undefined || eventWorkDir === workspaceKey;
        if (
          event.type === 'external-change' &&
          event.newState?.revision !== undefined &&
          eventMatchesWorkspace
        ) {
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
