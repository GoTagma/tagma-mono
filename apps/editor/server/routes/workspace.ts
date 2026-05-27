import type express from 'express';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  mkdirSync,
  rmSync,
  renameSync,
  appendFileSync,
} from 'node:fs';
import { resolve, dirname, basename, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { createEmptyPipeline, upsertTrack, upsertTask } from '@tagma/sdk/config';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import {
  parseWorkflowYaml,
  validateRawWorkflow,
} from '@tagma/sdk/workflow';
import type { PipelineGraphStopWhen } from '@tagma/types';
import {
  getState,
  isPathWithin,
  assertWithinWorkspace,
  loadLayout,
  saveLayout,
  sanitizeFoldersInput,
  beginWatching,
  lenientParseYaml,
  withDefaultTrackColors,
  broadcastStateEvent,
} from '../state.js';
import { errorMessage, atomicWriteFileSync } from '../path-utils.js';
import { runCompileAndWriteLog } from '../compile-log.js';
import { buildYamlSkeletonFromManifest, pipelineManifestPath, runPipelineManifestSync } from '../pipeline-manifest.js';
import { ALLOWED_ORIGINS } from '../allowed-origins.js';
import {
  consumeFsCapability,
  isValidFsCapabilityPurpose,
  issueFsCapability,
} from '../fs-capability.js';

import { requireWorkspace } from '../require-workspace.js';
import {
  getFileVersion,
  assertFileUnchanged,
  OptimisticLockConflictError,
  buildConflictResponse,
} from '../optimistic-lock.js';
import {
  normalizeWorkspaceKey,
  workspaceRegistry,
  isValidWorkspaceKey,
} from '../workspace-registry.js';
import {
  autoLoadInstalledPlugins,
  readEditorSettings,
  writeEditorSettings,
  DEFAULT_EDITOR_SETTINGS,
  invalidatePluginCache,
  isValidChatDirtyConflictPolicy,
  isValidEditorViewMode,
  parseOpenCodeChatModelSelection,
  parsePythonAgentSettings,
  type EditorSettings,
} from '../plugins/loader.js';
import { recordWorkspaceOpen } from './recent.js';
import { generateConfigId } from '../../shared/config-id.js';
import {
  acquireYamlEditLock,
  releaseYamlEditLock,
  getActiveYamlEditLock,
  publicYamlEditLock,
  DEFAULT_YAML_EDIT_LOCK_TTL_MS,
} from '../yaml-edit-lock.js';
import { withWorkspacePluginMutationLock } from '../plugins/locks.js';
import {
  convertPipelineYamlForPlatform,
  currentTagmaPlatform,
  normalizeTagmaPlatform,
  parsePlatformExportModelPick,
  platformDisplayName,
  platformExportPath,
  type PlatformExportProgress,
} from '../platform-export.js';
import {
  ensureOpencode,
  ensureRealTagmaDirectory,
  restartOpencode,
} from '../opencode-lifecycle.js';
import { seedOpencodeArtifacts } from '../opencode-seed.js';
import { startChatCompileWatcher } from '../chat-compile-watcher.js';
import {
  assertPipelineFolderPath,
  assertPipelineYamlPath,
  enumeratePipelineYamls,
  enumerateFlatPipelineYamls,
  pipelineYamlPath,
  sanitizePipelineStem,
  stemFromYamlBasename,
  tagmaDirOf,
} from '../pipeline-paths.js';
import {
  assertWorkflowYamlPath,
  enumerateWorkflowYamls,
  sanitizeWorkflowStem,
  workflowYamlPath,
} from '../workflow-paths.js';
import {
  formatMigrationWarnings,
  isUnmigratableFlatYaml,
  migrateFlatPipelinesToFolders,
} from '../workspace-migrate.js';
import { deletePipelineSecretBindings } from '../secrets.js';

const MAX_FS_LIST_ENTRIES = 1_000;
const MAX_YAML_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LAYOUT_FILE_BYTES = 5 * 1024 * 1024;

// Usage-stat caps. Each row is a single JSON object on its own line, so the
// per-record cap mostly bounds metadata bloat (a finish-string blowing up to
// MB), and the total-file cap caps long-tail growth. When the file would
// exceed the total cap, the writer rotates `usage.jsonl` → `usage.1.jsonl`
// (overwriting the previous rotation) and starts fresh. Read paths support
// pagination so the dashboard can render the file without slurping the
// whole thing into memory at once.
const MAX_USAGE_RECORD_JSON_BYTES = 8 * 1024;
const MAX_USAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_USAGE_RECORDS_PER_PAGE = 5_000;
const MAX_FINITE_NUMBER = 1e15;
const MAX_USAGE_STRING_LEN = 256;
const MAX_LAYOUT_COORD = 100_000;
const MAX_LAYOUT_TRACK_IDS = 10_000;
const MAX_WORKFLOW_GRAPH_COORD = 100_000;
const WORKFLOW_YAML_DUMP_OPTIONS = {
  lineWidth: 120,
  indent: 2,
  noCompatMode: true,
} as Parameters<typeof yaml.dump>[1] & { noCompatMode: boolean };

function clipString(value: unknown, max = MAX_USAGE_STRING_LEN): string {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function clampFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value > MAX_FINITE_NUMBER) return MAX_FINITE_NUMBER;
  if (value < -MAX_FINITE_NUMBER) return -MAX_FINITE_NUMBER;
  return value;
}

function clampNonNegativeNumber(value: unknown): number {
  return Math.max(0, clampFiniteNumber(value));
}

function clampWorkflowGraphCoord(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_WORKFLOW_GRAPH_COORD, Math.max(0, Math.round(value)));
}

function readJsonlTailText(
  filePath: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const size = statSync(filePath).size;
  if (size <= maxBytes) return { text: readFileSync(filePath, 'utf-8'), truncated: false };
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const offset = Math.max(0, size - maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, offset);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    const firstNewline = text.indexOf('\n');
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    return { text, truncated: true };
  } finally {
    closeSync(fd);
  }
}

export function parseEditorSettingsPatch(body: unknown): Partial<EditorSettings> {
  const patch: Partial<EditorSettings> = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return patch;
  const raw = body as Record<string, unknown>;

  if (typeof raw.autoInstallDeclaredPlugins === 'boolean') {
    patch.autoInstallDeclaredPlugins = raw.autoInstallDeclaredPlugins;
  }
  if (isValidChatDirtyConflictPolicy(raw.chatDirtyConflictPolicy)) {
    patch.chatDirtyConflictPolicy = raw.chatDirtyConflictPolicy;
  }
  if (typeof raw.autoSaveEnabled === 'boolean') {
    patch.autoSaveEnabled = raw.autoSaveEnabled;
  }
  if (typeof raw.autoSaveIntervalSec === 'number' && Number.isFinite(raw.autoSaveIntervalSec)) {
    patch.autoSaveIntervalSec = raw.autoSaveIntervalSec;
  }
  if (typeof raw.chatContextRounds === 'number' && Number.isFinite(raw.chatContextRounds)) {
    patch.chatContextRounds = raw.chatContextRounds;
  }
  if (isValidEditorViewMode(raw.viewMode)) {
    patch.viewMode = raw.viewMode;
  }
  const pythonAgent = parsePythonAgentSettings(raw.pythonAgent);
  if (pythonAgent) {
    patch.pythonAgent = pythonAgent;
  }
  if (raw.opencodeChatModel === null) {
    patch.opencodeChatModel = null;
  } else {
    const opencodeChatModel = parseOpenCodeChatModelSelection(raw.opencodeChatModel);
    if (opencodeChatModel) {
      patch.opencodeChatModel = opencodeChatModel;
    }
  }
  return patch;
}

/** Given a YAML path, return the companion layout.json path. */
function companionLayoutPath(yamlFilePath: string): string {
  return yamlFilePath.replace(/\.ya?ml$/i, '.layout.json');
}

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function assertFileSizeAtMost(path: string, maxBytes: number, label: string): void {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`${label} is too large (${size} bytes, max ${maxBytes})`);
  }
}

/**
 * Build a `WorkspaceYamlEntry`-shaped object the picker consumes. Shared by
 * the foldered-pipeline enumeration and the stranded-flat-file fallback so
 * the two code paths can't drift on hash / mtime / pipelineName logic.
 */
