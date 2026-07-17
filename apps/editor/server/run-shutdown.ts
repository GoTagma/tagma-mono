import type { WorkspaceState } from './workspace-state.js';

interface AbortableRunSession {
  abort?: { abort: () => void };
}

export function shutdownRunForWorkspace(ws: WorkspaceState): void {
  const sessions = ws.runSessions as Map<string, AbortableRunSession>;
  const workflowSession = ws.workflowRunSession as AbortableRunSession | null;
  for (const live of sessions.values()) {
    try {
      live.abort?.abort();
    } catch {
      /* best-effort */
    }
  }
  try {
    workflowSession?.abort?.abort();
  } catch {
    /* best-effort */
  }
  try {
    ws.chatPipelineTrialAbort?.abort('workspace shutdown');
  } catch {
    /* best-effort */
  }
  ws.chatPipelineTrialAbort = null;
  ws.runSessions.clear();
  ws.workflowRunSession = null;
  ws.runSessionStarting = false;
  ws.runSessionStartToken = null;
  for (const client of ws.runSseClients) {
    try {
      client.end();
    } catch {
      /* best-effort */
    }
  }
  ws.runSseClients.clear();
  for (const client of ws.workflowSseClients) {
    try {
      client.end();
    } catch {
      /* best-effort */
    }
  }
  ws.workflowSseClients.clear();
}
