import type express from 'express';
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import yaml from 'js-yaml';
import { generateConfigId } from '../../shared/config-id.js';
import {
  createEmptyPipeline,
  upsertTrack,
  upsertTask,
  parseYaml,
  serializePipeline,
} from '@tagma/sdk';
import {
  S,
  getState,
  isPathWithin,
  assertWithinWorkspace,
  loadLayout,
  saveLayout,
  beginWatching,
  lenientParseYaml,
} from '../state.js';
import { errorMessage, atomicWriteFileSync } from '../path-utils.js';

const PORT = parseInt(process.env.PORT ?? '3001');
const DEFAULT_ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const EXTRA_ALLOWED_ORIGINS = (process.env.TAGMA_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);
import { stopWatching as stopFileWatching } from '../file-watcher.js';
import { unregisterPlugin } from '@tagma/sdk';
import {
  autoLoadInstalledPlugins,
  loadedPluginMeta,
  readEditorSettings,
  writeEditorSettings,
  DEFAULT_EDITOR_SETTINGS,
  invalidatePluginCache,
  type EditorSettings,
} from '../plugins/loader.js';

/**
 * Plugins are workspace-scoped (installed under `workDir/node_modules`), but
 * the SDK registry and `loadedPluginMeta` are process-level globals. Without
 * this sweep, handlers loaded by a previous workspace would linger in the
 * registry, causing the driver dropdown to offer plugins that aren't present
 * in the new workspace and the Plugins page to show them as `loaded:true` /
 * `installed:false` ("missing").
 *
 * Note: ESM module cache still holds the old code — reopening the prior
 * workspace will re-register the same handler via the SDK's "replaced"
 * branch rather than hot-reloading a new version. Same caveat as uninstall.
 */
function unloadAllPluginsForWorkspaceSwitch(): void {
  for (const meta of loadedPluginMeta.values()) {
    try {
      unregisterPlugin(meta.category, meta.type);
    } catch {
      /* best-effort */
    }
  }
  loadedPluginMeta.clear();
}
import { recordWorkspaceOpen } from './recent.js';

/** Given a YAML path, return the companion layout.json path. */
function companionLayoutPath(yamlFilePath: string): string {
  return yamlFilePath.replace(/\.ya?ml$/i, '.layout.json');
}

