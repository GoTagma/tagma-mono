import { afterEach, describe, expect, test } from 'bun:test';
import type { RawPipelineConfig } from '@tagma/sdk';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { registerPipelineRoutes } from '../server/routes/pipeline';
import { S } from '../server/state';

type RouteHandler = (
  req: { body?: Record<string, unknown>; workspace?: typeof S },
  res: ReturnType<typeof makeRes>,
) => void;

function createRouteHarness() {
  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return app;
    },
    patch(path: string, handler: RouteHandler) {
      routes.set(`PATCH ${path}`, handler);
      return app;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return app;
    },
  };
  registerPipelineRoutes(app as never);
  return {
    post(path: string): RouteHandler {
      const handler = routes.get(`POST ${path}`);
      if (!handler) throw new Error(`Missing handler for POST ${path}`);
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

function seedConfig(): RawPipelineConfig {
  return {
    name: 'Pipeline',
    tracks: [
      {
        id: 'source',
        name: 'Source',
        tasks: [{ id: 'from', name: 'From', prompt: 'Produce output' }],
      },
      {
        id: 'target',
        name: 'Target',
        tasks: [{ id: 'to', name: 'To', prompt: 'Consume input' }],
      },
    ],
  };
}

function targetTask() {
  return S.config.tracks.find((t) => t.id === 'target')?.tasks.find((t) => t.id === 'to');
}

afterEach(() => {
  S.config = createEmptyPipeline('Untitled Pipeline');
  S.yamlPath = null;
  S.workDir = '';
  S.layout = { positions: {} };
  S.stateRevision = 0;
  S.stateEventSeq = 0;
});

describe('pipeline route validation', () => {
  test('POST /api/tasks rejects missing task id without mutating config', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/tasks');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: { trackId: 'target', task: { name: 'No id', prompt: 'Bad task' } },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('non-empty string id');
    expect(S.config).toBe(before);
    expect(S.config.tracks.find((t) => t.id === 'target')?.tasks).toHaveLength(1);
  });

  test('POST /api/tasks rejects unknown target track without mutating config', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/tasks');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: { trackId: 'missing', task: { id: 'new_task', name: 'New', prompt: 'Hello' } },
      },
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(String((res.body as { error?: unknown }).error)).toContain('Track not found');
    expect(S.config).toBe(before);
  });

  test('POST /api/dependencies rejects an unknown source track without mutating config', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/dependencies');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          fromTrackId: 'missing',
          fromTaskId: 'from',
          toTrackId: 'target',
          toTaskId: 'to',
        },
      },
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(String((res.body as { error?: unknown }).error)).toContain('Source track not found');
    expect(S.config).toBe(before);
    expect(targetTask()?.depends_on).toBeUndefined();
  });

  test('POST /api/dependencies rejects an unknown source task without mutating config', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/dependencies');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          fromTrackId: 'source',
          fromTaskId: 'missing',
          toTrackId: 'target',
          toTaskId: 'to',
        },
      },
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(String((res.body as { error?: unknown }).error)).toContain('Source task not found');
    expect(S.config).toBe(before);
    expect(targetTask()?.depends_on).toBeUndefined();
  });

  test('POST /api/dependencies still accepts valid source and target ids', () => {
    S.config = seedConfig();
    const handler = createRouteHarness().post('/api/dependencies');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          fromTrackId: 'source',
          fromTaskId: 'from',
          toTrackId: 'target',
          toTaskId: 'to',
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(targetTask()?.depends_on).toEqual(['source.from']);
  });
});

describe('POST /api/config/replace bounded-json + whitelist sanitizer', () => {
  test('rejects payloads containing forbidden prototype-pollution keys', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/config/replace');
    const res = makeRes();

    // JSON.parse models the real wire-format Express delivers and (unlike an
    // object literal) installs `__proto__` as an own enumerable property
    // rather than mutating the receiver's prototype, so the FORBIDDEN_JSON_KEYS
    // guard sees it during the assertBoundedJson walk.
    const body = JSON.parse(
      '{"config":{"name":"Pipeline","tracks":[],"__proto__":{"polluted":true}}}',
    );

    handler({ workspace: S, body }, res);

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('forbidden key');
    expect(S.config).toBe(before);
  });

  test('strips unknown fields at pipeline / track / task / folder levels', () => {
    S.config = seedConfig();
    const handler = createRouteHarness().post('/api/config/replace');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          config: {
            name: 'Pipeline',
            // Unknown pipeline-level field — must be stripped before reaching ws.config.
            evil_pipeline_extra: 'pipeline-leak',
            tracks: [
              {
                id: 'source',
                name: 'Source',
                // Unknown track-level field — must be stripped.
                evil_track_extra: 'track-leak',
                tasks: [
                  {
                    id: 'from',
                    name: 'From',
                    prompt: 'Produce',
                    // Unknown task-level field — must be stripped.
                    evil_task_extra: 'task-leak',
                  },
                ],
              },
            ],
          },
          layout: {
            positions: {},
            folders: [
              {
                id: 'f1',
                name: 'Folder',
                trackIds: ['source'],
                collapsed: false,
                // Unknown folder-level field — must be stripped.
                evil_folder_extra: 'folder-leak',
              },
            ],
          },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(S.config).not.toHaveProperty('evil_pipeline_extra');
    const sourceTrack = S.config.tracks.find((t) => t.id === 'source');
    expect(sourceTrack).toBeDefined();
    expect(sourceTrack).not.toHaveProperty('evil_track_extra');
    const fromTask = sourceTrack?.tasks.find((t) => t.id === 'from');
    expect(fromTask).toBeDefined();
    expect(fromTask).not.toHaveProperty('evil_task_extra');
    const folder = S.layout.folders?.find((f) => f.id === 'f1');
    expect(folder).toBeDefined();
    expect(folder).not.toHaveProperty('evil_folder_extra');
    expect(folder?.trackIds).toEqual(['source']);
  });

  test('rejects payloads that exceed the replace JSON-node budget', () => {
    S.config = seedConfig();
    const before = S.config;
    const handler = createRouteHarness().post('/api/config/replace');
    const res = makeRes();

    // REPLACE_LIMITS sets maxNodes = 20_000. Build a tracks array large enough
    // that the bounded-json walker exhausts the budget before structural
    // validation runs. Each track contributes >2 nodes (track object + tasks
    // array + per-task object), so 25_000 entries is comfortably over.
    const overflowTracks = [];
    for (let i = 0; i < 25_000; i++) {
      overflowTracks.push({ id: `t${i}`, name: 't', tasks: [] });
    }

    handler(
      {
        workspace: S,
        body: { config: { name: 'Pipeline', tracks: overflowTracks } },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('too large');
    expect(S.config).toBe(before);
  });
});
