import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRegistry } from '../server/workspace-registry';
import { shutdownRunForWorkspace } from '../server/run-shutdown';

test('workspace drop releases watchers, SSE clients, run session, and plugin workers', () => {
  const key = mkdtempSync(join(tmpdir(), 'workspace-drop-'));
  const ws = workspaceRegistry.getOrCreate(key);

  let yamlWatcherStops = 0;
  let layoutWatcherStops = 0;
  let stateSseEnds = 0;
  let runSseEnds = 0;
  let workflowSseEnds = 0;
  let runAborts = 0;
  let workflowAborts = 0;
  let workerTerminates = 0;

  ws.watcher.stopWatching = () => {
    yamlWatcherStops += 1;
  };
  ws.layoutWatcher.stopWatching = () => {
    layoutWatcherStops += 1;
  };
  ws.stateEventClients.add({
    res: {
      end: () => {
        stateSseEnds += 1;
      },
    } as never,
  });
  ws.runSseClients.add({
    end: () => {
      runSseEnds += 1;
    },
  } as never);
  ws.workflowSseClients.add({
    end: () => {
      workflowSseEnds += 1;
    },
  } as never);
  ws.runSessions.set('run_test', {
    abort: {
      abort: () => {
        runAborts += 1;
      },
    },
  });
  ws.workflowRunSession = {
    abort: {
      abort: () => {
        workflowAborts += 1;
      },
    },
  };
  ws.runSessionStarting = true;
  ws.loadedPluginMeta.set('@tagma/driver-test', {
    registrations: [{ category: 'drivers', type: 'test' }],
    worker: {
      plugin: null as never,
      terminate: () => {
        workerTerminates += 1;
      },
    },
  });
  ws.pluginCapabilityOwners.set('drivers/test', '@tagma/driver-test');

  try {
    expect(workspaceRegistry.drop(key)).toBe(true);

    expect(yamlWatcherStops).toBe(1);
    expect(layoutWatcherStops).toBe(1);
    expect(stateSseEnds).toBe(1);
    expect(runSseEnds).toBe(1);
    expect(workflowSseEnds).toBe(1);
    expect(runAborts).toBe(1);
    expect(workflowAborts).toBe(1);
    expect(workerTerminates).toBe(1);
    expect(ws.stateEventClients.size).toBe(0);
    expect(ws.runSseClients.size).toBe(0);
    expect(ws.workflowSseClients.size).toBe(0);
    expect(ws.runSessions.size).toBe(0);
    expect(ws.workflowRunSession).toBe(null);
    expect(ws.runSessionStarting).toBe(false);
    expect(ws.loadedPluginMeta.size).toBe(0);
    expect(ws.pluginCapabilityOwners.size).toBe(0);
    expect(workspaceRegistry.get(key)).toBeUndefined();
  } finally {
    workspaceRegistry.drop(key);
    rmSync(key, { recursive: true, force: true });
  }
});

test('shutdownRunForWorkspace aborts a live run and closes run SSE clients', () => {
  const key = mkdtempSync(join(tmpdir(), 'workspace-run-shutdown-'));
  const ws = workspaceRegistry.getOrCreate(key);

  let runAborts = 0;
  let runSseEnds = 0;
  let workflowAborts = 0;
  let chatTrialAborts = 0;
  let workflowSseEnds = 0;
  ws.runSessions.set('run_test', {
    abort: {
      abort: () => {
        runAborts += 1;
      },
    },
  });
  ws.workflowRunSession = {
    abort: {
      abort: () => {
        workflowAborts += 1;
      },
    },
  };
  const chatTrialAbort = new AbortController();
  chatTrialAbort.signal.addEventListener('abort', () => {
    chatTrialAborts += 1;
  });
  ws.chatPipelineTrialAbort = chatTrialAbort;
  ws.runSessionStarting = true;
  ws.runSseClients.add({
    end: () => {
      runSseEnds += 1;
    },
  } as never);
  ws.workflowSseClients.add({
    end: () => {
      workflowSseEnds += 1;
    },
  } as never);

  try {
    shutdownRunForWorkspace(ws);

    expect(runAborts).toBe(1);
    expect(runSseEnds).toBe(1);
    expect(workflowAborts).toBe(1);
    expect(chatTrialAborts).toBe(1);
    expect(workflowSseEnds).toBe(1);
    expect(ws.runSessions.size).toBe(0);
    expect(ws.workflowRunSession).toBe(null);
    expect(ws.chatPipelineTrialAbort).toBeNull();
    expect(ws.runSessionStarting).toBe(false);
    expect(ws.runSseClients.size).toBe(0);
    expect(ws.workflowSseClients.size).toBe(0);
  } finally {
    workspaceRegistry.drop(key);
    rmSync(key, { recursive: true, force: true });
  }
});
