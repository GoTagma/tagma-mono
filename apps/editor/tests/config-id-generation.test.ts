import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyPipeline,
  upsertTask,
  upsertTrack,
  validateRaw,
  TASK_ID_RE,
  type ValidationError,
} from '@tagma/sdk/config';
import type { ServerState } from '../src/api/client';
import { generateConfigId } from '../shared/config-id.js';
import { stopWatching } from '../server/file-watcher.js';
import { registerWorkspaceRoutes } from '../server/routes/workspace.js';
import { S, lenientParseYaml, loadLayout } from '../server/state.js';

const tempDirs: string[] = [];
// Canonical regex lives in @tagma/sdk — importing here guards against the
// editor's generator drifting away from what SDK's validateRaw accepts.
const ID_RE = TASK_ID_RE;

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-editor-'));
  tempDirs.push(dir);
  return dir;
}

function idValidationErrors(errors: readonly ValidationError[]): ValidationError[] {
  // Matches the canonical INVALID_TASK_ID_REASON suffix from @tagma/core.
  return errors.filter((err) => /id ".*" is invalid\. IDs must match/i.test(err.message));
}

function createRouteHarness() {
  type Handler = (
    req: { body?: Record<string, unknown>; workspace?: unknown },
    res: ReturnType<typeof makeRes>,
  ) => void;
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    post(path: string, handler: Handler) {
      routes.set(`POST ${path}`, handler);
      return app;
    },
    patch(path: string, handler: Handler) {
      routes.set(`PATCH ${path}`, handler);
      return app;
    },
    delete(path: string, handler: Handler) {
      routes.set(`DELETE ${path}`, handler);
      return app;
    },
  };
  registerWorkspaceRoutes(app as never);
  return {
    getHandler(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string): Handler {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Missing handler for ${method} ${path}`);
      return handler;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

afterEach(() => {
  stopWatching();
  S.config = createEmptyPipeline('Untitled Pipeline');
  S.yamlPath = null;
  S.workDir = '';
  S.layout = { positions: {} };
  S.stateRevision = 0;
  S.stateEventSeq = 0;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config id generation', () => {
  test('shared generator always produces ids accepted by validateRaw', () => {
    for (let i = 0; i < 100; i++) {
      const trackId = generateConfigId();
      const taskId = generateConfigId();
      let config = createEmptyPipeline('Generated IDs');
      config = upsertTrack(config, {
        id: trackId,
        name: 'Track 1',
        color: '#3b82f6',
        tasks: [],
      });
      config = upsertTask(config, trackId, {
        id: taskId,
        name: 'Task 1',
        prompt: 'Hello world!',
      });

      expect(trackId).toMatch(ID_RE);
      expect(taskId).toMatch(ID_RE);
      expect(idValidationErrors(validateRaw(config))).toHaveLength(0);
    }
  });

  test('lenientParseYaml backfills missing track/task ids with valid ids', () => {
    const config = lenientParseYaml(
      `
pipeline:
  name: Backfill IDs
  tracks:
    - name: Track 1
      tasks:
        - name: Task 1
          prompt: Hello world!
`,
      'Fallback Pipeline',
    );

    expect(config.tracks).toHaveLength(1);
    expect(config.tracks[0]?.id).toMatch(ID_RE);
    expect(config.tracks[0]?.tasks).toHaveLength(1);
    expect(config.tracks[0]?.tasks[0]?.id).toMatch(ID_RE);
    expect(idValidationErrors(validateRaw(config))).toHaveLength(0);
  });

  test('lenientParseYaml drops legacy ports field outside the SDK schema', () => {
    const config = lenientParseYaml(
      `
pipeline:
  name: Legacy Ports
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          prompt: Hello world!
          ports:
            inputs:
              - name: city
                type: string
`,
      'Fallback Pipeline',
    );

    const task = config.tracks[0]!.tasks[0]! as unknown as Record<string, unknown>;
    expect('ports' in task).toBe(false);
  });

  test('loadLayout sanitizes malformed folder entries from layout.json', () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'pipeline.yaml');
    writeFileSync(yamlPath, 'pipeline:\n  name: Layout\n');
    writeFileSync(
      join(dir, 'pipeline.layout.json'),
      JSON.stringify({
        positions: {
          'track.task': { x: 120 },
          'track.bad': { x: Number.POSITIVE_INFINITY },
          'ghost.task': { x: 240 },
        },
        folders: [
          {
            id: 'folder_a',
            name: 'Folder A',
            color: '#22c55e',
            trackIds: ['track', 'ghost', 'track'],
            collapsed: true,
          },
          { id: 'folder_b', name: 'Folder B', trackIds: ['track'] },
          { id: 'folder_a', name: 'Duplicate', trackIds: [] },
          { id: 'bad_name', name: 123, trackIds: ['track'] },
        ],
      }),
    );

    let config = createEmptyPipeline('Layout');
    config = upsertTrack(config, {
      id: 'track',
      name: 'Track',
      color: '#3b82f6',
      tasks: [],
    });
    config = upsertTask(config, 'track', {
      id: 'task',
      name: 'Task',
      prompt: 'Hello',
    });
    S.config = config;
    S.yamlPath = yamlPath;

    loadLayout(S);

    expect(S.layout.positions).toEqual({ 'track.task': { x: 120 } });
    expect(S.layout.folders).toEqual([
      {
        id: 'folder_a',
        name: 'Folder A',
        color: '#22c55e',
        trackIds: ['track'],
        collapsed: true,
      },
      {
        id: 'folder_b',
        name: 'Folder B',
        color: undefined,
        trackIds: [],
        collapsed: false,
      },
    ]);
  });

  test('loadLayout preserves task y coordinates and track heights from layout.json', () => {
    const dir = makeTempDir();
    const yamlPath = join(dir, 'pipeline.yaml');
    writeFileSync(yamlPath, 'pipeline:\n  name: Layout\n');
    writeFileSync(
      join(dir, 'pipeline.layout.json'),
      JSON.stringify({
        positions: {
          'track.task': { x: 120, y: 24 },
          'track.bad': { x: 80, y: Number.NaN },
          'ghost.task': { x: 240, y: 12 },
        },
        trackHeights: {
          track: 144,
          ghost: 200,
          bad: Number.POSITIVE_INFINITY,
        },
      }),
    );

    let config = createEmptyPipeline('Layout');
    config = upsertTrack(config, {
      id: 'track',
      name: 'Track',
      tasks: [],
    });
    config = upsertTask(config, 'track', {
      id: 'task',
      name: 'Task',
      prompt: 'Hello',
    });
    S.config = config;
    S.yamlPath = yamlPath;

    loadLayout(S);

    expect(S.layout.positions).toEqual({ 'track.task': { x: 120, y: 24 } });
    expect(S.layout.trackHeights).toEqual({ track: 144 });
  });

  test('POST /api/new seeds a pipeline with valid track and task ids', async () => {
    S.workDir = makeTempDir();
    const harness = createRouteHarness();
    // Multi-workspace routes require `req.workspace` — the real Express app
    // populates it via the `resolveWorkspace` middleware. In this in-process
    // harness we stamp the default singleton directly.
    const req = { body: { name: 'Brand New Pipeline' }, workspace: S };
    const res = makeRes();

    await harness.getHandler('POST', '/api/new')(req, res);

    expect(res.statusCode).toBe(200);
    const state = res.body as ServerState;
    expect(state.config.tracks).toHaveLength(1);
    expect(state.config.tracks[0]?.id).toMatch(ID_RE);
    expect(state.config.tracks[0]?.tasks).toHaveLength(1);
    expect(state.config.tracks[0]?.tasks[0]?.id).toMatch(ID_RE);
    expect(idValidationErrors(state.validationErrors)).toHaveLength(0);
  });

  test('POST /api/open assigns default colors to colorless YAML tracks', async () => {
    S.workDir = makeTempDir();
    const tagmaDir = join(S.workDir, '.tagma');
    // Pipeline layout requires .tagma/<stem>/<stem>.yaml — assertPipelineYamlPath
    // enforces folder name == YAML stem on every read/write path.
    const pipelineFolder = join(tagmaDir, 'chat-created');
    mkdirSync(pipelineFolder, { recursive: true });
    const yamlPath = join(pipelineFolder, 'chat-created.yaml');
    writeFileSync(
      yamlPath,
      `
pipeline:
  name: Chat Created
  tracks:
    - id: research
      name: Research
      tasks:
        - id: gather
          name: Gather
          prompt: Gather context.
    - id: build
      name: Build
      tasks:
        - id: run
          name: Run
          prompt: Run the build.
`,
    );

    const harness = createRouteHarness();
    const req = { body: { path: yamlPath }, workspace: S };
    const res = makeRes();

    await harness.getHandler('POST', '/api/open')(req, res);

    expect(res.statusCode).toBe(200);
    const state = res.body as ServerState;
    expect(state.config.tracks.map((track) => track.color)).toEqual(['#3b82f6', '#10b981']);
  });
});

describe('workspace YAML listing', () => {
  test('GET /api/workspace/yamls includes companion layout metadata', () => {
    S.workDir = makeTempDir();
    const tagmaDir = join(S.workDir, '.tagma');
    // Foldered pipeline layout: .tagma/<stem>/<stem>.yaml + <stem>.layout.json
    const pipelineFolder = join(tagmaDir, 'pipeline');
    mkdirSync(pipelineFolder, { recursive: true });
    const yamlContent = `
pipeline:
  name: Layout Fingerprint
  tracks: []
`;
    const layoutContent = JSON.stringify({ positions: { 'track.task': { x: 240 } } }, null, 2);
    writeFileSync(join(pipelineFolder, 'pipeline.yaml'), yamlContent);
    writeFileSync(join(pipelineFolder, 'pipeline.layout.json'), layoutContent);

    const harness = createRouteHarness();
    const req = { workspace: S };
    const res = makeRes();

    harness.getHandler('GET', '/api/workspace/yamls')(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      entries: Array<{
        name: string;
        layoutHash: string | null;
        layoutMtimeMs: number | null;
        layoutSize: number | null;
      }>;
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      name: 'pipeline.yaml',
      layoutHash: sha1(layoutContent),
      layoutSize: Buffer.byteLength(layoutContent),
    });
    expect(body.entries[0]?.layoutMtimeMs).toEqual(expect.any(Number));
    const manifestPath = join(pipelineFolder, 'pipeline.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      kind?: string;
      pipeline?: { name?: string };
    };
    expect(manifest.kind).toBe('tagma-pipeline-manifest');
    expect(manifest.pipeline?.name).toBe('Layout Fingerprint');
  });
});
