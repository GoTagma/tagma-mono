import type express from 'express';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createTagma,
  DEFAULT_TASK_TIMEOUT_MS,
  RUN_PROTOCOL_VERSION,
  PipelineGraphRunner,
  bunRuntime,
  loadWorkflow,
} from '@tagma/sdk';
import { serializePipeline, loadPipeline, validateConfig, parseYaml } from '@tagma/sdk/yaml';
import { buildRawDag } from '@tagma/sdk/config';
import { generateRunId } from '@tagma/sdk/utils';
import type { SecretResolver } from '@tagma/types';
import type {
  RunEventPayload,
  WireRunEvent,
  EngineResult,
  RawPipelineConfig,
  PipelineGraphEventPayload,
  PipelineGraphResult,
} from '@tagma/sdk';
import { assertSafePluginName } from '../plugin-safety.js';
import { errorMessage } from '../path-utils.js';
import {
  MAX_LOG_RUNS,
  lenientParseYaml,
  loadLayout,
  sameFilesystemPath,
  syncLayoutWatcherFromDisk,
  withDefaultTrackColors,
} from '../state.js';
import {
  loadPluginFromWorkDir,
  classifyServerError,
  unloadPluginFromRegistry,
  readEditorSettings,
  isPluginBlocked,
  invalidatePluginCache,
} from '../plugins/loader.js';
import { withWorkspacePluginMutationLock } from '../plugins/locks.js';
import { requireWorkspace } from '../require-workspace.js';
import { workspaceRegistry } from '../workspace-registry.js';
import { shutdownRunForWorkspace } from '../run-shutdown.js';
import { runPreflight } from '../preflight-requirements.js';
import type { WorkspaceState } from '../workspace-state.js';
import { buildPythonAgentRunEnv, pythonAgentVenvBinDir } from '../python-agent.js';
import { buildPipelineSecretEnv } from '../secrets.js';
import { assertWorkflowYamlPath } from '../workflow-paths.js';
import { assertPipelineYamlPath } from '../pipeline-paths.js';
import { incrementYamlRunVersion } from '../yaml-run-version.js';
import { getFileVersion } from '../optimistic-lock.js';
import {
  RunSession,
  WorkflowRunSession,
  type WorkflowRunSessionEvent,
  runtimeWithInjectedEnv,
  normalizeRunTargetTaskIds,
  shouldMirrorEngineResult,
  shouldResolveStartResponse,
  persistRunSummary,
  readRunSummary,
  safeRunHistoryFile,
  safeRunTaskOutputFile,
  buildRunHistoryAskAiContext,
  computeTaskCounts,
  positionsForSession,
} from './run-session.js';

// Re-export for backward compatibility — other modules that imported these
// from routes/run continue to work unchanged.
export {
  RunSession,
  WorkflowRunSession,
  mergeRunTaskUpdate,
  engineStateToTaskUpdate,
  normalizeRunTargetTaskIds,
  buildRunSnapshotYamlText,
  buildFatalWorkflowGraphEndEvent,
  shouldMirrorEngineResult,
  shouldResolveStartResponse,
  runtimeWithInjectedEnv,
} from './run-session.js';

const START_RESPONSE_GRACE_MS = 75;

// ═══ Local helpers ══════════════════════════════════════════════════════

function assertNotSymlink(path: string, label: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
}

function isSafeTaskOutputId(taskId: string): boolean {
  return taskId.length > 0 && /^[A-Za-z0-9._-]+$/.test(taskId);
}

function publicPipelineGraphResult(result: PipelineGraphResult): unknown {
  return {
    graphRunId: result.graphRunId,
    success: result.success,
    abortReason: result.abortReason,
    pipelines: result.pipelines.map(({ result: _engineResult, ...pipeline }) => pipeline),
  };
}

interface RunHistoryEntry {
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  yamlRunVersion?: number;
  success?: boolean;
  running?: boolean;
  finishedAt?: string;
  replayedFromRunId?: string;
  taskCounts?: {
    total: number;
    success: number;
    failed: number;
    timeout: number;
    skipped: number;
    blocked: number;
    running: number;
    waiting: number;
    idle: number;
  };
}

// ═══ Session accessors ══════════════════════════════════════════════════

function getSessions(ws: WorkspaceState): Map<string, RunSession> {
  return ws.runSessions as Map<string, RunSession>;
}

function listSessions(ws: WorkspaceState): RunSession[] {
  return Array.from(getSessions(ws).values());
}

function getSession(ws: WorkspaceState, runId?: string): RunSession | null {
  if (runId) return getSessions(ws).get(runId) ?? null;
  return listSessions(ws)[0] ?? null;
}

