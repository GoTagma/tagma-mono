import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type express from 'express';
import { registerPipelineRoutes } from '../server/routes/pipeline';
import { WorkspaceState } from '../server/workspace-state';

function harness() {
  const handlers = new Map<string, express.RequestHandler>();
  const register = (paths: string | string[], handler: express.RequestHandler) => {
    for (const path of typeof paths === 'string' ? [paths] : paths) handlers.set(path, handler);
  };
  registerPipelineRoutes({
    get: register,
    post: register,
    patch: register,
    delete: register,
  } as unknown as express.Express);
  return (ws: WorkspaceState | null, query: Record<string, unknown>) => {
    const req = Object.assign(new EventEmitter(), {
      workspace: ws,
      path: '/api/workspace/events',
      query,
    });
    const frames: string[] = [];
    let status = 200;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      write(frame: string) {
        frames.push(frame);
      },
      status(code: number) {
        status = code;
        return res;
      },
      json(value: unknown) {
        frames.push(JSON.stringify(value));
      },
    };
    handlers.get('/api/workspace/events')!(
      req as unknown as express.Request,
      res as unknown as express.Response,
      () => {},
    );
    return { req, res, frames, status };
  };
}

test('one response subscribes to three workspace channels and close removes every registration', () => {
  const serve = harness();
  const a = new WorkspaceState('/tmp/workspace-events-a');
  const b = new WorkspaceState('/tmp/workspace-events-b');
  const runCursors: number[] = [],
    workflowCursors: number[] = [];
  a.runSessions.set('run_a', {
    runId: 'run_a',
    allBuffered: () => [],
    replayAfter(seq: number) {
      runCursors.push(seq);
      return [{ runId: 'run_a', seq: seq + 1 }];
    },
    emitSnapshot: () => ({ runId: 'run_a', seq: 9, type: 'run_snapshot' }),
  });
  a.workflowRunSession = {
    graphRunId: 'graph_b',
    allBuffered: () => [],
    replayAfter(seq: number) {
      workflowCursors.push(seq);
      return [{ graphRunId: 'graph_b', seq: seq + 1 }];
    },
  };
  const response = serve(a, {
    channels: 'state_event,run_event,workflow_event',
    runAfter: 'run_a:7',
    workflowAfter: 'graph_b:11',
  });
  expect(response.status).toBe(200);
  expect([a.stateEventClients.size, a.runSseClients.size, a.workflowSseClients.size]).toEqual([
    1, 1, 1,
  ]);
  expect([b.stateEventClients.size, b.runSseClients.size, b.workflowSseClients.size]).toEqual([
    0, 0, 0,
  ]);
  expect([runCursors, workflowCursors]).toEqual([[7], [11]]);
  expect(response.frames.join('')).toContain('event: state_event');
  expect(response.frames.join('')).toContain('id: run_a:8');
  expect(response.frames.join('')).toContain('id: graph_b:12');
  response.req.emit('close');
  response.req.emit('close');
  expect([a.stateEventClients.size, a.runSseClients.size, a.workflowSseClients.size]).toEqual([
    0, 0, 0,
  ]);
});

test('invalid channels or cursors fail before registering a subscription; welcome does not join a workspace', () => {
  const serve = harness();
  const ws = new WorkspaceState('/tmp/workspace-events-validation');
  for (const query of [
    { channels: 'state_event,chat_operation_wake' },
    { channels: 'run_event', runAfter: 'run_a:1junk' },
    { channels: 'run_event', runAfter: 'run_a:9007199254740992' },
    { channels: 'state_event,state_event' },
  ])
    expect(serve(ws, query).status).toBe(400);
  expect([ws.stateEventClients.size, ws.runSseClients.size, ws.workflowSseClients.size]).toEqual([
    0, 0, 0,
  ]);
  expect(serve(null, { channels: 'state_event' }).frames.join('')).toContain('"yamlPath":null');
});
