// Regression test for the "sidecar review" Bug #1: before the fix, the
// file-watcher → SSE bridge was only wired for the default `S` workspace,
// so external YAML edits in any real (non-default) workspace silently
// never reached that workspace's `state_event` subscribers.
//
// The fix (apps/editor/server/state.ts + workspace-registry.ts) registers
// `attachFileWatcherBridge` as a `WorkspaceRegistry.setOnCreate` hook so
// EVERY WorkspaceState — the default sentinel and every real per-path
// workspace created by `resolveWorkspace` — gets a live bridge.
//
// This test pins that contract: create a non-default workspace via the
// registry, fire a synthetic watcher event, and assert the SSE payload
// landed on the workspace's own subscriber list (and only there).

import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'express';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { serializePipeline } from '@tagma/sdk/yaml';
import { loadLayout, S, syncLayoutWatcherFromDisk } from '../server/state';
import { workspaceRegistry, DEFAULT_WORKSPACE_KEY } from '../server/workspace-registry';
import type { WorkspaceState } from '../server/workspace-state';
import type { ExternalChangeEvent, LayoutChangeEvent } from '../server/file-watcher';
import { getFileVersion } from '../server/optimistic-lock';

// Minimal express.Response stand-in — broadcastStateEvent only ever calls
// `.write()` (and `.end()` on teardown), so forwarding those to the chunks
// array is enough for the assertions below.
function mockResponse(chunks: string[]): Response {
  return {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    end: () => {
      /* no-op */
    },
  } as unknown as Response;
}

// The FileWatcher keeps its listeners + `emit()` private, but the emit
// surface is exactly what tests like this need to simulate the "save
// happened on disk" branch without actually poking fs.watch. Cast once,
// narrow to the one method we call.
function emitWatcherEvent(ws: WorkspaceState, event: ExternalChangeEvent): void {
  (ws.watcher as unknown as { emit: (e: ExternalChangeEvent) => void }).emit(event);
}

// Same private-emit trick for the sibling LayoutFileWatcher: simulate the
// "opencode wrote .layout.json on disk" branch without poking fs.watch.
function emitLayoutEvent(ws: WorkspaceState, event: LayoutChangeEvent): void {
  (ws.layoutWatcher as unknown as { emit: (e: LayoutChangeEvent) => void }).emit(event);
}