function addSession(ws: WorkspaceState, s: RunSession): void {
  getSessions(ws).set(s.runId, s);
}

export type RunSessionStartToken = symbol;

export function isRunSessionStarting(ws: WorkspaceState): boolean {
  return ws.runSessionStartToken !== null || ws.runSessionStarting;
}

export function beginRunSessionStart(ws: WorkspaceState): RunSessionStartToken | null {
  if (isRunSessionStarting(ws)) return null;
  const token = Symbol('run session start');
  ws.runSessionStartToken = token;
  ws.runSessionStarting = true;
  return token;
}

export function endRunSessionStart(ws: WorkspaceState, token: RunSessionStartToken): void {
  if (ws.runSessionStartToken !== token) return;
  ws.runSessionStartToken = null;
  ws.runSessionStarting = false;
}

export function clearRunSessionStart(ws: WorkspaceState): void {
  ws.runSessionStartToken = null;
  ws.runSessionStarting = false;
}

function removeSession(ws: WorkspaceState, s: RunSession): void {
  getSessions(ws).delete(s.runId);
}

function findSessionForApproval(ws: WorkspaceState, requestId: string): RunSession | null {
  return (
    listSessions(ws).find((session) => session.gateway.pending().some((p) => p.id === requestId)) ??
    null
  );
}

// ═══ SSE broadcast ══════════════════════════════════════════════════════