function describeYamlEntry(
  absPath: string,
  basenameValue: string,
  layoutFile: string,
  unmigratable: boolean,
): Record<string, unknown> {
  const stat = statSync(absPath);
  const canReadYaml = stat.size <= MAX_YAML_FILE_BYTES;
  const content = canReadYaml ? readFileSync(absPath, 'utf-8') : '';
  let layoutHash: string | null = null;
  let layoutMtimeMs: number | null = null;
  let layoutSize: number | null = null;
  if (existsSync(layoutFile)) {
    try {
      const layoutStat = statSync(layoutFile);
      if (layoutStat.size <= MAX_LAYOUT_FILE_BYTES) {
        const layoutContent = readFileSync(layoutFile, 'utf-8');
        layoutHash = sha1(layoutContent);
      }
      layoutMtimeMs = layoutStat.mtimeMs;
      layoutSize = layoutStat.size;
    } catch {
      layoutHash = null;
      layoutMtimeMs = null;
      layoutSize = null;
    }
  }
  let pipelineName: string | null = null;
  if (canReadYaml) {
    try {
      const doc = yaml.load(content) as Record<string, unknown> | null;
      const pipeline =
        doc && typeof doc === 'object' && 'pipeline' in doc
          ? (doc.pipeline as Record<string, unknown>)
          : null;
      const candidate =
        (pipeline && typeof pipeline.name === 'string' && pipeline.name) ||
        (doc && typeof doc.name === 'string' && doc.name) ||
        null;
      if (candidate && String(candidate).trim()) pipelineName = String(candidate).trim();
    } catch (_err) {
      /* non-YAML or unreadable file — pipelineName stays null */
    }
  }
  const entry: Record<string, unknown> = {
    name: basenameValue,
    path: absPath,
    pipelineName,
    contentHash: canReadYaml ? sha1(content) : sha1(`${stat.size}:${stat.mtimeMs}`),
    layoutHash,
    layoutMtimeMs,
    layoutSize,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
  if (unmigratable) entry.unmigratable = true;
  return entry;
}

function describeWorkflowEntry(absPath: string, basenameValue: string): Record<string, unknown> {
  const stat = statSync(absPath);
  const canReadYaml = stat.size <= MAX_YAML_FILE_BYTES;
  const content = canReadYaml ? readFileSync(absPath, 'utf-8') : '';
  let workflowName: string | null = null;
  let pipelines: Array<{
    id: string;
    path: string;
    depends_on: string[];
    position?: { x: number; y: number };
    lifecycle?: { max_runs?: number; stop_when?: PipelineGraphStopWhen };
  }> = [];
  if (canReadYaml) {
    try {
      const doc = yaml.load(content) as Record<string, unknown> | null;
      const workflow =
        doc && typeof doc === 'object' && 'workflow' in doc
          ? (doc.workflow as Record<string, unknown>)
          : null;
      if (workflow && typeof workflow.name === 'string' && workflow.name.trim()) {
        workflowName = workflow.name.trim();
      }
      const rawPipelines = workflow && Array.isArray(workflow.pipelines) ? workflow.pipelines : [];
      pipelines = rawPipelines
        .filter((entry): entry is Record<string, unknown> => {
          return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
        })
        .map((entry) => ({
          id: typeof entry.id === 'string' ? entry.id : '',
          path: typeof entry.path === 'string' ? entry.path : '',
          depends_on: Array.isArray(entry.depends_on)
            ? entry.depends_on.filter((dep): dep is string => typeof dep === 'string')
            : [],
          position: readWorkflowPosition(entry.position),
          lifecycle: readWorkflowLifecycle(entry.lifecycle),
        }))
        .filter((entry) => entry.id.length > 0);
    } catch {
      workflowName = null;
      pipelines = [];
    }
  }
  return {
    name: basenameValue,
    path: absPath,
    workflowName,
    pipelines,
    contentHash: canReadYaml ? sha1(content) : sha1(`${stat.size}:${stat.mtimeMs}`),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function readWorkflowPosition(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { x?: unknown; y?: unknown };
  const x = clampWorkflowGraphCoord(raw.x);
  const y = clampWorkflowGraphCoord(raw.y);
  if (x === null || y === null) return undefined;
  return { x, y };
}

function readWorkflowLifecycle(
  value: unknown,
): { max_runs?: number; stop_when?: PipelineGraphStopWhen } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as { max_runs?: unknown; stop_when?: unknown };
  const lifecycle: { max_runs?: number; stop_when?: PipelineGraphStopWhen } = {};
  if (Number.isInteger(raw.max_runs) && (raw.max_runs as number) > 0) {
    lifecycle.max_runs = raw.max_runs as number;
  }
  if (
    raw.stop_when === 'success' ||
    raw.stop_when === 'failure' ||
    raw.stop_when === 'always'
  ) {
    lifecycle.stop_when = raw.stop_when;
  }
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

function workspaceRelativePath(workDir: string, absPath: string): string {
  return relative(resolve(workDir), resolve(absPath)).replace(/\\/g, '/');
}

function workflowPipelineIdForPath(absPath: string, index: number, used: Set<string>): string {
  const stem = stemFromYamlBasename(basename(absPath));
  const normalized = stem.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = /^[A-Za-z_]/.test(normalized)
    ? normalized
    : normalized
      ? `p_${normalized}`
      : `pipeline_${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeWorkflowGraphPipelinesInput(
  workDir: string,
  value: unknown,
): Array<{
  id: string;
  path: string;
  depends_on?: string[];
  position?: { x: number; y: number };
  lifecycle?: { max_runs?: number; stop_when?: PipelineGraphStopWhen };
}> {
  if (!Array.isArray(value)) {
    throw new Error('pipelines must be an array');
  }
  const seenIds = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`pipelines[${index}] must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) throw new Error(`pipelines[${index}].id is required`);
    if (seenIds.has(id)) throw new Error(`Duplicate pipeline id "${id}"`);
    seenIds.add(id);

    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!rawPath) throw new Error(`pipelines[${index}].path is required`);
    const absPath = assertPipelineYamlPath(
      workDir,
      resolve(workDir, rawPath),
      `workflow pipeline ${id}`,
    );
    if (!existsSync(absPath)) throw new Error(`Pipeline file not found: ${absPath}`);

    const depends_on =
      Array.isArray(entry.depends_on) && entry.depends_on.length > 0
        ? [
            ...new Set(
              entry.depends_on.map((dep, depIndex) => {
                if (typeof dep !== 'string' || dep.trim().length === 0) {
                  throw new Error(
                    `pipelines[${index}].depends_on[${depIndex}] must be a non-empty string`,
                  );
                }
                return dep.trim();
              }),
            ),
          ]
        : undefined;
    const position = readWorkflowPosition(entry.position);
    if (entry.position !== undefined && !position) {
      throw new Error(`pipelines[${index}].position must include finite x and y numbers`);
    }
    const lifecycle = normalizeWorkflowLifecycleInput(entry.lifecycle, index);

    return {
      id,
      path: workspaceRelativePath(workDir, absPath),
      ...(depends_on ? { depends_on } : {}),
      ...(position ? { position } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
  });
}

function normalizeWorkflowLifecycleInput(
  value: unknown,
  pipelineIndex: number,
): { max_runs?: number; stop_when?: PipelineGraphStopWhen } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`pipelines[${pipelineIndex}].lifecycle must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const lifecycle: { max_runs?: number; stop_when?: PipelineGraphStopWhen } = {};
  if (raw.max_runs !== undefined) {
    if (!Number.isInteger(raw.max_runs) || (raw.max_runs as number) < 1) {
      throw new Error(`pipelines[${pipelineIndex}].lifecycle.max_runs must be a positive integer`);
    }
    lifecycle.max_runs = raw.max_runs as number;
  }
  if (raw.stop_when !== undefined) {
    if (raw.stop_when !== 'success' && raw.stop_when !== 'failure' && raw.stop_when !== 'always') {
      throw new Error(
        `pipelines[${pipelineIndex}].lifecycle.stop_when must be "success", "failure", or "always"`,
      );
    }
    lifecycle.stop_when = raw.stop_when;
  }
  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

function serializeWorkflowGraphForEditor(config: {
  kind?: 'workflow' | 'graph';
  name: string;
  max_concurrency?: number;
  failure_policy?: string;
  pipelines: Array<{
    id: string;
    path: string;
    depends_on?: string[];
    position?: { x: number; y: number };
    lifecycle?: { max_runs?: number; stop_when?: PipelineGraphStopWhen };
  }>;
}): string {
  return yaml.dump(
    {
      workflow: {
        kind: config.kind ?? 'graph',
        name: config.name,
        ...(config.max_concurrency !== undefined
          ? { max_concurrency: config.max_concurrency }
          : {}),
        ...(config.failure_policy ? { failure_policy: config.failure_policy } : {}),
        pipelines: config.pipelines.map((pipeline) => ({
          id: pipeline.id,
          path: pipeline.path,
          ...(pipeline.depends_on?.length ? { depends_on: pipeline.depends_on } : {}),
          ...(pipeline.position ? { position: pipeline.position } : {}),
          ...(pipeline.lifecycle ? { lifecycle: pipeline.lifecycle } : {}),
        })),
      },
    },
    WORKFLOW_YAML_DUMP_OPTIONS,
  );
}

export function registerWorkspaceRoutes(app: express.Express): void {
  // ── Workspace ──
  // NOTE: GET /api/workspace removed — same data is included in GET /api/state.

  // PATCH /api/workspace is the switch-point. Unlike other mutation routes
  // it does NOT use requireWorkspace: the request may come from a window in
  // the Welcome state (no `X-Tagma-Workspace` header). We resolve the
  // target workspace from the body, create/look up its `WorkspaceState`,
  // initialize it, and return that state. The client then updates its
  // outgoing `X-Tagma-Workspace` header to the normalized path so every
  // subsequent request hits the right workspace.
  // Electron signals "last window bound to this workspace closed" via this
  // endpoint so the sidecar can release the PluginRegistry / FileWatcher /
  // SSE subscriber list the workspace was holding. Best-effort by design:
  // missing/unknown keys return { dropped: false } without erroring, so the
  // caller (electron/main.ts) can fire-and-forget during window teardown.
  app.post('/api/workspace/drop', (req, res) => {
    const { workDir } = (req.body ?? {}) as { workDir?: unknown };
    if (typeof workDir !== 'string' || workDir.trim().length === 0) {
      return res.status(400).json({ error: 'workDir is required' });
    }
    const key = normalizeWorkspaceKey(workDir);
    const dropped = workspaceRegistry.drop(key);
    res.json({ dropped });
  });

  app.get('/api/workspace/yaml-edit-lock', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    res.json({ lock: publicYamlEditLock(getActiveYamlEditLock(ws)) });
  });

  app.post('/api/workspace/yaml-edit-lock', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = (req.body ?? {}) as {
      id?: unknown;
      reason?: unknown;
      ttlMs?: unknown;
      yamlPath?: unknown;
    };
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    const ttlMs =
      typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs)
        ? body.ttlMs
        : DEFAULT_YAML_EDIT_LOCK_TTL_MS;
    let yamlPath: string | null | undefined;
    if (typeof body.yamlPath === 'string' && body.yamlPath.trim()) {
      if (!ws.workDir) {
        return res.status(400).json({
          error: 'Workspace directory is not set; cannot resolve YAML edit lock path.',
        });
      }
      const resolvedYamlPath = resolve(body.yamlPath.trim());
      if (!isPathWithin(resolvedYamlPath, ws.workDir)) {
        return res.status(400).json({ error: 'YAML edit lock path is outside the workspace.' });
      }
      yamlPath = resolvedYamlPath;
    } else {
      yamlPath = body.yamlPath === null ? null : undefined;
    }
    const result = acquireYamlEditLock(ws, { id, reason, ttlMs, yamlPath });
    if (!result.ok) {
      return res.status(423).json({
        error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
        lock: publicYamlEditLock(result.lock),
      });
    }
    if (!result.refreshed) {
      broadcastStateEvent(ws, { type: 'state_sync', newState: getState(ws) });
    }
    res.json({ lock: result.lock });
  });

  app.delete('/api/workspace/yaml-edit-lock', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = (req.body ?? {}) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return res.status(400).json({ error: 'lock id is required' });
    }
    const released = releaseYamlEditLock(ws, body.id.trim());
    if (released) {
      broadcastStateEvent(ws, { type: 'state_sync', newState: getState(ws) });
    }
    res.json({ ok: true, released });
  });

  app.patch('/api/workspace', async (req, res) => {
    const { workDir: wd } = req.body;
    if (wd === undefined) {
      // No workDir supplied — read-only "switch to current" no-op. Rare;
      // mostly legacy. Resolve the header-bound workspace if present,
      // otherwise fall back to returning the default workspace's state.
      const ws = req.workspace ?? workspaceRegistry.getOrCreate('__default__');
      return res.json(getState(ws));
    }
    if (typeof wd !== 'string' || wd.trim().length === 0) {
      return res.status(400).json({ error: 'workDir must be a non-empty string' });
    }
    const normalized = normalizeWorkspaceKey(wd);
    // Refuse to materialize a WorkspaceState for a path that doesn't
    // resolve to an existing directory. Without this a typo in the client
    // (or a stale entry in the Recent list) would still spin up a
    // PluginRegistry + FileWatcher + SSE subscriber set and leak them
    // until process exit, since nothing else cleans up unreachable keys.
    if (!isValidWorkspaceKey(normalized)) {
      return res.status(400).json({
        error: 'workDir does not resolve to an existing directory',
        workDir: normalized,
      });
    }
    // Guard against header/body drift. Clients are expected to call
    // setClientWorkspace(wd) before this PATCH, so the header should already
    // match the body. If they diverge the client has a bug — fail loudly
    // instead of silently favouring `body` and routing subsequent requests
    // through a different WorkspaceState than the one we just switched into.
    // The default sentinel passes through because the header is absent on
    // boot when the window first hydrates from the welcome page.
    if (req.workspace && req.workspace.key !== normalized && req.workspace.key !== '__default__') {
      return res.status(400).json({
        error: 'header/body workspace mismatch',
        headerKey: req.workspace.key,
        bodyKey: normalized,
      });
    }
    const ws = workspaceRegistry.getOrCreate(normalized);
    ws.workDir = normalized;
    invalidatePluginCache(ws);
    mkdirSync(join(ws.workDir, '.tagma'), { recursive: true });
    // Migrate any flat .tagma/*.yaml + companions into per-pipeline folders
    // BEFORE plugin auto-load. The loader's declared-plugin scanner reads
    // pipelines via the new layout helper; flat files would otherwise be
    // invisible to that scan and the workspace would miss declared plugins.
    const migrationReport = migrateFlatPipelinesToFolders(ws);
    await withWorkspacePluginMutationLock(ws, () => autoLoadInstalledPlugins(ws));
    recordWorkspaceOpen(ws.workDir);
    const state = getState(ws);
    const warnings = formatMigrationWarnings(migrationReport);
    if (warnings.length > 0) {
      (state as Record<string, unknown>).migrationWarnings = warnings;
    }
    res.json(state);
  });

  // ── Editor settings (per-workspace user preferences) ──
  app.get('/api/editor-settings', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.json({ ...DEFAULT_EDITOR_SETTINGS });
    }
    res.json(readEditorSettings(ws));
  });

  app.patch('/api/editor-settings', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    const patch = parseEditorSettingsPatch(req.body);
    try {
      const next = writeEditorSettings(ws, patch);
      res.json({ ...next, revision: ws.stateRevision });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Failed to save editor settings: ${msg}` });
    }
  });

  // ── Chat usage stats (per-workspace, append-only NDJSON) ──
  // Each record represents one assistant turn: ts, model, providerID, tokens,
  // cost. Stored under `<workDir>/.tagma/.usage/usage.jsonl` as one JSON
  // object per line so the file is cheap to append, easy to tail, and trivial
  // to migrate to a database later (each line is already a row).
  app.post('/api/workspace/usage/append', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    const raw = req.body as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: 'usage record must be an object' });
    }
    const messageID = clipString(raw.messageID);
    if (!messageID) {
      return res.status(400).json({ error: 'messageID is required' });
    }
    const record = {
      ts:
        typeof raw.ts === 'number' && Number.isFinite(raw.ts)
          ? clampFiniteNumber(raw.ts, Date.now())
          : Date.now(),
      messageID,
      sessionID: clipString(raw.sessionID),
      providerID: clipString(raw.providerID),
      modelID: clipString(raw.modelID),
      tokensIn: clampNonNegativeNumber(raw.tokensIn),
      tokensOut: clampNonNegativeNumber(raw.tokensOut),
      tokensReasoning: clampNonNegativeNumber(raw.tokensReasoning),
      cacheRead: clampNonNegativeNumber(raw.cacheRead),
      cacheWrite: clampNonNegativeNumber(raw.cacheWrite),
      finish: clipString(raw.finish),
    };
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line, 'utf-8') > MAX_USAGE_RECORD_JSON_BYTES) {
      return res.status(413).json({
        error: `usage record exceeds ${MAX_USAGE_RECORD_JSON_BYTES}-byte cap`,
      });
    }
    const usageDir = join(ws.workDir, '.tagma', '.usage');
    const usageFile = join(usageDir, 'usage.jsonl');
    const rotatedFile = join(usageDir, 'usage.1.jsonl');
    try {
      mkdirSync(usageDir, { recursive: true });
      // Rotate when the next append would push the active file past the
      // cap. We keep one previous generation (`usage.1.jsonl`) so the
      // dashboard can still page through historical data, but never grow
      // it unboundedly.
      if (existsSync(usageFile)) {
        const sz = statSync(usageFile).size;
        if (sz + line.length > MAX_USAGE_FILE_BYTES) {
          try {
            if (existsSync(rotatedFile)) rmSync(rotatedFile, { force: true });
            // Best-effort rename — if it fails (e.g. concurrent reader on
            // Windows holding a handle) we drop the rotation and keep
            // appending; nothing crashes the request path.
            renameSync(usageFile, rotatedFile);
          } catch {
            /* best-effort */
          }
        }
      }
      appendFileSync(usageFile, line, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Failed to append usage: ${msg}` });
    }
  });

  app.get('/api/workspace/usage', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.json({ records: [], totalRecords: 0, hasMore: false });
    const usageFile = join(ws.workDir, '.tagma', '.usage', 'usage.jsonl');
    if (!existsSync(usageFile)) return res.json({ records: [], totalRecords: 0, hasMore: false });
    // Pagination: `limit` caps page size; `before` skips records with `ts >=
    // before`, supporting "load older" infinite scroll. Both are optional —
    // the default returns the most recent page, which is what every existing
    // caller (dashboard) expects.
    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), MAX_USAGE_RECORDS_PER_PAGE)
        : MAX_USAGE_RECORDS_PER_PAGE;
    const rawBefore = Number(req.query.before);
    const before = Number.isFinite(rawBefore) ? rawBefore : null;
    try {
      const { text, truncated } = readJsonlTailText(usageFile, MAX_USAGE_FILE_BYTES);
      const lines = text.split('\n');
      // Iterate newest-first by walking from the end. We don't sort by `ts`
      // because the file is append-only; insertion order tracks creation
      // time for any reasonable producer.
      const records: unknown[] = [];
      let total = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]!.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown> | null = null;
        try {
          const obj = JSON.parse(trimmed) as unknown;
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            parsed = obj as Record<string, unknown>;
          }
        } catch {
          continue;
        }
        if (!parsed) continue;
        total += 1;
        if (before !== null) {
          const ts = typeof parsed.ts === 'number' ? parsed.ts : Number.NaN;
          if (Number.isFinite(ts) && ts >= before) continue;
        }
        if (records.length < limit) records.push(parsed);
      }
      // hasMore must reflect "is there more we couldn't return", not "is
      // total > returned". With `before=X`, total counts every parsed record
      // but records.length only counts those filtered+limited — comparing
      // them lights up hasMore even when we actually exhausted the older
      // tail. Tying it to the limit boundary is what `before` callers need
      // for "load older": stop paging once we returned fewer than asked.
      res.json({
        records,
        totalRecords: total,
        hasMore: truncated || records.length === limit,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Failed to read usage: ${msg}` });
    }
  });

  // ── Filesystem browsing ──
  //
  // C3: /api/fs/list now operates in two modes:
  //   - "workspace" (default): refuses to list anything outside workDir.
  //   - "picker"   (?picker=1): used only by the dedicated workspace-root
  //     picker UI; needs to walk the host filesystem so users can switch
  //     work directories. Confined to GET so it stays harmless under CSRF
  //     (no state changes), and still resolves the path to defeat relative
  //     traversal tricks.
  app.get('/api/fs/list', (req, res) => {
    const isPicker = req.query.picker === '1' || req.query.picker === 'true';
    // Picker mode allows browsing outside any workspace — the Welcome page
    // uses it to let the user pick a root before a workspace exists. Other
    // modes require a workspace binding on the request.
    if (!isPicker) {
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      const requested = (req.query.path as string) || ws.workDir;
      let dirPath = resolve(requested);
      try {
        if (!existsSync(dirPath)) {
          dirPath = dirname(dirPath);
          if (!existsSync(dirPath)) {
            return res.status(404).json({ error: `Directory not found: ${dirPath}` });
          }
        }
        if (!statSync(dirPath).isDirectory()) {
          dirPath = dirname(dirPath);
        }
        try {
          assertWithinWorkspace(ws, dirPath, 'directory');
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Path is outside the workspace directory';
          return res.status(403).json({ error: msg });
        }
        const dirEntries = readdirSync(dirPath, { withFileTypes: true });
        const allEntries = dirEntries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({
            name: e.name,
            path: resolve(dirPath, e.name),
            type: e.isDirectory() ? ('directory' as const) : ('file' as const),
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        const entries = allEntries.slice(0, MAX_FS_LIST_ENTRIES);
        const parent = dirname(dirPath);
        return res.json({
          path: dirPath,
          parent: parent !== dirPath ? parent : null,
          entries,
          truncated: allEntries.length > MAX_FS_LIST_ENTRIES,
        });
      } catch (err: unknown) {
        return res.status(500).json({ error: errorMessage(err) || 'Failed to list directory' });
      }
    }
    // picker mode — Welcome / workspace-root picker UI.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'Picker mode requires an allowed Origin' });
    }
    const capabilityPurpose = req.query.capabilityPurpose;
    if (capabilityPurpose !== undefined) {
      if (!isValidFsCapabilityPurpose(capabilityPurpose)) {
        return res.status(400).json({ error: 'invalid filesystem capability purpose' });
      }
      if (capabilityPurpose !== 'import-plugin') {
        return res.status(400).json({ error: 'unsupported picker capability purpose' });
      }
    }
    const requested = (req.query.path as string) || process.cwd();
    let dirPath = resolve(requested);
    try {
      if (!existsSync(dirPath)) {
        dirPath = dirname(dirPath);
        if (!existsSync(dirPath)) {
          return res.status(404).json({ error: `Directory not found: ${dirPath}` });
        }
      }
      if (!statSync(dirPath).isDirectory()) {
        dirPath = dirname(dirPath);
      }
      const dirEntries = readdirSync(dirPath, { withFileTypes: true });
      const allEntries = dirEntries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: resolve(dirPath, e.name),
          type: e.isDirectory() ? ('directory' as const) : ('file' as const),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const entries = allEntries.slice(0, MAX_FS_LIST_ENTRIES);
      const parent = dirname(dirPath);
      const capability =
        capabilityPurpose === 'import-plugin'
          ? issueFsCapability(dirPath, capabilityPurpose, req.workspace)
          : null;
      res.json({
        path: dirPath,
        parent: parent !== dirPath ? parent : null,
        entries,
        truncated: allEntries.length > MAX_FS_LIST_ENTRIES,
        ...(capability ? { capabilityToken: capability.token, capabilityExpiresAt: capability.expiresAt } : {}),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to list directory' });
    }
  });

  app.get('/api/workspace/yamls', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.json({ entries: [] });
    const tagmaDir = tagmaDirOf(ws.workDir);
    if (!existsSync(tagmaDir)) return res.json({ entries: [] });
    try {
      // Foldered pipelines (the new layout) — one entry per `.tagma/<stem>/<stem>.yaml`.
      const folderedEntries = enumeratePipelineYamls(ws.workDir);
      for (const entry of folderedEntries) runPipelineManifestSync(entry.yamlPath);
      const foldered = folderedEntries.map((entry) =>
        describeYamlEntry(entry.yamlPath, entry.yamlBasename, entry.layoutPath, false),
      );

      // Surface flat-layout YAMLs that we couldn't auto-migrate (folder
      // already exists or stem is invalid). The picker can render these with
      // a warning so the user knows they're stranded — silently dropping them
      // was the failure mode the review called out.
      const flat = enumerateFlatPipelineYamls(ws.workDir);
      const unmigratableEntries = flat.filter((entry) => isUnmigratableFlatYaml(ws.workDir, entry));
      for (const entry of unmigratableEntries) runPipelineManifestSync(entry.yamlPath);
      const unmigratable = unmigratableEntries.map((entry) =>
        describeYamlEntry(entry.yamlPath, entry.yamlBasename, entry.layoutPath, true),
      );

      const entries = [...foldered, ...unmigratable].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      );
      res.json({ entries });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to list workspace yamls' });
    }
  });

  app.get('/api/workspace/workflows', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.json({ entries: [] });
    try {
      const entries = enumerateWorkflowYamls(ws.workDir).map((entry) =>
        describeWorkflowEntry(entry.yamlPath, entry.yamlBasename),
      );
      res.json({ entries });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to list workspace workflows' });
    }
  });

  app.post('/api/workspace/workflows', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });

    const { name, pipelinePaths } = (req.body ?? {}) as {
      name?: unknown;
      pipelinePaths?: unknown;
    };
    let stem: string;
    try {
      stem = sanitizeWorkflowStem(name);
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'workflow name is invalid' });
    }

    const hasExplicitPipelinePaths = Array.isArray(pipelinePaths);
    const rawPipelinePaths = hasExplicitPipelinePaths
      ? pipelinePaths
      : ws.yamlPath
        ? [ws.yamlPath]
        : [];
    if (rawPipelinePaths.length === 0 && !hasExplicitPipelinePaths) {
      return res
        .status(400)
        .json({ error: 'Select or save a pipeline before creating a workflow.' });
    }

    const usedIds = new Set<string>();
    const seenPaths = new Set<string>();
    const pipelines: Array<{ id: string; path: string }> = [];
    for (let i = 0; i < rawPipelinePaths.length; i++) {
      const rawPath = rawPipelinePaths[i];
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
        return res.status(400).json({ error: 'pipelinePaths entries must be non-empty strings' });
      }
      let absPath: string;
      try {
        absPath = assertPipelineYamlPath(
          ws.workDir,
          resolve(ws.workDir, rawPath),
          'workflow pipeline',
        );
      } catch (err) {
        return res.status(400).json({
          error: err instanceof Error ? err.message : 'Workflow pipeline path is invalid',
        });
      }
      if (!existsSync(absPath)) {
        return res.status(404).json({ error: `Pipeline file not found: ${absPath}` });
      }
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);
      pipelines.push({
        id: workflowPipelineIdForPath(absPath, i, usedIds),
        path: workspaceRelativePath(ws.workDir, absPath),
      });
    }

    if (pipelines.length === 0 && rawPipelinePaths.length > 0) {
      return res.status(400).json({ error: 'At least one pipeline is required' });
    }

    const workflowPath = workflowYamlPath(ws.workDir, stem);
    if (existsSync(workflowPath)) {
      return res.status(409).json({ error: `Workflow already exists: ${workflowPath}` });
    }

    try {
      mkdirSync(dirname(workflowPath), { recursive: true });
      atomicWriteFileSync(
        workflowPath,
        serializeWorkflowGraphForEditor({ kind: 'graph', name: stem, pipelines }),
      );
      res.json({
        ok: true,
        workflow: describeWorkflowEntry(workflowPath, basename(workflowPath)),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to create workflow' });
    }
  });

  app.patch('/api/workspace/workflows', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });

    const { path: rawWorkflowPath, pipelines: rawPipelines } = (req.body ?? {}) as {
      path?: unknown;
      pipelines?: unknown;
    };
    if (typeof rawWorkflowPath !== 'string' || rawWorkflowPath.trim().length === 0) {
      return res.status(400).json({ error: 'path is required' });
    }

    let workflowPath: string;
    try {
      workflowPath = assertWorkflowYamlPath(
        ws.workDir,
        resolve(ws.workDir, rawWorkflowPath),
        'workflow',
      );
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Workflow path is invalid',
      });
    }
    if (!existsSync(workflowPath)) {
      return res.status(404).json({ error: `Workflow file not found: ${workflowPath}` });
    }

    try {
      const existing = parseWorkflowYaml(readFileSync(workflowPath, 'utf-8'));
      const pipelines = normalizeWorkflowGraphPipelinesInput(ws.workDir, rawPipelines);
      const nextWorkflow = { ...existing, pipelines };
      if (pipelines.length > 0) {
        const diagnostics = validateRawWorkflow(nextWorkflow);
        if (diagnostics.length > 0) {
          return res.status(400).json({
            error: diagnostics.map((diag) => `[${diag.path}] ${diag.message}`).join('\n'),
            diagnostics,
          });
        }
      }
      atomicWriteFileSync(workflowPath, serializeWorkflowGraphForEditor(nextWorkflow));
      res.json({
        ok: true,
        workflow: describeWorkflowEntry(workflowPath, basename(workflowPath)),
      });
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to update workflow' });
    }
  });

  app.post('/api/workspace/compile', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    const { path: filePath } = (req.body ?? {}) as { path?: unknown };
    if (typeof filePath !== 'string' || !filePath) {
      return res.status(400).json({ error: 'path is required' });
    }
    let absPath: string;
    try {
      absPath = assertPipelineYamlPath(ws.workDir, resolve(filePath), 'YAML to compile');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    if (!existsSync(absPath)) return res.status(404).json({ error: `File not found: ${absPath}` });
    try {
      assertFileSizeAtMost(absPath, MAX_YAML_FILE_BYTES, 'YAML file');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'YAML file is too large';
      return res.status(400).json({ error: msg });
    }
    try {
      const result = runCompileAndWriteLog(absPath, ws.registry);
      runPipelineManifestSync(absPath);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to compile YAML' });
    }
  });

  app.get('/api/fs/roots', (_req, res) => {
    // Workspace-agnostic — no requireWorkspace needed. Welcome page uses
    // this to enumerate candidate workspace roots.
    // On Windows, list drive letters; on Unix, just "/".
    if (process.platform === 'win32') {
      const drives: string[] = [];
      for (let c = 65; c <= 90; c++) {
        const drive = String.fromCharCode(c) + ':\\';
        try {
          if (existsSync(drive)) drives.push(drive);
        } catch (_err) {
          /* drive not accessible */
        }
      }
      res.json({ roots: drives });
    } else {
      res.json({ roots: ['/'] });
    }
  });

  app.post('/api/fs/capability', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'Filesystem capabilities require an allowed Origin' });
    }
    const { path: rawPath, purpose } = (req.body ?? {}) as {
      path?: unknown;
      purpose?: unknown;
    };
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!isValidFsCapabilityPurpose(purpose)) {
      return res.status(400).json({ error: 'invalid filesystem capability purpose' });
    }
    if (purpose === 'import-plugin') {
      return res.status(403).json({
        error:
          'Plugin import capabilities cannot be self-issued through /api/fs/capability; they must come from a trusted picker flow.',
      });
    }
    const absPath = resolve(rawPath);
    const { token, expiresAt } = issueFsCapability(absPath, purpose, req.workspace);
    res.json({ token, expiresAt });
  });

  app.post('/api/fs/mkdir', (req, res) => {
    const { path: dirPath, capabilityToken } = (req.body ?? {}) as {
      path?: unknown;
      capabilityToken?: unknown;
    };
    if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
      return res.status(400).json({ error: 'path is required' });
    }
    const absPath = resolve(dirPath);
    // C3: mkdir opts out of the workspace fence when invoked from a picker
    // (workspace-root / import / export) UI that is explicitly allowed to
    // walk the host filesystem. Otherwise B1: mkdir must stay within workDir.
    const isPicker = req.query.picker === '1' || req.query.picker === 'true';
    if (isPicker) {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ error: 'Picker mode requires an allowed Origin' });
      }
      try {
        consumeFsCapability(capabilityToken, absPath, 'picker-mkdir', req.workspace);
        mkdirSync(absPath, { recursive: true });
        return res.json({ path: absPath });
      } catch (err: unknown) {
        return res.status(500).json({ error: errorMessage(err) || 'Failed to create directory' });
      }
    }
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Workspace directory is not set' });
    }
    try {
      assertWithinWorkspace(ws, absPath, 'directory');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      mkdirSync(absPath, { recursive: true });
      res.json({ path: absPath });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to create directory' });
    }
  });

  app.post('/api/fs/reveal', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const absPath = resolve(filePath);
    // B1: reveal must stay within workDir to prevent revealing arbitrary filesystem paths.
    if (ws.workDir && !isPathWithin(absPath, ws.workDir)) {
      return res.status(403).json({ error: 'Path is outside the workspace directory' });
    }
    if (!existsSync(absPath)) return res.status(404).json({ error: 'File not found' });
    try {
      const dir = statSync(absPath).isDirectory() ? absPath : dirname(absPath);
      if (process.platform === 'win32') {
        // explorer.exe returns exit 1 even on success — don't check result.
        Bun.spawnSync(['explorer', `/select,${absPath}`]);
      } else if (process.platform === 'darwin') {
        Bun.spawnSync(['open', '-R', absPath]);
      } else {
        Bun.spawnSync(['xdg-open', dir]);
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to reveal' });
    }
  });

  // ── File operations ──
  app.post('/api/open', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absPath: string;
    try {
      // All editor "open" calls go through the workspace YAML list — there is
      // no UI path that opens a YAML outside .tagma/<stem>/<stem>.yaml.
      // Refusing flat / non-pipeline paths server-side closes the
      // CSRF/path-traversal door (e.g. a malicious page asking us to parse
      // and stash arbitrary files into `config`).
      absPath = assertPipelineYamlPath(ws.workDir, resolve(filePath), 'file to open');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      if (!existsSync(absPath)) {
        return res.status(404).json({ error: `File not found: ${absPath}` });
      }
      assertFileSizeAtMost(absPath, MAX_YAML_FILE_BYTES, 'YAML file');
      const content = readFileSync(absPath, 'utf-8');
      try {
        ws.config = withDefaultTrackColors(parseYaml(content));
      } catch {
        // parseYaml is strict — fall back to lenient loading
        ws.config = withDefaultTrackColors(
          lenientParseYaml(content, basename(absPath, '.yaml').replace(/[-_]/g, ' ')),
        );
      }
      ws.yamlPath = absPath;
      ws.yamlVersion = getFileVersion(absPath);
      loadLayout(ws);
      beginWatching(ws, absPath, content);
      await withWorkspacePluginMutationLock(ws, () => autoLoadInstalledPlugins(ws));
      runCompileAndWriteLog(absPath, ws.registry);
      runPipelineManifestSync(absPath);
      res.json(getState(ws));
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to open file' });
    }
  });

  app.post('/api/save', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    let savePath = ws.yamlPath;
    if (!savePath) {
      if (!ws.workDir)
        return res.status(400).json({ error: 'No file path and no workspace configured.' });
      const tagmaDir = tagmaDirOf(ws.workDir);
      mkdirSync(tagmaDir, { recursive: true });
      const randomId = Math.random().toString(36).slice(2, 10);
      const stem = `pipeline-${randomId}`;
      savePath = pipelineYamlPath(ws.workDir, stem);
    }
    try {
      savePath = assertPipelineYamlPath(ws.workDir, savePath, 'save target');
      // Ensure the per-pipeline folder exists before atomicWriteFileSync —
      // it does not auto-create parent directories.
      mkdirSync(dirname(savePath), { recursive: true });

      // F12: Optimistic locking - check if file has been modified externally
      // since we last loaded it. This prevents overwriting external edits.
      if (ws.yamlVersion && existsSync(savePath)) {
        try {
          assertFileUnchanged(savePath, ws.yamlVersion);
        } catch (err) {
          if (err instanceof OptimisticLockConflictError) {
            return res.status(409).json(buildConflictResponse(err));
          }
          throw err;
        }
      }

      // B4: Stop the existing watcher BEFORE writing so the old watcher's
      // debounced check() can't fire between writeFileSync and beginWatching,
      // which would falsely detect our own write as an external change.
      ws.watcher.stopWatching();
      const content = serializePipeline(ws.config);
      atomicWriteFileSync(savePath, content);
      ws.yamlPath = savePath;
      ws.yamlVersion = getFileVersion(savePath);
      saveLayout(ws);
      beginWatching(ws, savePath, content);
      runCompileAndWriteLog(savePath, ws.registry);
      runPipelineManifestSync(savePath);
      res.json(getState(ws));
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to save file' });
    }
  });

  app.post('/api/save-as', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absPath: string;
    try {
      // The client builds .tagma/<stem>/<stem>.yaml; the strict validator
      // enforces that shape so Save As cannot be used as an arbitrary YAML
      // writer by a page in another browser tab. Reserved stems and bad
      // characters get rejected here before any write.
      absPath = assertPipelineYamlPath(ws.workDir, resolve(filePath), 'save target');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      // B4: Stop watcher before write to prevent false external-change detection.
      ws.watcher.stopWatching();
      const yaml = serializePipeline(ws.config);
      atomicWriteFileSync(absPath, yaml);
      ws.yamlPath = absPath;
      saveLayout(ws);
      beginWatching(ws, absPath, yaml);
      runCompileAndWriteLog(absPath, ws.registry);
      runPipelineManifestSync(absPath);
      res.json(getState(ws));
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to save file' });
    }
  });

  app.post('/api/new', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name } = req.body;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    const tagmaDir = tagmaDirOf(ws.workDir);
    mkdirSync(tagmaDir, { recursive: true });
    const randomId = Math.random().toString(36).slice(2, 10);
    const stem = `pipeline-${randomId}`;
    const yamlAbsPath = pipelineYamlPath(ws.workDir, stem);
    ws.config = createEmptyPipeline(name || 'Untitled Pipeline');
    // Seed a default track + task so new pipelines start without validation errors
    const trackId = generateConfigId();
    ws.config = upsertTrack(ws.config, {
      id: trackId,
      name: 'Track 1',
      color: '#3b82f6',
      tasks: [],
    });
    const taskId = generateConfigId();
    ws.config = upsertTask(ws.config, trackId, {
      id: taskId,
      name: 'Task 1',
      prompt: 'Hello world!',
    });
    ws.yamlPath = yamlAbsPath;
    ws.layout = { positions: {} };
    const content = serializePipeline(ws.config);
    mkdirSync(dirname(yamlAbsPath), { recursive: true });
    atomicWriteFileSync(yamlAbsPath, content);
    runPipelineManifestSync(yamlAbsPath);
    beginWatching(ws, yamlAbsPath, content);
    runCompileAndWriteLog(yamlAbsPath, ws.registry);
    res.json(getState(ws));
  });

  // ── Create pipeline from manifest (manifest-first creation flow) ──
  // The chat agent writes <stem>/<stem>.manifest.json first as a structural
  // blueprint, then calls this endpoint to generate the YAML skeleton.
  // The editor writes the YAML, regenerates the manifest from it (ensuring
  // consistency), and sets up watchers — so the agent can immediately read
  // the generated YAML and fill in task content.
  app.post('/api/create-from-manifest', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });

    const body = (req.body ?? {}) as { stem?: unknown; manifest?: unknown };
    const rawStem = body.stem;
    if (typeof rawStem !== 'string' || !rawStem.trim()) {
      return res.status(400).json({ error: 'stem is required' });
    }
    const stem = sanitizePipelineStem(rawStem.trim());
    if (!stem) {
      return res.status(400).json({ error: 'invalid pipeline stem' });
    }

    const yamlAbsPath = pipelineYamlPath(ws.workDir, stem);
    try {
      assertPipelineYamlPath(ws.workDir, yamlAbsPath, 'pipeline to create');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid pipeline path';
      return res.status(403).json({ error: msg });
    }

    // Refuse to overwrite an existing pipeline folder.
    const folderPath = dirname(yamlAbsPath);
    if (existsSync(folderPath)) {
      return res.status(409).json({
        error: `Pipeline folder already exists: ${stem}/`,
      });
    }

    // Load manifest — either from request body or from disk.
    let manifestJson: string;
    if (body.manifest && typeof body.manifest === 'object') {
      manifestJson = JSON.stringify(body.manifest);
    } else {
      const manifestPath = pipelineManifestPath(yamlAbsPath);
      if (!existsSync(manifestPath)) {
        return res.status(404).json({
          error: `Manifest file not found: ${stem}/${stem}.manifest.json. Write the manifest first.`,
        });
      }
      try {
        manifestJson = readFileSync(manifestPath, 'utf-8');
      } catch (err) {
        return res.status(500).json({ error: `Failed to read manifest: ${errorMessage(err)}` });
      }
    }

    let manifest: ReturnType<typeof JSON.parse>;
    try {
      manifest = JSON.parse(manifestJson);
    } catch (err) {
      return res.status(400).json({ error: `Invalid manifest JSON: ${errorMessage(err)}` });
    }

    // Validate minimum manifest shape before generating skeleton.
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !manifest.pipeline ||
      typeof manifest.pipeline.name !== 'string' ||
      !Array.isArray(manifest.sections)
    ) {
      return res.status(400).json({
        error: 'Manifest must have pipeline.name and sections array',
      });
    }

    let skeleton: string;
    try {
      skeleton = buildYamlSkeletonFromManifest(manifest);
    } catch (err) {
      return res.status(400).json({
        error: `Failed to generate YAML skeleton: ${errorMessage(err)}`,
      });
    }

    try {
      mkdirSync(folderPath, { recursive: true });
      atomicWriteFileSync(yamlAbsPath, skeleton);
      ws.config = parseYaml(skeleton);
      ws.yamlPath = yamlAbsPath;
      ws.layout = { positions: {} };
      // Regenerate manifest from the skeleton YAML so manifest and YAML
      // stay consistent. The agent's original manifest may have been a
      // planning document; the regenerated one reflects the actual YAML.
      runPipelineManifestSync(yamlAbsPath);
      beginWatching(ws, yamlAbsPath, skeleton);
      runCompileAndWriteLog(yamlAbsPath, ws.registry);
      res.json(getState(ws));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to create pipeline from manifest' });
    }
  });

  // ── Layout (editor positions + folders) ──
  app.patch('/api/layout', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { positions, folders } = req.body;
    const validTrackIds = new Set<string>();
    const validQids = new Set<string>();
    for (const t of ws.config.tracks) {
      validTrackIds.add(t.id);
      for (const k of t.tasks) validQids.add(`${t.id}.${k.id}`);
    }
    if (positions && typeof positions === 'object') {
      // Sanitize incoming positions the same way /api/config/replace does:
      // only keep entries whose qid exists in the current config and whose
      // x value is a finite number. We additionally clamp the coordinate to
      // a sensible range — astronomical x values would survive `Number.isFinite`
      // but render nothing useful and can confuse downstream layout code.
      // Cap entry count to the number of valid tasks so a noisy client can't
      // make ws.layout.positions grow unboundedly across mutations.
      const sanitized: Record<string, { x: number }> = {};
      let kept = 0;
      for (const [qid, pos] of Object.entries(positions)) {
        if (kept >= MAX_LAYOUT_TRACK_IDS) break;
        const p = pos as { x?: unknown } | null;
        if (!validQids.has(qid)) continue;
        if (!p || typeof p.x !== 'number' || !Number.isFinite(p.x)) continue;
        const clamped = Math.max(-MAX_LAYOUT_COORD, Math.min(MAX_LAYOUT_COORD, p.x));
        sanitized[qid] = { x: clamped };
        kept += 1;
      }
      ws.layout.positions = sanitized;
    }
    const sanitizedFolders = sanitizeFoldersInput(folders, validTrackIds);
    if (sanitizedFolders !== undefined) ws.layout.folders = sanitizedFolders;
    saveLayout(ws);
    res.json({ ok: true, revision: ws.stateRevision });
  });

  // Import: copy external YAML (and its companion .layout.json, if present)
  // into .tagma/ and open the copy
  app.post('/api/import-file', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { sourcePath, capabilityToken } = req.body;
    if (!sourcePath) return res.status(400).json({ error: 'sourcePath is required' });
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    // C3: source path is user-picked, so we can't fence it to the workspace.
    // Restrict to YAML extensions to cap blast radius — a CSRF attempt that
    // tries to slurp `id_rsa` into the workspace fails the extension check.
    if (!/\.ya?ml$/i.test(sourcePath)) {
      return res.status(400).json({ error: 'sourcePath must be a .yaml or .yml file' });
    }
    const absSource = resolve(sourcePath);
    if (!existsSync(absSource))
      return res.status(404).json({ error: `File not found: ${absSource}` });
    try {
      assertFileSizeAtMost(absSource, MAX_YAML_FILE_BYTES, 'source YAML');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'source YAML is too large';
      return res.status(400).json({ error: msg });
    }
    const tagmaDir = tagmaDirOf(ws.workDir);
    mkdirSync(tagmaDir, { recursive: true });
    // Sanitize the destination filename + derive a pipeline stem from it.
    // basename() strips directory components so a smuggled "../" never lands
    // outside .tagma/. sanitizePipelineStem rejects reserved names and bad
    // chars (`/ \ : * ? " < > |`, whitespace, leading `.`) — anything that
    // would land us in a non-pipeline directory.
    const safeName = basename(absSource);
    const rawStem = stemFromYamlBasename(safeName);
    let stem: string;
    try {
      stem = sanitizePipelineStem(rawStem);
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'invalid pipeline stem' });
    }
    // If a pipeline by this stem already exists, refuse rather than silently
    // overwriting. The user can rename the source file or delete the existing
    // pipeline if they really want a replacement.
    const destPathCandidate = pipelineYamlPath(ws.workDir, stem);
    if (existsSync(destPathCandidate)) {
      return res.status(409).json({
        error: `A pipeline named "${stem}" already exists in .tagma/`,
        existingPath: destPathCandidate,
      });
    }
    let destPath: string;
    try {
      destPath = assertPipelineYamlPath(ws.workDir, destPathCandidate, 'import destination');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid import destination';
      return res.status(403).json({ error: msg });
    }
    try {
      consumeFsCapability(capabilityToken, absSource, 'import-file', ws);
      const content = readFileSync(absSource, 'utf-8');
      mkdirSync(dirname(destPath), { recursive: true });
      atomicWriteFileSync(destPath, content);
      // Copy the companion layout file alongside the YAML, if it exists.
      const sourceLayoutFile = companionLayoutPath(absSource);
      const destLayoutFile = companionLayoutPath(destPath);
      if (existsSync(sourceLayoutFile)) {
        try {
          assertFileSizeAtMost(sourceLayoutFile, MAX_LAYOUT_FILE_BYTES, 'source layout');
          atomicWriteFileSync(destLayoutFile, readFileSync(sourceLayoutFile, 'utf-8'));
        } catch {
          /* best-effort — missing or unreadable layout should not block import */
        }
      }
      try {
        ws.config = withDefaultTrackColors(parseYaml(content));
      } catch {
        ws.config = withDefaultTrackColors(
          lenientParseYaml(content, basename(absSource, '.yaml').replace(/[-_]/g, ' ')),
        );
      }
      ws.yamlPath = destPath;
      loadLayout(ws);
      beginWatching(ws, destPath, content);
      await withWorkspacePluginMutationLock(ws, () => autoLoadInstalledPlugins(ws));
      runCompileAndWriteLog(destPath, ws.registry);
      runPipelineManifestSync(destPath);
      // Warn when imported YAML asks for local code or shell execution.
      const hasCommandTasks = ws.config.tracks.some((t) => t.tasks.some((task) => task.command));
      const hasPlugins = (ws.config.plugins ?? []).length > 0;
      const hasHooks = !!ws.config.hooks && Object.keys(ws.config.hooks).length > 0;
      const isTrustedMode = ws.config.mode === 'trusted';
      const state = getState(ws);
      const warnings: string[] = [];
      if (hasCommandTasks) {
        warnings.push('shell command tasks that execute on the host machine');
      }
      if (isTrustedMode) {
        warnings.push('trusted mode, which enables local execution features after review');
      }
      if (hasPlugins) {
        warnings.push('plugins, which are local code');
      }
      if (hasHooks) {
        warnings.push('lifecycle hooks');
      }
      if (warnings.length > 0) {
        (state as Record<string, unknown>).importWarning =
          `This pipeline contains ${warnings.join(', ')}. Review it before starting a run.`;
      }
      res.json(state);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to import file' });
    }
  });

  // Export: serialize current config and copy to destination directory,
  // along with its companion .layout.json so positions travel with the YAML.
  app.post('/api/export-file', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { destDir, capabilityToken } = req.body;
    if (!destDir) return res.status(400).json({ error: 'destDir is required' });
    if (!ws.yamlPath) return res.status(400).json({ error: 'No pipeline file to export' });
    const absDestDir = resolve(destDir);
    if (!existsSync(absDestDir))
      return res.status(404).json({ error: `Directory not found: ${absDestDir}` });
    // C3: destDir is user-picked through the export dialog so it may legitimately
    // sit outside the workspace. We cap damage to "exactly one YAML + one
    // layout.json with the current pipeline's basename" (no path-traversal in
    // the destination filename). Combined with the localhost-only bind (C1) and
    // tightened CORS (C2) this leaves the export endpoint safe under casual CSRF.
    if (!statSync(absDestDir).isDirectory()) {
      return res.status(400).json({ error: 'destDir must be an existing directory' });
    }
    try {
      consumeFsCapability(capabilityToken, absDestDir, 'export-file', ws);
      const content = serializePipeline(ws.config);
      atomicWriteFileSync(ws.yamlPath, content);
      runPipelineManifestSync(ws.yamlPath);
      // Keep the source-of-truth layout in sync on disk before copying.
      saveLayout(ws);
      // Mirror the per-pipeline folder layout at the destination too:
      //   destDir/<stem>/<stem>.yaml
      //   destDir/<stem>/<stem>.layout.json
      // The destination stem is derived from the YAML basename (already
      // pipeline-folder-shaped on disk), so this preserves the
      // "folder name == YAML stem" invariant for the recipient.
      const exportStem = stemFromYamlBasename(basename(ws.yamlPath));
      const destFolder = join(absDestDir, exportStem);
      mkdirSync(destFolder, { recursive: true });
      const destPath = join(destFolder, basename(ws.yamlPath));
      atomicWriteFileSync(destPath, content);
      // Write the companion layout next to the exported YAML.
      const destLayoutFile = companionLayoutPath(destPath);
      atomicWriteFileSync(destLayoutFile, JSON.stringify(ws.layout, null, 2));
      const sourceManifestFile = pipelineManifestPath(ws.yamlPath);
      const destManifestFile = pipelineManifestPath(destPath);
      if (existsSync(sourceManifestFile)) {
        atomicWriteFileSync(destManifestFile, readFileSync(sourceManifestFile, 'utf-8'));
      }
      res.json({ ok: true, path: destPath });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to export file' });
    }
  });

  app.post('/api/export-file/platform', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { destDir, capabilityToken } = req.body;
    const targetPlatform = normalizeTagmaPlatform(req.body?.targetPlatform);
    const requestedModel = parsePlatformExportModelPick(req.body?.model);

    if (!destDir) return res.status(400).json({ error: 'destDir is required' });
    if (!targetPlatform) {
      return res.status(400).json({ error: 'targetPlatform must be windows, linux, or mac' });
    }
    if (!ws.yamlPath) return res.status(400).json({ error: 'No pipeline file to export' });
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });

    const sourcePlatform = currentTagmaPlatform();
    if (sourcePlatform && sourcePlatform === targetPlatform) {
      return res.status(400).json({
        error: `This machine is already running ${platformDisplayName(targetPlatform)}.`,
      });
    }

    const absDestDir = resolve(destDir);
    if (!existsSync(absDestDir)) {
      return res.status(404).json({ error: `Directory not found: ${absDestDir}` });
    }
    if (!statSync(absDestDir).isDirectory()) {
      return res.status(400).json({ error: 'destDir must be an existing directory' });
    }

    try {
      consumeFsCapability(capabilityToken, absDestDir, 'export-file', ws);
    } catch (err: unknown) {
      return res.status(500).json({ error: errorMessage(err) || 'Failed to export platform file' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(new Error('Platform export client disconnected'));
    });

    const sendProgress = (event: PlatformExportProgress) => {
      if (res.writableEnded) return;
      res.write(`${JSON.stringify({ type: 'progress', ...event })}\n`);
    };

    try {
      sendProgress({ stage: 'preparing', detail: 'Preparing platform export' });
      const content = serializePipeline(ws.config);
      sendProgress({ stage: 'syncing', detail: 'Saving current pipeline and layout' });
      atomicWriteFileSync(ws.yamlPath, content);
      runPipelineManifestSync(ws.yamlPath);
      saveLayout(ws);

      sendProgress({ stage: 'opencode', detail: 'Preparing .tagma OpenCode workspace' });
      const tagmaCwd = ensureRealTagmaDirectory(ws.workDir);
      sendProgress({ stage: 'opencode', detail: 'Seeding OpenCode agent and runtime artifacts' });
      const seedChanged = seedOpencodeArtifacts(tagmaCwd);
      sendProgress({
        stage: 'opencode',
        detail: 'Starting YAML compile watcher for OpenCode edits',
      });
      startChatCompileWatcher(tagmaCwd, ws.registry);
      sendProgress({
        stage: 'opencode',
        detail: seedChanged
          ? 'Restarting OpenCode because artifacts changed'
          : 'Connecting to existing OpenCode server',
      });
      const { baseUrl } = seedChanged
        ? await restartOpencode(tagmaCwd)
        : await ensureOpencode(tagmaCwd);

      const converted = await convertPipelineYamlForPlatform({
        baseUrl,
        sourceYaml: content,
        sourceName: basename(ws.yamlPath),
        sourcePlatform,
        targetPlatform,
        model: requestedModel,
        onProgress: sendProgress,
        signal: abort.signal,
      });

      sendProgress({ stage: 'writing', detail: 'Writing exported YAML and layout' });
      // Wrap platformExportPath in a per-pipeline folder so the export keeps
      // the "folder name == YAML stem" invariant (e.g. foo.windows/foo.windows.yaml).
      // platformExportPath returns destDir/<stem>.yaml; we promote that to
      // destDir/<stem>/<stem>.yaml here so a recipient workspace can drop the
      // folder straight under .tagma/ without any path massaging.
      const platformFlatPath = platformExportPath(absDestDir, ws.yamlPath, targetPlatform);
      const platformStem = stemFromYamlBasename(basename(platformFlatPath));
      const platformFolder = join(absDestDir, platformStem);
      mkdirSync(platformFolder, { recursive: true });
      const destPath = join(platformFolder, basename(platformFlatPath));
      atomicWriteFileSync(destPath, converted);
      const destLayoutFile = companionLayoutPath(destPath);
      atomicWriteFileSync(destLayoutFile, JSON.stringify(ws.layout, null, 2));
      runPipelineManifestSync(destPath);
      res.write(`${JSON.stringify({ type: 'done', ok: true, path: destPath, targetPlatform })}\n`);
    } catch (err: unknown) {
      if (!res.writableEnded) {
        res.write(
          `${JSON.stringify({
            type: 'error',
            error: errorMessage(err) || 'Failed to export platform file',
          })}\n`,
        );
      }
    } finally {
      res.end();
    }
  });

  // Delete a pipeline. Removes the entire `.tagma/<stem>/` folder containing
  // YAML + .layout.json + .compile.log + .requirements.md (and any other
  // per-pipeline artifacts). Run history under `.tagma/logs/` is NOT touched —
  // those entries are workspace-scoped by runId, not by pipeline.
  //
  // We accept either a YAML path (legacy callers) or the folder path itself.
  // YAML paths must pass the strict assertPipelineYamlPath check; folder
  // paths must pass assertPipelineFolderPath. Both helpers reject reserved
  // sibling dirs (`logs`, `plugin-runtime`, …) so this route can never be
  // misused to wipe an editor-internal directory.
  app.post('/api/delete-file', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absYamlPath: string | null = null;
    let boundYamlPath: string | null = null;
    let absFolderPath: string;
    try {
      const candidate = resolve(filePath);
      if (/\.ya?ml$/i.test(candidate)) {
        absYamlPath = assertPipelineYamlPath(ws.workDir, candidate, 'file to delete');
        boundYamlPath = absYamlPath;
        absFolderPath = dirname(absYamlPath);
      } else {
        absFolderPath = assertPipelineFolderPath(ws.workDir, candidate, 'pipeline to delete');
        const stem = basename(absFolderPath);
        for (const candidateYaml of [
          join(absFolderPath, `${stem}.yaml`),
          join(absFolderPath, `${stem}.yml`),
        ]) {
          if (!existsSync(candidateYaml)) continue;
          boundYamlPath = assertPipelineYamlPath(
            ws.workDir,
            candidateYaml,
            'pipeline secret binding cleanup',
          );
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      // Mirror the in-memory state reset BEFORE removing the folder so that
      // a partial-rm doesn't leave the editor pointing at a half-deleted YAML.
      const wasCurrent =
        absYamlPath !== null && ws.yamlPath !== null && ws.yamlPath === absYamlPath;
      const folderHostsCurrentYaml = ws.yamlPath !== null && dirname(ws.yamlPath) === absFolderPath;
      if (wasCurrent || folderHostsCurrentYaml) {
        ws.yamlPath = null;
        ws.config = createEmptyPipeline('Untitled Pipeline');
        ws.layout = { positions: {} };
        ws.watcher.stopWatching();
        ws.layoutWatcher.stopWatching();
      }
      if (boundYamlPath) {
        deletePipelineSecretBindings(ws.workDir, boundYamlPath);
      }
      // Recursive rm so siblings (layout/compile/requirements + any future
      // per-pipeline files the agent might add) all go in one step.
      if (existsSync(absFolderPath)) {
        rmSync(absFolderPath, { recursive: true, force: true });
      }
      res.json(getState(ws));
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to delete pipeline' });
    }
  });

  // ── Load demo ──
  app.post('/api/demo', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const DEMO = `pipeline:
  name: Demo Pipeline
  tracks:
    - id: research
      name: Research
      color: '#60a5fa'
      tasks:
        - id: gather
          name: Gather Sources
          prompt: Find and summarize the top 5 sources on the given topic.
        - id: analyze
          name: Analyze Data
          prompt: Analyze the gathered sources and extract key insights.
          depends_on:
            - gather
    - id: writing
      name: Writing
      color: '#34d399'
      tasks:
        - id: draft
          name: Write Draft
          prompt: Write a comprehensive draft based on the research analysis.
          depends_on:
            - research.analyze
        - id: review
          name: Review & Edit
          prompt: Review the draft for accuracy, clarity, and style.
          depends_on:
            - draft
`;
    try {
      ws.config = withDefaultTrackColors(parseYaml(DEMO));
      res.json(getState(ws));
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
