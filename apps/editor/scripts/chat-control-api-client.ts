import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { parseAgentChatCommand } from '../shared/agent-chat-control';
import type { AgentChatPublicGrant, AgentChatRendererReport } from '../shared/agent-chat-control';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}
interface Receipt {
  commandId: string;
  status: string;
  operationId: string | null;
  result: unknown;
  host?: { operation?: { phase?: string; terminalOutcome?: string | null } };
}
interface State {
  grants: AgentChatPublicGrant[];
  controllerVersion: number;
  readiness: string;
  connection: unknown;
  renderer: AgentChatRendererReport | null;
  host: unknown;
}

// A lab agent client: it obtains its authority solely from the copied product instructions.
const metadata = readJson(process.argv[2]!) as {
  origin: string;
  runRoot: string;
  workspace: string;
  artifacts: string;
};
const instructions = readFileSync(join(metadata.runRoot, 'instructions.txt'), 'utf8');
const base = /Base URL: ([^\n]+)/.exec(instructions)?.[1]?.trim();
const token = /Authorization: Bearer ([^\n]+)/.exec(instructions)?.[1]?.trim();
if (base !== `${metadata.origin}/api/agent-chat/v1` || !token?.startsWith('ac1_'))
  throw new Error('The handoff does not match this isolated lab.');
const fetch = createStreamingLoopbackFetch(base);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `Chat Control HTTP ${response.status}: ${String(value.kind ?? value.error ?? 'unknown')}`,
    );
  return value;
}
const state = (await request('/state')) as unknown as State;
if (process.argv[3]) {
  const spec = readJson(process.argv[3]) as Record<string, unknown>;
  const grants = state.grants.filter((grant: { status: string }) => grant.status === 'active');
  const conversationId =
    spec.type === 'conversation.create'
      ? null
      : (spec.conversationId ?? (grants.length === 1 ? grants[0].conversationId : null));
  const grant = grants.find(
    (item: { conversationId: string }) => item.conversationId === conversationId,
  );
  const command = parseAgentChatCommand({
    requestId: spec.requestId,
    conversationId,
    grantVersion:
      spec.grantVersion ??
      (spec.type === 'conversation.create' ? state.controllerVersion : grant?.version),
    type: spec.type,
    parameters: spec.parameters ?? {},
  });
  const submitted = await request('/commands', command);
  let receipt = submitted.receipt as Receipt;
  for (
    let attempt = 0;
    attempt < 75 && ['accepted', 'executing'].includes(receipt.status);
    attempt++
  ) {
    await Bun.sleep(200);
    receipt = (await request(`/commands/${receipt.commandId}`)).receipt as Receipt;
  }
  const directory = join(metadata.artifacts, 'commands');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${encodeURIComponent(command.requestId)}.json`),
    JSON.stringify({ command, receipt }, null, 2),
  );
  console.log(
    JSON.stringify({
      requestId: command.requestId,
      commandId: receipt.commandId,
      status: receipt.status,
      operationId: receipt.operationId,
      result: receipt.result,
      hostPhase: receipt.host?.operation?.phase,
      hostOutcome: receipt.host?.operation?.terminalOutcome,
    }),
  );
} else {
  const view = state.renderer?.view;
  writeFileSync(join(metadata.artifacts, 'latest-state.json'), JSON.stringify(state, null, 2));
  const host = state.host as {
    operation?: unknown;
    result?: { messages?: Array<{ text: string }> };
  } | null;
  console.log(
    JSON.stringify({
      readiness: state.readiness,
      connection: state.connection,
      grants: state.grants,
      renderer: view
        ? {
            model: view.model,
            sending: view.sending,
            operation: view.projection,
            surface: view.surface,
            pendingInput: view.pendingInput,
            error: view.error,
            composer: view.composer,
          }
        : null,
      host: host
        ? {
            operation: host.operation,
            messages: host.result?.messages?.map((message) => message.text.slice(0, 1600)),
          }
        : null,
    }),
  );
}