export function registerWorkspaceRoutes(app: express.Express): void {
  // ── Workspace ──
  // NOTE: GET /api/workspace removed — same data is included in GET /api/state.

  app.patch('/api/workspace', async (req, res) => {
    const { workDir: wd } = req.body;
    if (wd !== undefined) {
      unloadAllPluginsForWorkspaceSwitch();
      S.workDir = resolve(wd);
      invalidatePluginCache();
      mkdirSync(join(S.workDir, '.tagma'), { recursive: true });
      await autoLoadInstalledPlugins();
      recordWorkspaceOpen(S.workDir);
    }
    res.json(getState());
  });

  // ── Editor settings (per-workspace user preferences) ──
  app.get('/api/editor-settings', (_req, res) => {
    if (!S.workDir) {
      return res.json({ ...DEFAULT_EDITOR_SETTINGS });
    }
    res.json(readEditorSettings());
  });

  app.patch('/api/editor-settings', (req, res) => {
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<EditorSettings> = {};
    if (typeof body.autoInstallDeclaredPlugins === 'boolean') {
      patch.autoInstallDeclaredPlugins = body.autoInstallDeclaredPlugins;
    }
    try {
      const next = writeEditorSettings(patch);
      res.json(next);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: `Failed to save editor settings: ${msg}` });
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
    const requested = (req.query.path as string) || S.workDir;
    const isPicker = req.query.picker === '1' || req.query.picker === 'true';
    // C3b: picker mode allows browsing outside workDir, but must come from
    // an allowed origin. Without this check, a CSRF page could use picker
    // mode to enumerate the host filesystem.
    if (isPicker) {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ error: 'Picker mode requires an allowed Origin' });
      }
    }
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
      if (!isPicker) {
        try {
          assertWithinWorkspace(dirPath, 'directory');
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Path is outside the workspace directory';
          return res.status(403).json({ error: msg });
        }
      }
      const entries = readdirSync(dirPath, { withFileTypes: true })
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
      const parent = dirname(dirPath);
      res.json({ path: dirPath, parent: parent !== dirPath ? parent : null, entries });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to list directory' });
    }
  });

  app.get('/api/workspace/yamls', (_req, res) => {
    if (!S.workDir) return res.json({ entries: [] });
    const tagmaDir = resolve(S.workDir, '.tagma');
    if (!existsSync(tagmaDir)) return res.json({ entries: [] });
    try {
      const entries = readdirSync(tagmaDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
        .map((e) => {
          const absPath = resolve(tagmaDir, e.name);
          let pipelineName: string | null = null;
          try {
            const doc = yaml.load(readFileSync(absPath, 'utf-8')) as Record<string, unknown> | null;
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
          return { name: e.name, path: absPath, pipelineName };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ entries });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to list workspace yamls' });
    }
  });

  app.get('/api/fs/roots', (_req, res) => {
    // On Windows, list drive letters; on Unix, just "/"
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

  app.post('/api/fs/mkdir', (req, res) => {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'path is required' });
    const absPath = resolve(dirPath);
    // C3: mkdir opts out of the workspace fence when invoked from a picker
    // (workspace-root / import / export) UI that is explicitly allowed to
    // walk the host filesystem. Otherwise B1: mkdir must stay within workDir.
    const isPicker = req.query.picker === '1' || req.query.picker === 'true';
    // C3b: picker mode mkdir must come from an allowed origin (same as fs/list).
    if (isPicker) {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ error: 'Picker mode requires an allowed Origin' });
      }
    }
    if (!isPicker && S.workDir && !isPathWithin(absPath, S.workDir)) {
      return res.status(403).json({ error: 'Path is outside the workspace directory' });
    }
    try {
      mkdirSync(absPath, { recursive: true });
      res.json({ path: absPath });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to create directory' });
    }
  });

  app.post('/api/fs/reveal', (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const absPath = resolve(filePath);
    // B1: reveal must stay within workDir to prevent revealing arbitrary filesystem paths.
    if (S.workDir && !isPathWithin(absPath, S.workDir)) {
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
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absPath: string;
    try {
      // C3: All editor "open" calls go through the workspace YAML list — there
      // is no UI path that opens a YAML outside workDir. Refusing it server-side
      // closes the CSRF/path-traversal door (e.g. a malicious page asking us to
      // parse and stash arbitrary files into `config`).
      absPath = assertWithinWorkspace(resolve(filePath), 'file to open');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      if (!existsSync(absPath)) {
        return res.status(404).json({ error: `File not found: ${absPath}` });
      }
      const content = readFileSync(absPath, 'utf-8');
      try {
        S.config = parseYaml(content);
      } catch {
        // parseYaml is strict — fall back to lenient loading
        S.config = lenientParseYaml(content, basename(absPath, '.yaml').replace(/[-_]/g, ' '));
      }
      S.yamlPath = absPath;
      loadLayout();
      beginWatching(absPath, content);
      await autoLoadInstalledPlugins();
      res.json(getState());
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to open file' });
    }
  });

  app.post('/api/save', (_req, res) => {
    let savePath = S.yamlPath;
    if (!savePath) {
      if (!S.workDir)
        return res.status(400).json({ error: 'No file path and no workspace configured.' });
      const tagmaDir = join(S.workDir, '.tagma');
      mkdirSync(tagmaDir, { recursive: true });
      const randomId = Math.random().toString(36).slice(2, 10);
      savePath = join(tagmaDir, `pipeline-${randomId}.yaml`);
    }
    try {
      // B4: Stop the existing watcher BEFORE writing so the old watcher's
      // debounced check() can't fire between writeFileSync and beginWatching,
      // which would falsely detect our own write as an external change.
      stopFileWatching();
      const content = serializePipeline(S.config);
      atomicWriteFileSync(savePath, content);
      S.yamlPath = savePath;
      saveLayout();
      beginWatching(savePath, content);
      res.json(getState());
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to save file' });
    }
  });

  app.post('/api/save-as', (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absPath: string;
    try {
      // C3 / M3: client.commitSaveAs always pins targets under {workDir}/.tagma,
      // but the server used to accept any path. Fence here so the wire contract
      // matches the UI contract — Save As cannot be used as an arbitrary YAML
      // writer by a page in another browser tab.
      absPath = assertWithinWorkspace(resolve(filePath), 'save target');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    try {
      // B4: Stop watcher before write to prevent false external-change detection.
      stopFileWatching();
      const yaml = serializePipeline(S.config);
      atomicWriteFileSync(absPath, yaml);
      S.yamlPath = absPath;
      saveLayout();
      beginWatching(absPath, yaml);
      res.json(getState());
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to save file' });
    }
  });

  app.post('/api/new', (req, res) => {
    const { name } = req.body;
    if (!S.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    const tagmaDir = join(S.workDir, '.tagma');
    mkdirSync(tagmaDir, { recursive: true });
    const randomId = Math.random().toString(36).slice(2, 10);
    const fileName = `pipeline-${randomId}.yaml`;
    S.config = createEmptyPipeline(name || 'Untitled Pipeline');
    // Seed a default track + task so new pipelines start without validation errors
    const trackId = generateConfigId();
    S.config = upsertTrack(S.config, { id: trackId, name: 'Track 1', color: '#3b82f6', tasks: [] });
    const taskId = generateConfigId();
    S.config = upsertTask(S.config, trackId, {
      id: taskId,
      name: 'Task 1',
      prompt: 'Hello world!',
    });
    S.yamlPath = join(tagmaDir, fileName);
    S.layout = { positions: {} };
    const content = serializePipeline(S.config);
    atomicWriteFileSync(S.yamlPath, content);
    beginWatching(S.yamlPath, content);
    res.json(getState());
  });

  // ── Layout (editor positions) ──
  app.patch('/api/layout', (req, res) => {
    const { positions } = req.body;
    if (positions) S.layout.positions = positions;
    saveLayout();
    res.json({ ok: true });
  });

  // Import: copy external YAML (and its companion .layout.json, if present)
  // into .tagma/ and open the copy
  app.post('/api/import-file', async (req, res) => {
    const { sourcePath } = req.body;
    if (!sourcePath) return res.status(400).json({ error: 'sourcePath is required' });
    if (!S.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    // C3: source path is user-picked, so we can't fence it to the workspace.
    // Restrict to YAML extensions to cap blast radius — a CSRF attempt that
    // tries to slurp `id_rsa` into the workspace fails the extension check.
    if (!/\.ya?ml$/i.test(sourcePath)) {
      return res.status(400).json({ error: 'sourcePath must be a .yaml or .yml file' });
    }
    const absSource = resolve(sourcePath);
    if (!existsSync(absSource))
      return res.status(404).json({ error: `File not found: ${absSource}` });
    const tagmaDir = join(S.workDir, '.tagma');
    mkdirSync(tagmaDir, { recursive: true });
    // Sanitize the destination filename: basename() keeps the extension and
    // strips any directory components, so an attacker can't smuggle "../" in
    // sourcePath to escape the workspace on the destination side.
    const safeName = basename(absSource);
    const destPath = assertWithinWorkspace(join(tagmaDir, safeName), 'import destination');
    try {
      const content = readFileSync(absSource, 'utf-8');
      atomicWriteFileSync(destPath, content);
      // Copy the companion layout file alongside the YAML, if it exists.
      const sourceLayoutFile = companionLayoutPath(absSource);
      const destLayoutFile = companionLayoutPath(destPath);
      if (existsSync(sourceLayoutFile)) {
        try {
          atomicWriteFileSync(destLayoutFile, readFileSync(sourceLayoutFile, 'utf-8'));
        } catch {
          /* best-effort — missing or unreadable layout should not block import */
        }
      }
      try {
        S.config = parseYaml(content);
      } catch {
        S.config = lenientParseYaml(content, basename(absSource, '.yaml').replace(/[-_]/g, ' '));
      }
      S.yamlPath = destPath;
      loadLayout();
      beginWatching(destPath, content);
      await autoLoadInstalledPlugins();
      // Check if imported YAML contains shell command tasks — warn the user
      // that imported pipelines may execute arbitrary shell commands.
      const hasCommandTasks = S.config.tracks.some((t) => t.tasks.some((task) => task.command));
      const state = getState();
      if (hasCommandTasks) {
        (state as Record<string, unknown>).importWarning =
          'This pipeline contains shell command tasks that will execute on the host machine when run. Review them before starting a run.';
      }
      res.json(state);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to import file' });
    }
  });

  // Export: serialize current config and copy to destination directory,
  // along with its companion .layout.json so positions travel with the YAML.
  app.post('/api/export-file', (req, res) => {
    const { destDir } = req.body;
    if (!destDir) return res.status(400).json({ error: 'destDir is required' });
    if (!S.yamlPath) return res.status(400).json({ error: 'No pipeline file to export' });
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
      const content = serializePipeline(S.config);
      atomicWriteFileSync(S.yamlPath, content);
      // Keep the source-of-truth layout in sync on disk before copying.
      saveLayout();
      const destPath = join(absDestDir, basename(S.yamlPath));
      atomicWriteFileSync(destPath, content);
      // Write the companion layout next to the exported YAML.
      const destLayoutFile = companionLayoutPath(destPath);
      atomicWriteFileSync(destLayoutFile, JSON.stringify(S.layout, null, 2));
      res.json({ ok: true, path: destPath });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to export file' });
    }
  });

  // Delete a YAML and its companion .layout.json. If the deleted file is the
  // one currently loaded, reset in-memory state back to a blank pipeline so the
  // client can decide what to open next.
  app.post('/api/delete-file', (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    let absPath: string;
    try {
      // C3: deletes are the highest-blast-radius file op. The UI only ever
      // calls this with a path returned by /api/workspace/yamls (i.e. always
      // inside .tagma/) so the workspace fence is a tight, principled bound.
      absPath = assertWithinWorkspace(resolve(filePath), 'file to delete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Path is outside the workspace directory';
      return res.status(403).json({ error: msg });
    }
    // C3: only YAML files under .tagma/ are user-deletable through this
    // endpoint. Layout files travel with their YAML and are removed transitively.
    if (!/\.ya?ml$/i.test(absPath)) {
      return res
        .status(400)
        .json({ error: 'Only .yaml/.yml pipeline files can be deleted via this endpoint' });
    }
    try {
      if (existsSync(absPath)) {
        rmSync(absPath, { force: true });
      }
      const layoutFile = companionLayoutPath(absPath);
      if (existsSync(layoutFile)) {
        rmSync(layoutFile, { force: true });
      }
      if (S.yamlPath === absPath) {
        S.yamlPath = null;
        S.config = createEmptyPipeline('Untitled Pipeline');
        S.layout = { positions: {} };
        stopFileWatching();
      }
      res.json(getState());
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to delete file' });
    }
  });

  // ── Load demo ──
  app.post('/api/demo', (_req, res) => {
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
      S.config = parseYaml(DEMO);
      res.json(getState());
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
