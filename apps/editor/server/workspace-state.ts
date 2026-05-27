// ─────────────────────────────────────────────────────────────────────────────
// server/workspace-state.ts — Per-workspace mutable state container
// ─────────────────────────────────────────────────────────────────────────────
//
// Every chunk of server state that used to live as a module-level `let` or as
// a field on the legacy `S` singleton now lives here as an instance field.
// The sidecar keeps one `WorkspaceState` per active workspace (keyed by
// absolute normalized path), so windows bound to different workspaces never
// clobber each other's config, watcher handle, plugin registry, SSE client
// list, or run session.
//
// Backward-compat: `state.ts` still exports `S` as the "default" workspace
// (keyed `__default__`). Routes that haven't been migrated to per-request
// workspace resolution read/write that singleton — it is a real
// `WorkspaceState` with its own plugin registry and the default file watcher.
// ─────────────────────────────────────────────────────────────────────────────

import type express from 'express';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { PluginRegistry, type RegisteredCapability } from '@tagma/sdk/plugins';
import type { RawPipelineConfig } from '@tagma/sdk';
import { FileWatcher, LayoutFileWatcher, defaultFileWatcher } from './file-watcher.js';
import type { PluginWorkerHandle } from './plugins/worker-runtime.js';
import type { FileVersion } from './optimistic-lock.js';

/**
 * Editor-only grouping of tracks into a collapsible folder. Folders live in
 * the layout file, NOT in the pipeline YAML — they are an editor ergonomics
 * feature, not a pipeline concept. A track may belong to at most one folder;
 * tracks with no membership render at the top level.
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

/** Editor layout data stored alongside the YAML file as .layout.json */
export interface EditorLayout {
  positions: Record<string, { x: number }>;
  /**
   * Editor-only track grouping. Optional for backward compat — older layout
   * files without this field load as if every track is at the top level.
   */
  folders?: TrackFolder[];
}

/** Public, non-secret lock metadata sent to renderer clients. */
export interface YamlEditLockPublic {
  owner: 'chat';
  reason: string;
  acquiredAt: number;
  expiresAt: number;
  /** Absolute YAML path protected by the lock, or null for a workspace-wide lock. */
  yamlPath: string | null;
}

/** Server-only edit lock token. The id is only returned to the lock holder. */
export interface YamlEditLock extends YamlEditLockPublic {
  id: string;
}

/** SSE client handle for state-event broadcasts. */
export interface StateEventClient {
  res: express.Response;
}

/**
 * Per-workspace record of a loaded plugin — which capabilities it occupies in
 * the workspace's registry plus the staging directory that backs its ESM
 * module URL.
 */
export interface LoadedPluginMeta {
  registrations: readonly Pick<RegisteredCapability, 'category' | 'type'>[];
  /** Staging directory created by stagePluginForImport. Cleaned up on rollback. */
  stageDir?: string;
  /** Isolated runtime worker that owns the plugin module evaluation. */
  worker?: PluginWorkerHandle;
}

/**
 * Container for every piece of mutable state that is scoped to a single
 * workspace. Constructed once per workspace via `WorkspaceRegistry.getOrCreate`
 * (see `workspace-registry.ts`).
 */
export class WorkspaceState {
  /** Normalized absolute path that identifies this workspace. */
  readonly key: string;

  /** Working directory for the pipeline run (= `key` for real workspaces). */
  workDir: string;

  /** In-memory pipeline config (authoritative after load/save). */
  config: RawPipelineConfig;

  /** Absolute path to the YAML this `config` was loaded from (or null). */
  yamlPath: string | null;

  /**
   * F12: Optimistic locking version for the YAML file. Captured at load time
   * and checked before save to detect external modifications. Null when no
   * file is loaded or for new (unsaved) pipelines.
   */
  yamlVersion: FileVersion | null;

  /** Editor positions persisted alongside the YAML. */
  layout: EditorLayout;

  /** Monotonic mutation revision (ETag/If-Match). */
  stateRevision: number;

  /** Monotonic SSE event sequence for external-change notifications. */
  stateEventSeq: number;

  /** Plugin registry scoped to this workspace. */
  registry: PluginRegistry;

  /** File watcher handle for the YAML this workspace has loaded. */
  watcher: FileWatcher;