function broadcastToClients(ws: WorkspaceState, event: WireRunEvent): void {
  const frame = `id: ${event.runId}:${event.seq}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of ws.runSseClients) {
    try {
      client.write(frame);
    } catch {
      // One broken client (ERR_STREAM_WRITE_AFTER_END etc.) must not abort
      // the loop and starve the rest; drop it from the set and continue.
      ws.runSseClients.delete(client);
    }
  }
}

// ═══ Workflow session management ════════════════════════════════════════

function getWorkflowSession(ws: WorkspaceState): WorkflowRunSession | null {
  const session = ws.workflowRunSession as WorkflowRunSession | null;
  return session ?? null;
}

function hasLiveWorkflowSession(ws: WorkspaceState): boolean {
  const session = getWorkflowSession(ws);
  return !!session && !session.done;
}

function clearWorkflowSessionLater(ws: WorkspaceState, session: WorkflowRunSession): void {
  setTimeout(() => {
    if (getWorkflowSession(ws) === session) ws.workflowRunSession = null;
  }, 30_000);
}

function broadcastWorkflowToClients(ws: WorkspaceState, event: WorkflowRunSessionEvent): void {
  const frame = workflowSseFrame(event);
  for (const client of ws.workflowSseClients) {
    try {
      client.write(frame);
    } catch {
      ws.workflowSseClients.delete(client);
    }
  }
}

function workflowSseFrame(event: WorkflowRunSessionEvent): string {
  return `id: ${event.graphRunId}:${event.seq}\nevent: workflow_event\ndata: ${JSON.stringify(event)}\n\n`;
}

// ═══ Last-Event-ID ══════════════════════════════════════════════════════

/** Parse a Last-Event-ID header of the form `<runId>:<seq>`. */
function parseLastEventId(
  raw: string | undefined,
  idPattern: RegExp = /^run_[A-Za-z0-9_-]+$/,
): { runId: string; seq: number } | null {
  if (!raw) return null;
  const colon = raw.lastIndexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return null;
  const runId = raw.slice(0, colon);
  const seqStr = raw.slice(colon + 1);
  if (!idPattern.test(runId)) return null;
  const seq = parseInt(seqStr, 10);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { runId, seq };
}

// ═══ Route registration ═════════════════════════════════════════════════

/**
 * Called from graceful shutdown to close every workspace's in-flight run +
 * drain every workspace's SSE client list.
 */
export function shutdownRuns(): void {
  for (const key of workspaceRegistry.keys()) {
    const ws = workspaceRegistry.get(key);
    if (!ws) continue;
    shutdownRunForWorkspace(ws);
  }
}

export function registerRunRoutes(app: express.Express): void {
  app.get('/api/run/events', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Tagma-Run-Protocol': String(RUN_PROTOCOL_VERSION),
    });
    res.write('\n');
    ws.runSseClients.add(res);

    const parsed = parseLastEventId(req.header('Last-Event-ID'));
    for (const session of listSessions(ws)) {
      // Same runId → replay only missed events. Different runId (or no
      // Last-Event-ID) → dump the whole buffer so the client sees run_start.
      const sameRun = parsed !== null && parsed.runId === session.runId;
      const replay = sameRun ? session.replayAfter(parsed!.seq) : session.allBuffered();
      for (const e of replay) {
        res.write(`id: ${e.runId}:${e.seq}\nevent: run_event\ndata: ${JSON.stringify(e)}\n\n`);
      }
      const snap = session.emitSnapshot();
      res.write(
        `id: ${snap.runId}:${snap.seq}\nevent: run_event\ndata: ${JSON.stringify(snap)}\n\n`,
      );
    }
    req.on('close', () => ws.runSseClients.delete(res));
  });

  app.get('/api/run/workflow/events', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    ws.workflowSseClients.add(res);

    const session = getWorkflowSession(ws);
    if (session) {
      const parsed = parseLastEventId(req.header('Last-Event-ID'), /^graph_[A-Za-z0-9_-]+$/);
      const sameGraph = parsed !== null && parsed.runId === session.graphRunId;
      const replay = sameGraph ? session.replayAfter(parsed.seq) : session.allBuffered();
      for (const event of replay) {
        res.write(workflowSseFrame(event));
      }
    }
    req.on('close', () => ws.workflowSseClients.delete(res));
  });

  app.get('/api/run/workflow/status', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const requestedGraphRunId =
      typeof req.query.graphRunId === 'string' && req.query.graphRunId.trim().length > 0
        ? req.query.graphRunId
        : null;
    const session = getWorkflowSession(ws);
    if (!session || (requestedGraphRunId && requestedGraphRunId !== session.graphRunId)) {
      return res.json({
        ok: true,
        graphRunId: null,
        running: false,
        result: null,
        events: [],
      });
    }
    return res.json({
      ok: true,
      graphRunId: session.graphRunId,
      running: !session.done,
      result: session.result ?? null,
      events: session.allBuffered(),
    });
  });

  app.post('/api/run/workflow/start', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    if (listSessions(ws).length > 0 || isRunSessionStarting(ws) || hasLiveWorkflowSession(ws)) {
      return res.status(409).json({ error: 'A run is already in progress' });
    }
    const rawPath = (req.body ?? {}).path;
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return res.status(400).json({ error: 'path is required' });
    }

    let workflowPath: string;
    try {
      workflowPath = assertWorkflowYamlPath(ws.workDir, rawPath, 'workflow to run');
    } catch (err) {
      return res
        .status(403)
        .json({ error: err instanceof Error ? err.message : 'Invalid workflow path' });
    }
    if (!existsSync(workflowPath)) {
      return res.status(404).json({ error: `File not found: ${workflowPath}` });
    }

    const startToken = beginRunSessionStart(ws);
    if (startToken === null) return res.status(409).json({ error: 'A run is starting' });
    let startTokenEnded = false;
    try {
      const workflow = await loadWorkflow(readFileSync(workflowPath, 'utf-8'), ws.workDir);
      if ((req.body ?? {}).live === true) {
        let resolveStartResponse: (() => void) | null = null;
        const startResponseReady = new Promise<void>((resolve) => {
          resolveStartResponse = resolve;
        });
        const abort = new AbortController();
        const sessionRef: { current: WorkflowRunSession | null } = { current: null };
        const runner = new PipelineGraphRunner(workflow, ws.workDir, {
          registry: ws.registry,
          runtime: bunRuntime(),
          maxLogRuns: MAX_LOG_RUNS,
          signal: abort.signal,
          onEvent: (event) => {
            const session = sessionRef.current;
            if (!session) return;
            const stamped = session.ingest(event);
            broadcastWorkflowToClients(ws, stamped);
            if (resolveStartResponse) {
              resolveStartResponse();
              resolveStartResponse = null;
            }
          },
        });
        const session = new WorkflowRunSession(runner, abort);
        sessionRef.current = session;
        ws.workflowRunSession = session;
        runner
          .start()
          .then((result) => {
            session.result = publicPipelineGraphResult(result);
          })
          .catch((err: unknown) => {
            const message = errorMessage(err) || 'Failed to run workflow';
            session.error = message;
            if (!session.done) {
              const errorEvent = session.ingest({
                type: 'graph_error',
                graphRunId: session.graphRunId,
                error: message,
              });
              broadcastWorkflowToClients(ws, errorEvent);
              const endEvent = session.ingest(session.fatalEndEvent(message));
              broadcastWorkflowToClients(ws, endEvent);
            }
          })
          .finally(() => {
            session.done = true;
            clearWorkflowSessionLater(ws, session);
            if (resolveStartResponse) {
              resolveStartResponse();
              resolveStartResponse = null;
            }
          });
        endRunSessionStart(ws, startToken);
        startTokenEnded = true;
        await Promise.race([
          startResponseReady,
          new Promise<void>((resolve) => setTimeout(resolve, START_RESPONSE_GRACE_MS)),
        ]);
        return res.json({
          ok: true,
          graphRunId: session.graphRunId,
          running: !session.done,
          result: session.result,
          events: session.allBuffered(),
        });
      }
      const events: PipelineGraphEventPayload[] = [];
      const runner = new PipelineGraphRunner(workflow, ws.workDir, {
        registry: ws.registry,
        runtime: bunRuntime(),
        maxLogRuns: MAX_LOG_RUNS,
        onEvent: (event) => events.push(event),
      });
      const result = await runner.start();
      res.json({ ok: true, result: publicPipelineGraphResult(result), events });
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to run workflow' });
    } finally {
      if (!startTokenEnded) endRunSessionStart(ws, startToken);
    }
  });

  app.post('/api/run/workflow/abort', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const session = getWorkflowSession(ws);
    if (!session || session.done) {
      return res.status(404).json({ error: 'No workflow run in progress' });
    }
    const graphRunId = (req.body ?? {}).graphRunId;
    if (graphRunId !== undefined && graphRunId !== session.graphRunId) {
      return res.status(404).json({ error: 'No workflow run in progress' });
    }
    session.abort.abort();
    res.json({ ok: true });
  });

  app.post('/api/run/start', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (hasLiveWorkflowSession(ws)) {
      return res.status(409).json({ error: 'A run is already in progress' });
    }
    const startToken = beginRunSessionStart(ws);
    if (startToken === null) return res.status(409).json({ error: 'A run is starting' });

    // Outer guard mirrors the earlier implementation: if we exit this
    // handler any way other than actually launching the pipeline, the
    // finally clears the lock so the server isn't wedged into 409.
    let sessionLaunched = false;
    let launchedSession: RunSession | null = null;
    try {
      const cwd = ws.workDir || process.cwd();

      const fromRunId: string | null =
        typeof req.body?.fromRunId === 'string' && /^run_[A-Za-z0-9_-]+$/.test(req.body.fromRunId)
          ? req.body.fromRunId
          : null;
      const requestedYamlPath: string | null =
        fromRunId === null &&
        typeof req.body?.yamlPath === 'string' &&
        req.body.yamlPath.trim().length > 0
          ? req.body.yamlPath
          : null;

      let effectiveConfig: RawPipelineConfig;
      let content: string;
      let yamlOverride: string | undefined;
      if (fromRunId !== null) {
        let yamlPath: string;
        try {
          yamlPath = safeRunHistoryFile(cwd, fromRunId, 'pipeline.yaml');
        } catch (err) {
          return res.status(403).json({ error: errorMessage(err) });
        }
        if (!existsSync(yamlPath)) {
          return res
            .status(404)
            .json({ error: `No yaml snapshot found for run ${fromRunId}; cannot replay` });
        }
        try {
          const diskYaml = readFileSync(yamlPath, 'utf-8');
          try {
            effectiveConfig = parseYaml(diskYaml);
          } catch {
            effectiveConfig = lenientParseYaml(diskYaml, `Replay ${fromRunId}`);
          }
          content = serializePipeline(effectiveConfig);
          yamlOverride = diskYaml;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(400).json({ error: `Failed to load snapshot yaml: ${message}` });
        }
      } else {
        if (requestedYamlPath) {
          // Normal editor runs are tied to the currently-open YAML. Reload it
          // here so a chat/external write that missed the watcher cannot leave
          // /run/start validating stale in-memory config.
          let runYamlPath: string;
          try {
            runYamlPath = assertPipelineYamlPath(
              ws.workDir,
              resolve(requestedYamlPath),
              'run YAML',
            );
          } catch (err) {
            return res.status(403).json({ error: errorMessage(err) || 'Invalid run YAML path' });
          }
          if (!sameFilesystemPath(ws.yamlPath, runYamlPath)) {
            return res.status(409).json({
              error: 'Run YAML no longer matches the current workspace file',
            });
          }
          if (!existsSync(runYamlPath)) {
            return res.status(404).json({ error: `File not found: ${runYamlPath}` });
          }
          let diskYaml: string;
          try {
            diskYaml = readFileSync(runYamlPath, 'utf-8');
            effectiveConfig = withDefaultTrackColors(parseYaml(diskYaml));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return res.status(400).json({ error: `Configuration error: ${message}` });
          }
          content = serializePipeline(effectiveConfig);
          ws.config = effectiveConfig;
          ws.yamlPath = runYamlPath;
          ws.yamlVersion = getFileVersion(runYamlPath);
          if (sameFilesystemPath(ws.manualNewPipelineYamlPath, runYamlPath)) {
            ws.manualNewPipelineYamlPath = null;
          }
          loadLayout(ws);
          syncLayoutWatcherFromDisk(ws);
          ws.watcher.markSynced(diskYaml, statSync(runYamlPath).mtimeMs, content);
          invalidatePluginCache(ws);
        } else {
          effectiveConfig = ws.config;
          content = serializePipeline(effectiveConfig);
        }
      }

      let targetTaskIds: string[] | undefined;
      try {
        targetTaskIds = normalizeRunTargetTaskIds(req.body?.targetTaskIds, effectiveConfig);
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }

      // Pre-load plugins atomically: validate every name first, then load
      // in order; on any failure unregister everything we loaded so the
      // workspace registry never ends up half-populated.
      const pluginsToLoad = effectiveConfig.plugins ?? [];
      if (pluginsToLoad.length > 0) {
        for (const name of pluginsToLoad) {
          try {
            assertSafePluginName(name);
          } catch (err: unknown) {
            const { message } = classifyServerError(err);
            return res.status(400).json({ error: `Plugin load error: ${message}` });
          }
        }
        const preloadError = await withWorkspacePluginMutationLock(ws, async () => {
          const newlyLoaded: string[] = [];
          for (const name of pluginsToLoad) {
            if (ws.loadedPluginMeta.has(name)) continue;
            if (isPluginBlocked(ws, name)) {
              return {
                message: `Plugin "${name}" was explicitly uninstalled. Install it again before running this pipeline.`,
              };
            }
            try {
              await loadPluginFromWorkDir(ws, name);
              newlyLoaded.push(name);
            } catch (err: unknown) {
              for (const loadedName of newlyLoaded) {
                unloadPluginFromRegistry(ws, loadedName, { removeStageDir: true });
              }
              const { message } = classifyServerError(err);
              return { message };
            }
          }
          return null;
        });
        if (preloadError) {
          return res.status(400).json({ error: `Plugin load error: ${preloadError.message}` });
        }
      }

      let pipelineConfig;
      try {
        pipelineConfig = await loadPipeline(content, cwd);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: `Configuration error: ${message}` });
      }

      const configErrors = validateConfig(pipelineConfig);
      if (configErrors.length > 0) {
        return res.status(400).json({ error: configErrors.join('; ') });
      }

      const pythonSettings = readEditorSettings(ws).pythonAgent;
      const pythonRunEnv = buildPythonAgentRunEnv(cwd, pythonSettings);
      const pythonPreflightOptions =
        Object.keys(pythonRunEnv).length > 0
          ? {
              extraPathDirs: [pythonAgentVenvBinDir(cwd)],
              extraEnv: pythonRunEnv,
            }
          : {};

      // Pre-run host check against `*.requirements.md`. Skip on replay
      // (fromRunId): a snapshot is a historical artifact, blocking it on the
      // current host's PATH would prevent post-mortem replays.
      const skipPreflight = req.body?.skipPreflight === true;
      let requirementsEnvKeys: string[] = [];
      let secretRunEnv: Record<string, string> = {};
      if (fromRunId === null && ws.yamlPath) {
        try {
          const preflight = runPreflight(ws.yamlPath, pythonPreflightOptions);
          requirementsEnvKeys = [...preflight.envKeys];
          try {
            secretRunEnv = buildPipelineSecretEnv(cwd, ws.yamlPath, requirementsEnvKeys);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return res.status(400).json({ error: `Secret manager error: ${message}` });
          }
          const missingAfterSecrets = {
            binaries: preflight.missing.binaries,
            envs: preflight.missing.envs.filter((name) => !secretRunEnv[name]),
          };
          if (
            !skipPreflight &&
            !preflight.skipped &&
            (missingAfterSecrets.binaries.length > 0 || missingAfterSecrets.envs.length > 0)
          ) {
            return res.status(400).json({
              error: 'requirements_missing',
              missing: missingAfterSecrets,
              requirementsPath: preflight.requirementsPath,
            });
          }
        } catch (err) {
          console.warn('[run] preflight failed, continuing:', err);
        }
      }

      const yamlRunVersion =
        fromRunId === null && ws.yamlPath ? incrementYamlRunVersion(cwd, ws.yamlPath) : undefined;
      const runId = generateRunId();
      const session = new RunSession(
        runId,
        effectiveConfig,
        fromRunId,
        yamlOverride,
        yamlRunVersion,
      );
      session.seedTasks();
      addSession(ws, session);
      launchedSession = session;

      let resolveStartResponse: (() => void) | null = null;
      const startResponseReady = new Promise<void>((resolve) => {
        resolveStartResponse = resolve;
      });
      const maybeResolveStartResponse = (event: WireRunEvent): void => {
        if (!resolveStartResponse || !shouldResolveStartResponse(event)) return;
        resolveStartResponse();
        resolveStartResponse = null;
      };

      const injectedRunEnv = { ...pythonRunEnv, ...secretRunEnv };
      const secretResolver: SecretResolver | undefined =
        fromRunId === null && ws.yamlPath
          ? (names) => buildPipelineSecretEnv(cwd, ws.yamlPath!, names)
          : undefined;
      const tagma = createTagma({
        registry: ws.registry,
        builtins: false,
        runtime: runtimeWithInjectedEnv(injectedRunEnv),
      });
      tagma
        .run(pipelineConfig, {
          cwd,
          approvalGateway: session.gateway,
          signal: session.abort.signal,
          maxLogRuns: MAX_LOG_RUNS,
          runId,
          skipPluginLoading: true,
          defaultTaskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
          ...(secretResolver ? { secretResolver } : {}),
          ...(targetTaskIds ? { targetTaskIds } : {}),
          ...(requirementsEnvKeys.length > 0
            ? { envPolicy: { mode: 'allowlist' as const, keys: requirementsEnvKeys } }
            : {}),
          onEvent: (event: RunEventPayload) => {
            const stamped = session.ingest(event);
            broadcastToClients(ws, stamped);
            maybeResolveStartResponse(stamped);
          },
        })
        .then((result: EngineResult) => {
          session.success = result.success;
          // Normally the engine has already emitted run_start/run_end via
          // onEvent before this .then fires. Pre-run gates (pipeline_start)
          // are the exception: core returns an EngineResult with blocked
          // states and intentionally emits no run_start. Convert that result
          // into the same wire vocabulary the client reducer understands.
          if (shouldMirrorEngineResult(session.allBuffered())) {
            session.applyEngineResult(result);
            broadcastToClients(ws, session.emitSnapshot());
            const endEvent = session.ingest({
              type: 'run_end',
              runId,
              success: result.success,
              abortReason: null,
            });
            broadcastToClients(ws, endEvent);
            maybeResolveStartResponse(endEvent);
          }
        })
        .catch((err: unknown) => {
          session.success = false;
          const isAbort =
            err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
          if (isAbort) {
            // Synthesize a run_end so clients transition to a terminal
            // UI state even if the engine never got far enough to emit
            // one itself.
            const endEvent = session.ingest({
              type: 'run_end',
              runId,
              success: false,
              abortReason: 'external',
            });
            broadcastToClients(ws, endEvent);
            maybeResolveStartResponse(endEvent);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            session.errorMessage = message;
            const errorEvent = session.ingest({ type: 'run_error', runId, error: message });
            broadcastToClients(ws, errorEvent);
            maybeResolveStartResponse(errorEvent);
          }
        })
        .finally(() => {
          // Drain lingering approvals in case the engine rejected before
          // reaching its own finally.
          if (session.gateway.pending().length > 0) {
            session.gateway.abortAll('run finished');
          }
          try {
            let persistedPositions: Record<string, { x: number; y?: number }> = {};
            if (fromRunId === null) {
              persistedPositions = { ...ws.layout.positions };
            } else {
              const priorSummary = readRunSummary(cwd, fromRunId);
              if (priorSummary?.positions) {
                persistedPositions = { ...priorSummary.positions };
              }
            }
            persistRunSummary(
              ws,
              cwd,
              runId,
              session.buildSummary(new Date().toISOString(), persistedPositions),
              effectiveConfig,
              yamlOverride,
            );
          } catch (persistErr) {
            console.error('[run] failed to persist summary.json:', persistErr);
          }
          removeSession(ws, session);
        });

      sessionLaunched = true;
      endRunSessionStart(ws, startToken);
      // EventSource opens asynchronously in the renderer. A validation failure
      // can complete before the SSE request reaches this process, so return the
      // startup event buffer in the POST response as a lossless fallback.
      await Promise.race([
        startResponseReady,
        new Promise<void>((resolve) => setTimeout(resolve, START_RESPONSE_GRACE_MS)),
      ]);
      res.json({ ok: true, runId, yamlRunVersion, events: session.allBuffered() });
    } catch (err: unknown) {
      if (launchedSession) removeSession(ws, launchedSession);
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Run setup failed: ${message}` });
    } finally {
      if (!sessionLaunched) {
        if (launchedSession) removeSession(ws, launchedSession);
        endRunSessionStart(ws, startToken);
      }
    }
  });

  app.post('/api/run/abort', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = req.body ?? {};
    const hasRunId = Object.prototype.hasOwnProperty.call(body, 'runId');
    if (hasRunId && (typeof body.runId !== 'string' || !/^run_[A-Za-z0-9_-]+$/.test(body.runId))) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const requestedRunId: string | null = hasRunId ? body.runId : null;
    const liveSessions = listSessions(ws);
    if (!requestedRunId && liveSessions.length > 1) {
      return res.status(400).json({ error: 'runId is required when multiple runs are live' });
    }
    const session = requestedRunId ? getSession(ws, requestedRunId) : (liveSessions[0] ?? null);
    if (!session) {
      return res.status(404).json({ error: 'No run in progress' });
    }
    session.abort.abort();
    res.json({ ok: true });
  });

  app.post('/api/run/approval/:requestId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { requestId } = req.params;
    const { outcome, reason, actor } = req.body ?? {};
    if (outcome !== 'approved' && outcome !== 'rejected') {
      return res.status(400).json({ error: 'outcome must be approved|rejected' });
    }
    const session = findSessionForApproval(ws, requestId);
    if (!session) {
      return res.status(503).json({
        error: 'approval gateway not available — no run in progress',
      });
    }
    const ok = session.gateway.resolve(requestId, {
      outcome,
      reason,
      actor: actor ?? 'editor',
    });
    if (!ok) {
      return res.status(404).json({
        error: `approval ${requestId} not pending (already resolved or expired)`,
      });
    }
    res.json({ ok: true });
  });

  app.get('/api/run/history', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const cwd = ws.workDir || process.cwd();
    const logsDir = join(cwd, '.tagma', 'logs');
    try {
      let entries: RunHistoryEntry[] = [];
      if (existsSync(logsDir)) {
        assertNotSymlink(logsDir, '.tagma/logs');
        entries = readdirSync(logsDir)
          .filter((name) => name.startsWith('run_'))
          .map((name): RunHistoryEntry | null => {
            const full = join(logsDir, name);
            try {
              const st = lstatSync(full);
              if (!st.isDirectory()) return null;
              const logFile = join(full, 'pipeline.log');
              const logStat =
                existsSync(logFile) && !lstatSync(logFile).isSymbolicLink()
                  ? statSync(logFile)
                  : null;
              const summary = readRunSummary(cwd, name);
              return {
                runId: name,
                path: full,
                startedAt: summary?.startedAt ?? st.mtime.toISOString(),
                sizeBytes: logStat?.size ?? 0,
                pipelineName: summary?.pipelineName,
                yamlRunVersion: summary?.yamlRunVersion,
                success: summary?.success,
                finishedAt: summary?.finishedAt ?? undefined,
                replayedFromRunId: summary?.replayedFromRunId,
                taskCounts: summary ? computeTaskCounts(summary.tasks) : undefined,
              };
            } catch {
              return null;
            }
          })
          .filter((x): x is RunHistoryEntry => x !== null);
      }
      for (const session of listSessions(ws)) {
        const liveEntry = session.buildLiveHistoryEntry(cwd);
        const existing = entries.findIndex((entry) => entry.runId === liveEntry.runId);
        if (existing >= 0) entries[existing] = { ...entries[existing], ...liveEntry };
        else entries.push(liveEntry);
      }
      entries = entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, MAX_LOG_RUNS);
      res.json({ runs: entries });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.get('/api/run/history/:runId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = ws.workDir || process.cwd();
    let logFile: string;
    try {
      logFile = safeRunHistoryFile(cwd, runId, 'pipeline.log');
    } catch (err) {
      return res.status(403).json({ error: errorMessage(err) });
    }
    if (!existsSync(logFile)) {
      return res.status(404).json({ error: 'log not found' });
    }
    try {
      const MAX_LOG_BYTES = 1024 * 1024; // 1 MB cap
      const stat = statSync(logFile);
      let content: string;
      if (stat.size <= MAX_LOG_BYTES) {
        content = readFileSync(logFile, 'utf-8');
      } else {
        const readLen = MAX_LOG_BYTES;
        const offset = stat.size - readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const fd = openSync(logFile, 'r');
        try {
          readSync(fd, buf, 0, readLen, offset);
        } finally {
          closeSync(fd);
        }
        const raw = buf.toString('utf-8');
        const newline = raw.indexOf('\n');
        content = newline !== -1 ? raw.slice(newline + 1) : raw;
      }
      res.json({ runId, content });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.get('/api/run/history/:runId/summary', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = ws.workDir || process.cwd();
    const session = getSession(ws, runId);
    if (session) {
      return res.json(session.buildLiveSummary(positionsForSession(ws, cwd, session)));
    }
    const summary = readRunSummary(cwd, runId);
    if (!summary) {
      return res.status(404).json({ error: 'summary not found' });
    }
    res.json(summary);
  });

  // On-demand reader for a single task's full stdout/stderr from a past
  // run. The live RunTaskPanel only carries a bounded in-memory tail; the
  // complete streams are persisted to `.tagma/logs/<runId>/<taskId>.<stream>`
  // by the engine (RuntimeAdapter.taskOutputPath). History had no way to
  // reach them — this endpoint closes that gap with the same path-safety
  // and 1 MB tail-cap contract as the pipeline.log reader above.
  app.get('/api/run/history/:runId/task-output', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const stream = req.query.stream;
    if (stream !== 'stdout' && stream !== 'stderr') {
      return res.status(400).json({ error: 'stream must be "stdout" or "stderr"' });
    }
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    // A qualified task id is `<trackId>.<taskId>`, both slug-shaped. Reject
    // anything outside that charset so the derived file name can never
    // introduce a path separator or parent ref (`.` → `_` below also
    // collapses any `..` into `__`, but validate up front regardless).
    if (!isSafeTaskOutputId(taskId)) {
      return res.status(400).json({ error: 'invalid taskId' });
    }
    const cwd = ws.workDir || process.cwd();
    let outFile: string;
    try {
      outFile = safeRunTaskOutputFile(cwd, runId, taskId, stream);
    } catch (err) {
      return res.status(403).json({ error: errorMessage(err) });
    }
    if (!existsSync(outFile)) {
      return res.status(404).json({ error: 'task output not found' });
    }
    try {
      const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB cap — matches pipeline.log
      const stat = statSync(outFile);
      let content: string;
      let truncated = false;
      if (stat.size <= MAX_OUTPUT_BYTES) {
        content = readFileSync(outFile, 'utf-8');
      } else {
        truncated = true;
        const readLen = MAX_OUTPUT_BYTES;
        const offset = stat.size - readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const fd = openSync(outFile, 'r');
        try {
          readSync(fd, buf, 0, readLen, offset);
        } finally {
          closeSync(fd);
        }
        const raw = buf.toString('utf-8');
        // Drop the partial first line so the view starts on a clean boundary.
        const newline = raw.indexOf('\n');
        content = newline !== -1 ? raw.slice(newline + 1) : raw;
      }
      res.json({ runId, taskId, stream, content, size: stat.size, truncated });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.get('/api/run/history/:runId/ask-ai-context', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
    if (!isSafeTaskOutputId(taskId)) {
      return res.status(400).json({ error: 'invalid taskId' });
    }
    const cwd = ws.workDir || process.cwd();
    const context = buildRunHistoryAskAiContext(ws, cwd, runId, taskId);
    if (!context) {
      return res.status(404).json({ error: 'history ask ai context not found' });
    }
    res.json(context);
  });

  app.get('/api/run/history/:runId/yaml', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = ws.workDir || process.cwd();
    let yamlPath: string;
    try {
      yamlPath = safeRunHistoryFile(cwd, runId, 'pipeline.yaml');
    } catch (err) {
      return res.status(403).json({ error: errorMessage(err) });
    }
    if (!existsSync(yamlPath)) {
      return res.status(404).json({ error: 'yaml snapshot not found' });
    }
    res.type('text/yaml').send(readFileSync(yamlPath, 'utf-8'));
  });

  app.get('/api/run/history/:runId/replay-info', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = ws.workDir || process.cwd();
    let yamlPath: string;
    try {
      yamlPath = safeRunHistoryFile(cwd, runId, 'pipeline.yaml');
    } catch (err) {
      return res.status(403).json({ error: errorMessage(err) });
    }
    if (!existsSync(yamlPath)) {
      return res.status(404).json({ error: 'yaml snapshot not found' });
    }
    try {
      const diskYaml = readFileSync(yamlPath, 'utf-8');
      let config: RawPipelineConfig;
      try {
        config = parseYaml(diskYaml);
      } catch {
        config = lenientParseYaml(diskYaml, `Replay ${runId}`);
      }
      const dag = buildRawDag(config);
      const priorSummary = readRunSummary(cwd, runId);
      const positions = priorSummary?.positions ?? {};
      res.json({ config, dagEdges: dag.edges, positions });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
