import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEmptyPipeline,
  upsertTask,
  upsertTrack,
  validateRaw,
  type ValidationError,
} from '@tagma/sdk';
import type { ServerState } from '../src/api/client';
import { generateConfigId } from '../shared/config-id.js';
import { stopWatching } from '../server/file-watcher.js';
import { registerWorkspaceRoutes } from '../server/routes/workspace.js';
import { S, lenientParseYaml } from '../server/state.js';

const tempDirs: string[] = [];
const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-editor-'));
  tempDirs.push(dir);
  return dir;
}

function idValidationErrors(errors: readonly ValidationError[]): ValidationError[] {
  return errors.filter((err) => /id ".*" contains invalid characters/i.test(err.message));
}

function createRouteHarness() {
  type Handler = (req: { body?: Record<string, unknown> }, res: ReturnType<typeof makeRes>) => void;
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

  test('POST /api/new seeds a pipeline with valid track and task ids', async () => {
    S.workDir = makeTempDir();
    const harness = createRouteHarness();
    const req = { body: { name: 'Brand New Pipeline' } };
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
});
