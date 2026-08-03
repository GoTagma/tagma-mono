import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeWorkspaceKey } from '../server/workspace-registry.js';

const editorRoot = join(import.meta.dir, '..');
const compiledSidecarBin = process.env.TAGMA_DIAGNOSTICS_SIDECAR_BIN?.trim();

interface SseEvent {
  readonly id: string | null;
  readonly event: string | null;
  readonly data: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSseFrame(frame: string): SseEvent | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'id') id = value;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  const rawData = data.join('\n');
  try {
    return { id, event, data: JSON.parse(rawData) };
  } catch {
    return { id, event, data: rawData };
  }
}

async function waitForReady(proc: ReturnType<typeof Bun.spawn>, output: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(`Sidecar readiness timed out.\n${output.join('')}`));
    }, 20_000);

    const drain = async (stream: ReadableStream<Uint8Array>, inspectReady: boolean) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output.push(text);
        if (!inspectReady || settled) continue;
        carry += text;
        const match = carry.match(/TAGMA_READY port=(\d+)/);
        if (match) {
          settled = true;
          clearTimeout(timeout);
          resolve(Number(match[1]));
        } else if (carry.length > 8_192) {
          carry = carry.slice(-4_096);
        }
      }
      if (inspectReady && !settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited before readiness.\n${output.join('')}`));
      }
    };

    void drain(proc.stdout as ReadableStream<Uint8Array>, true);
    void drain(proc.stderr as ReadableStream<Uint8Array>, false);
  });
}

async function readSseEvent(
  response: Response,
  controller: AbortController,
  predicate: (event: SseEvent) => boolean,
  timeoutMs = 12_000,
): Promise<SseEvent> {
  if (!response.body) throw new Error('SSE response did not include a body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream closed before the expected run event arrived');
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (;;) {
        const frameEnd = buffered.indexOf('\n\n');
        if (frameEnd < 0) break;
        const frame = buffered.slice(0, frameEnd);
        buffered = buffered.slice(frameEnd + 2);
        const event = parseSseFrame(frame);
        if (event && predicate(event)) return event;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out waiting for the expected run SSE event after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

function runSequence(event: SseEvent, runId: string): number {
  const prefix = `${runId}:`;
  if (!event.id?.startsWith(prefix)) {
    throw new Error(`Expected an SSE id for ${runId}, got ${JSON.stringify(event.id)}`);
  }
  const seq = Number(event.id.slice(prefix.length));
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`Expected a numeric SSE sequence, got ${JSON.stringify(event.id)}`);
  }
  return seq;
}

async function waitForHistoryEntry(
  origin: string,
  headers: Record<string, string>,
  runId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 12_000;
  let lastFailure = 'history did not list the run';
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/run/history`, { headers });
    if (response.ok) {
      const payload = await response.json();
      const records = asRecord(payload);
      const runs = Array.isArray(records?.runs) ? records.runs : [];
      const entry = runs.map(asRecord).find((run) => run?.runId === runId);
      if (entry) return entry;
      lastFailure = `run ${runId} was not present in ${JSON.stringify(payload)}`;
    } else {
      lastFailure = `${response.status}: ${await response.text()}`;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for persisted run history: ${lastFailure}`);
}

test('a user can run a selected workspace pipeline and reconnect to its live SSE stream', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-user-run-sse-e2e-'));
  const workspace = join(tempRoot, 'workspace');
  const globalSettingsDir = join(tempRoot, 'global-settings');
  const pipelineDir = join(workspace, '.tagma', 'journey');
  const workflowDir = join(workspace, '.tagma', 'workflows');
  const yamlPath = join(pipelineDir, 'journey.yaml');
  const workflowPath = join(workflowDir, 'journey.workflow.yaml');
  mkdirSync(pipelineDir, { recursive: true });
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(globalSettingsDir, { recursive: true });
  writeFileSync(
    yamlPath,
    `pipeline:
  name: Sidecar SSE journey
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: >-
            bun -e "console.log('user-sse-begin'); await new Promise((resolve) => setTimeout(resolve, 800)); console.log('user-sse-terminal')"
`,
  );
  writeFileSync(
    workflowPath,
    `workflow:
  name: Sidecar workflow SSE journey
  pipelines:
    - id: journey
      path: .tagma/journey/journey.yaml
`,
  );

  const output: string[] = [];
  const managementToken = 'management-token-for-user-run-sse-e2e';
  const sidecarCommand = compiledSidecarBin
    ? [compiledSidecarBin]
    : [process.execPath, join(editorRoot, 'server/index.ts')];
  const proc = Bun.spawn(sidecarCommand, {
    cwd: editorRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      TAGMA_AUTH_TOKEN: managementToken,
      TAGMA_GLOBAL_SETTINGS_DIR: globalSettingsDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let origin: string | null = null;
  let initialSseController: AbortController | null = null;
  let reconnectSseController: AbortController | null = null;
  let stateSseController: AbortController | null = null;
  let workflowSseController: AbortController | null = null;

  try {
    const port = await waitForReady(proc, output);
    origin = `http://127.0.0.1:${port}`;
    const authHeaders = {
      Authorization: `Bearer ${managementToken}`,
      'Content-Type': 'application/json',
    };

    // This is the same two-step workspace-selection flow used by a newly
    // opened editor window: select the workspace first, then bind its normal
    // X-Tagma-Workspace header for workspace-scoped requests.
    const selectResponse = await fetch(`${origin}/api/workspace`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ workDir: workspace }),
    });
    expect(selectResponse.status).toBe(200);
    expect(await selectResponse.json()).toMatchObject({
      workDir: normalizeWorkspaceKey(workspace),
    });

    const workspaceHeaders = {
      ...authHeaders,
      'X-Tagma-Workspace': workspace,
    };

    const missingWorkflowAuthResponse = await fetch(
      `${origin}/api/run/workflow/events?ws=${encodeURIComponent(workspace)}`,
    );
    expect(missingWorkflowAuthResponse.status).toBe(401);
    expect(await missingWorkflowAuthResponse.json()).toMatchObject({
      error: expect.stringContaining('Missing Authorization'),
    });

    const invalidWorkflowAuthResponse = await fetch(
      `${origin}/api/run/workflow/events?ws=${encodeURIComponent(workspace)}&auth=wrong-token`,
    );
    expect(invalidWorkflowAuthResponse.status).toBe(401);
    expect(await invalidWorkflowAuthResponse.json()).toEqual({ error: 'Invalid auth token' });

    const openResponse = await fetch(`${origin}/api/open`, {
      method: 'POST',
      headers: workspaceHeaders,
      body: JSON.stringify({ path: yamlPath }),
    });
    expect(openResponse.status).toBe(200);
    expect(await openResponse.json()).toMatchObject({
      workDir: normalizeWorkspaceKey(workspace),
    });
    const opened = await fetch(`${origin}/api/state`, { headers: workspaceHeaders });
    expect(opened.status).toBe(200);
    const openedState = asRecord(await opened.json());
    expect(String(openedState?.yamlPath).toLowerCase()).toBe(
      normalizeWorkspaceKey(yamlPath).toLowerCase(),
    );

    // EventSource cannot set Authorization, so the state stream exercises the
    // production same-origin cookie fallback and its initial state_sync event.
    stateSseController = new AbortController();
    const stateSseResponse = await fetch(
      `${origin}/api/state/events?ws=${encodeURIComponent(workspace)}`,
      {
        headers: { Cookie: `tagma_auth=${managementToken}` },
        signal: stateSseController.signal,
      },
    );
    expect(stateSseResponse.status).toBe(200);
    const stateEvent = await readSseEvent(
      stateSseResponse,
      stateSseController,
      (event) => event.event === 'state_event' && asRecord(event.data)?.type === 'state_sync',
    );
    expect(asRecord(stateEvent.data)?.newState).toMatchObject({
      workDir: normalizeWorkspaceKey(workspace),
    });

    // Browser EventSource cannot set headers. Exercise the production query
    // fallback for both authentication and workspace binding, then reconnect
    // with the standard Last-Event-ID cursor.
    const eventsUrl =
      `${origin}/api/run/events?ws=${encodeURIComponent(workspace)}` +
      `&auth=${encodeURIComponent(managementToken)}`;
    initialSseController = new AbortController();
    const initialSseResponse = await fetch(eventsUrl, { signal: initialSseController.signal });
    expect(initialSseResponse.status).toBe(200);

    const startResponse = await fetch(`${origin}/api/run/start`, {
      method: 'POST',
      headers: workspaceHeaders,
      body: JSON.stringify({ yamlPath }),
    });
    expect(startResponse.status).toBe(200);
    const started = asRecord(await startResponse.json());
    expect(started?.ok).toBe(true);
    const runId = started?.runId;
    if (typeof runId !== 'string') {
      throw new Error(`Run start did not return a runId: ${JSON.stringify(started)}`);
    }

    const initialEvent = await readSseEvent(initialSseResponse, initialSseController, (event) => {
      const data = asRecord(event.data);
      return (
        event.event === 'run_event' &&
        data?.runId === runId &&
        data.type !== 'run_end' &&
        data.type !== 'run_error'
      );
    });
    const initialSequence = runSequence(initialEvent, runId);

    reconnectSseController = new AbortController();
    const reconnectSseResponse = await fetch(eventsUrl, {
      headers: { 'Last-Event-ID': initialEvent.id ?? '' },
      signal: reconnectSseController.signal,
    });
    expect(reconnectSseResponse.status).toBe(200);
    const terminalEvent = await readSseEvent(
      reconnectSseResponse,
      reconnectSseController,
      (event) => {
        const data = asRecord(event.data);
        return (
          event.event === 'run_event' &&
          data?.runId === runId &&
          (data.type === 'run_end' || data.type === 'run_error')
        );
      },
    );
    expect(asRecord(terminalEvent.data)).toMatchObject({
      type: 'run_end',
      runId,
      success: true,
      abortReason: null,
    });
    expect(runSequence(terminalEvent, runId)).toBeGreaterThan(initialSequence);

    const historyEntry = await waitForHistoryEntry(origin, workspaceHeaders, runId);
    expect(historyEntry).toMatchObject({ runId });

    const summaryResponse = await fetch(`${origin}/api/run/history/${runId}/summary`, {
      headers: workspaceHeaders,
    });
    expect(summaryResponse.status).toBe(200);
    expect(JSON.stringify(await summaryResponse.json())).toContain(runId);

    const taskOutputResponse = await fetch(
      `${origin}/api/run/history/${runId}/task-output?taskId=main.task&stream=stdout`,
      { headers: workspaceHeaders },
    );
    expect(taskOutputResponse.status).toBe(200);
    const taskOutput = asRecord(await taskOutputResponse.json());
    expect(taskOutput?.content).toContain('user-sse-terminal');

    const pollingFallbackResponse = await fetch(`${origin}/api/state/reload`, {
      method: 'POST',
      headers: workspaceHeaders,
    });
    expect(pollingFallbackResponse.status).toBe(200);
    expect(await pollingFallbackResponse.json()).toMatchObject({
      workDir: normalizeWorkspaceKey(workspace),
    });

    // The workflow stream is a separate EventSource endpoint. Authenticate it
    // with the normal Bearer path, then verify a real graph event reaches the
    // already-open stream after the live workflow starts.
    workflowSseController = new AbortController();
    const workflowSseResponse = await fetch(
      `${origin}/api/run/workflow/events?ws=${encodeURIComponent(workspace)}`,
      {
        headers: { Authorization: `Bearer ${managementToken}` },
        signal: workflowSseController.signal,
      },
    );
    expect(workflowSseResponse.status).toBe(200);

    const workflowStartResponse = await fetch(`${origin}/api/run/workflow/start`, {
      method: 'POST',
      headers: workspaceHeaders,
      body: JSON.stringify({ path: workflowPath, live: true }),
    });
    expect(workflowStartResponse.status).toBe(200);
    const workflowStarted = asRecord(await workflowStartResponse.json());
    const graphRunId = workflowStarted?.graphRunId;
    if (typeof graphRunId !== 'string') {
      throw new Error(`Workflow start did not return a graphRunId: ${JSON.stringify(workflowStarted)}`);
    }
    const workflowEvent = await readSseEvent(
      workflowSseResponse,
      workflowSseController,
      (event) => {
        const data = asRecord(event.data);
        return event.event === 'workflow_event' && data?.graphRunId === graphRunId;
      },
    );
    expect(asRecord(workflowEvent.data)).toMatchObject({
      type: 'graph_start',
      graphRunId,
      workflowName: 'Sidecar workflow SSE journey',
    });

    // Credentials must never be reflected in server output, even when the
    // middleware rejects a request.
    expect(output.join('')).not.toContain(managementToken);
  } finally {
    initialSseController?.abort();
    reconnectSseController?.abort();
    stateSseController?.abort();
    workflowSseController?.abort();
    if (origin) {
      await fetch(`${origin}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managementToken}` },
        signal: AbortSignal.timeout(1_500),
      }).catch(() => undefined);
    }
    const exitedCleanly = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    if (!exitedCleanly) proc.kill();
    await proc.exited;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 45_000);