// Register our own ws key under a unique, sandboxed value so concurrent
// tests (or repeated runs) don't collide on the registry map.
function uniqueKey(label: string): string {
  return `/tmp/__file_watcher_bridge_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('non-default workspace: external-change fires state_event SSE with reloaded config', () => {
  const key = uniqueKey('change');
  const ws = workspaceRegistry.getOrCreate(key);
  // Sanity: the registry genuinely created a fresh, non-default workspace
  // (and therefore must have run the onCreate hook). If this assertion
  // ever fails the hook registration has regressed.
  expect(ws.key).toBe(key);
  expect(ws.key).not.toBe(DEFAULT_WORKSPACE_KEY);
  expect(ws).not.toBe(S);

  const chunks: string[] = [];
  ws.stateEventClients.add({ res: mockResponse(chunks) });

  // Also wire a subscriber on the default workspace so we can assert the
  // bridge does NOT cross-contaminate S — external-change on `ws` must
  // only fan out to `ws.stateEventClients`.
  const defaultChunks: string[] = [];
  S.stateEventClients.add({ res: mockResponse(defaultChunks) });

  const reloadedConfig = createEmptyPipeline('Externally Edited');
  const content = serializePipeline(reloadedConfig);

  try {
    emitWatcherEvent(ws, {
      type: 'external-change',
      path: `${key}/.tagma/pipeline.yaml`,
      content,
    });

    expect(chunks.length).toBe(1);
    const sse = chunks[0]!;
    expect(sse).toContain('event: state_event');
    expect(sse).toContain('"type":"external-change"');
    expect(sse).toContain('"Externally Edited"');

    // The bridge also re-parses the YAML into `ws.config` so the next
    // /api/state serves the new contents — this is the "silent C5
    // detection never firing" half of Bug #1 that the review flagged.
    expect(ws.config.name).toBe('Externally Edited');

    // Cross-workspace isolation: the default workspace must be untouched.
    expect(defaultChunks.length).toBe(0);
  } finally {
    ws.stateEventClients.clear();
    S.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});

test('external YAML adoption refreshes optimistic save version', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-yaml-version-'));
  const tagmaDir = join(root, '.tagma', 'current');
  mkdirSync(tagmaDir, { recursive: true });
  const yamlPath = join(tagmaDir, 'current.yaml');
  const oldConfig = createEmptyPipeline('Old');
  const newConfig = createEmptyPipeline('New Pipeline');
  const oldContent = serializePipeline(oldConfig);
  const newContent = serializePipeline(newConfig);
  writeFileSync(yamlPath, oldContent, 'utf-8');

  const ws = workspaceRegistry.getOrCreate(root);
  ws.workDir = root;
  ws.yamlPath = yamlPath;
  ws.config = oldConfig;
  ws.yamlVersion = getFileVersion(yamlPath);
  const previousVersion = ws.yamlVersion;

  try {
    writeFileSync(yamlPath, newContent, 'utf-8');
    emitWatcherEvent(ws, {
      type: 'external-change',
      path: yamlPath,
      content: newContent,
    });

    expect(ws.config.name).toBe('New Pipeline');
    expect(ws.yamlVersion).toEqual(getFileVersion(yamlPath));
    expect(ws.yamlVersion?.size).not.toBe(previousVersion?.size);
  } finally {
    workspaceRegistry.drop(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-default workspace: external-conflict is forwarded verbatim', () => {
  const key = uniqueKey('conflict');
  const ws = workspaceRegistry.getOrCreate(key);

  const chunks: string[] = [];
  ws.stateEventClients.add({ res: mockResponse(chunks) });

  try {
    emitWatcherEvent(ws, {
      type: 'external-conflict',
      path: `${key}/.tagma/pipeline.yaml`,
    });

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain('"type":"external-conflict"');
    expect(chunks[0]).toContain(`${key}/.tagma/pipeline.yaml`);
  } finally {
    ws.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});

// Regression test for the "opencode chat updated layout.json but the canvas did not sync" bug.
// Before the fix: the FileWatcher only fired for the YAML, so external
// edits to the sibling .layout.json silently never reached loadLayout(ws)
// nor produced an SSE event — the canvas kept showing stale positions
// until the workspace was re-opened. The fix wires a dedicated
// LayoutFileWatcher per workspace and bridges it to broadcastStateEvent.
test('non-default workspace: external layout-only change fires state_event SSE with refreshed layout', () => {
  const key = uniqueKey('layout-change');
  const ws = workspaceRegistry.getOrCreate(key);
  expect(ws.key).toBe(key);
  expect(ws.key).not.toBe(DEFAULT_WORKSPACE_KEY);

  const chunks: string[] = [];
  ws.stateEventClients.add({ res: mockResponse(chunks) });

  const defaultChunks: string[] = [];
  S.stateEventClients.add({ res: mockResponse(defaultChunks) });

  // Stub yamlPath=null so loadLayout takes its "no layoutPath" branch and
  // resets ws.layout to {positions:{}} without needing a real file on disk.
  // The point of this test is the bridge wiring, not the disk roundtrip.
  ws.yamlPath = null;
  ws.layout = { positions: { 'stale.task': { x: 999 } } };
  const revisionBefore = ws.stateRevision;

  try {
    emitLayoutEvent(ws, {
      path: `${key}/.tagma/pipeline.layout.json`,
      content: '{"positions":{}}',
    });

    // SSE fanned out to this workspace's subscribers only.
    expect(chunks.length).toBe(1);
    const sse = chunks[0]!;
    expect(sse).toContain('event: state_event');
    expect(sse).toContain('"type":"external-change"');
    expect(sse).toContain(`${key}/.tagma/pipeline.layout.json`);

    // Revision was bumped so /api/state ETag clients refetch.
    expect(ws.stateRevision).toBe(revisionBefore + 1);

    // ws.layout was refreshed via loadLayout — the stale entry is gone.
    expect(ws.layout.positions['stale.task']).toBeUndefined();

    // Cross-workspace isolation.
    expect(defaultChunks.length).toBe(0);
  } finally {
    ws.stateEventClients.clear();
    S.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});

test('non-default workspace: external layout conflict is forwarded without replacing memory layout', () => {
  const key = uniqueKey('layout-conflict');
  const ws = workspaceRegistry.getOrCreate(key);
  const chunks: string[] = [];
  ws.stateEventClients.add({ res: mockResponse(chunks) });
  ws.yamlPath = null;
  ws.layout = { positions: { 'local.task': { x: 321 } } };
  const revisionBefore = ws.stateRevision;

  try {
    emitLayoutEvent(ws, {
      type: 'external-conflict',
      path: `${key}/.tagma/pipeline.layout.json`,
      content: '{"positions":{"disk.task":{"x":10}}}',
    } as unknown as LayoutChangeEvent);

    expect(chunks.length).toBe(1);
    const sse = chunks[0]!;
    expect(sse).toContain('"type":"external-conflict"');
    expect(sse).toContain(`${key}/.tagma/pipeline.layout.json`);
    expect(ws.stateRevision).toBe(revisionBefore);
    expect(ws.layout.positions['local.task']).toEqual({ x: 321 });
  } finally {
    ws.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});

test('layout reload seeds watcher baseline so the same disk content does not conflict again', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-layout-reload-'));
  const tagmaDir = join(root, '.tagma');
  mkdirSync(tagmaDir, { recursive: true });

  const ws = workspaceRegistry.getOrCreate(root);
  const config = {
    name: 'Reload Layout',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'task', name: 'Task', prompt: 'Say hi' }],
      },
    ],
  } satisfies WorkspaceState['config'];
  const yamlPath = join(tagmaDir, 'pipeline.yaml');
  const layoutPath = join(tagmaDir, 'pipeline.layout.json');
  const oldLayout = JSON.stringify({ positions: { 'main.task': { x: 1 } } }, null, 2);
  const newLayout = JSON.stringify({ positions: { 'main.task': { x: 2 } } }, null, 2);

  try {
    ws.workDir = root;
    ws.yamlPath = yamlPath;
    ws.config = config;
    ws.layout = { positions: { 'main.task': { x: 1 } } };
    ws.layoutWatcher.markSynced(oldLayout, 1);

    writeFileSync(yamlPath, serializePipeline(config), 'utf-8');
    writeFileSync(layoutPath, newLayout, 'utf-8');

    loadLayout(ws);
    expect(ws.layout.positions['main.task']).toEqual({ x: 2 });
    expect(ws.layoutWatcher.isServerDirty(JSON.stringify(ws.layout, null, 2))).toBe(true);

    syncLayoutWatcherFromDisk(ws);

    expect(ws.layoutWatcher.isServerDirty(JSON.stringify(ws.layout, null, 2))).toBe(false);
    expect(ws.layoutWatcher.currentlyWatching()).toBe(layoutPath);
  } finally {
    ws.layoutWatcher.stopWatching();
    workspaceRegistry.drop(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge is idempotent: re-creating an existing workspace does not double-subscribe', () => {
  const key = uniqueKey('idempotent');
  const ws1 = workspaceRegistry.getOrCreate(key);
  // Second `getOrCreate` returns the same instance — the onCreate hook
  // must not fire a second time, and the bridge's internal WeakSet guard
  // means attachFileWatcherBridge is a no-op even if something else tried
  // to re-attach. A broken guard would cause one synthetic event to fan
  // out N times to the same subscriber.
  const ws2 = workspaceRegistry.getOrCreate(key);
  expect(ws2).toBe(ws1);

  const chunks: string[] = [];
  ws1.stateEventClients.add({ res: mockResponse(chunks) });

  try {
    const content = serializePipeline(createEmptyPipeline('Idempotent'));
    emitWatcherEvent(ws1, {
      type: 'external-change',
      path: `${key}/.tagma/pipeline.yaml`,
      content,
    });
    expect(chunks.length).toBe(1);
  } finally {
    ws1.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});

test('non-default workspace: external YAML delete is forwarded as deleted conflict', () => {
  const key = uniqueKey('delete');
  const ws = workspaceRegistry.getOrCreate(key);
  const chunks: string[] = [];
  ws.stateEventClients.add({ res: mockResponse(chunks) });

  try {
    emitWatcherEvent(ws, {
      type: 'external-delete',
      path: `${key}/.tagma/pipeline/pipeline.yaml`,
    });

    expect(chunks.length).toBe(1);
    const sse = chunks[0]!;
    expect(sse).toContain('"type":"external-conflict"');
    expect(sse).toContain('"deleted":true');
    expect(sse).toContain(`${key}/.tagma/pipeline/pipeline.yaml`);
  } finally {
    ws.stateEventClients.clear();
    workspaceRegistry.drop(key);
  }
});