  /**
   * Sibling watcher for the YAML's companion `.layout.json`. The main
   * `watcher` only fires for the YAML itself — without this second watcher,
   * external edits to the layout file (e.g. opencode chat updating
   * positions) never reach `loadLayout(ws)` and the canvas keeps showing
   * stale positions until the workspace is re-opened.
   */
  layoutWatcher: LayoutFileWatcher;

  /**
   * Cooperative YAML/layout edit lock. Acquired while OpenCode chat is allowed
   * to write `.tagma/*.yaml` and sibling `.layout.json` files, so editor UI
   * mutations cannot race those writes. External disk editors are still
   * handled by the file-watch conflict path.
   */
  yamlEditLock: YamlEditLock | null;

  /** SSE subscribers for this workspace's state events. */
  readonly stateEventClients: Set<StateEventClient>;

  // ── Plugin loader per-workspace caches ─────────────────────────────────
  /** Plugins currently loaded into `this.registry`, keyed by package name. */
  readonly loadedPluginMeta: Map<string, LoadedPluginMeta>;

  /** Capability owner map, keyed as `${category}/${type}` -> plugin package name. */
  readonly pluginCapabilityOwners: Map<string, string>;

  /** Errors collected during the most recent autoLoadInstalledPlugins pass. */
  lastAutoLoadErrors: Array<{ name: string; message: string }>;

  /** Installed-plugin discovery cache. */
  installedPluginsCache: string[] | null;
  installedPluginsCacheTime: number;

  /** Workspace-declared-plugin discovery cache (union of .tagma/*.yaml). */
  workspaceDeclaredPluginsCache: string[] | null;
  workspaceDeclaredPluginsCacheTime: number;

  /**
   * Per-plugin-name operation lock, keyed by package name. Serializes
   * install / upgrade / uninstall against the same plugin within this
   * workspace; cross-workspace ops against the same name do NOT block each
   * other because they operate on different `node_modules/` trees.
   */
  readonly pluginOpLocks: Map<string, Promise<unknown>>;

  // ── Run session fields ─────────────────────────────────────────────────
  /** Live pipeline runs for this workspace, keyed by runId. */
  readonly runSessions: Map<string, unknown>;

  /** Atomic guard covering the async window of /api/run/start. */
  runSessionStarting: boolean;

  /** Owner token for the current async run start, if one is in progress. */
  runSessionStartToken: symbol | null;

  /** Run-event SSE subscribers for this workspace. */
  readonly runSseClients: Set<express.Response>;

  /** Live workflow graph run for this workspace, if one is active. */
  workflowRunSession: unknown;

  /** Workflow graph SSE subscribers for this workspace. */
  readonly workflowSseClients: Set<express.Response>;

  constructor(key: string, opts: { registry?: PluginRegistry; watcher?: FileWatcher } = {}) {
    this.key = key;
    this.workDir = '';
    this.config = createEmptyPipeline('Untitled Pipeline');
    this.yamlPath = null;
    this.yamlVersion = null;
    this.layout = { positions: {} };
    this.stateRevision = 0;
    this.stateEventSeq = 0;
    this.registry = opts.registry ?? new PluginRegistry();
    this.watcher = opts.watcher ?? new FileWatcher();
    // Layout watcher is per-workspace and never shared — there is no legacy
    // free-function API on top of LayoutFileWatcher to keep in sync, so a
    // fresh instance per workspace is correct (no defaultLayoutFileWatcher).
    this.layoutWatcher = new LayoutFileWatcher();
    this.yamlEditLock = null;
    this.stateEventClients = new Set<StateEventClient>();

    this.loadedPluginMeta = new Map();
    this.pluginCapabilityOwners = new Map();
    this.lastAutoLoadErrors = [];
    this.installedPluginsCache = null;
    this.installedPluginsCacheTime = 0;
    this.workspaceDeclaredPluginsCache = null;
    this.workspaceDeclaredPluginsCacheTime = 0;
    this.pluginOpLocks = new Map();

    this.runSessions = new Map<string, unknown>();
    this.runSessionStarting = false;
    this.runSessionStartToken = null;
    this.runSseClients = new Set<express.Response>();
    this.workflowRunSession = null;
    this.workflowSseClients = new Set<express.Response>();
  }
}

/**
 * Build the default-key workspace. It gets its own registry like every other
 * workspace, and `workspace-registry.ts` seeds built-ins after creation.
 */
export function createDefaultWorkspaceState(key: string): WorkspaceState {
  return new WorkspaceState(key, {
    watcher: defaultFileWatcher,
  });
}
