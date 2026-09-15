import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import type { AgentChatPublicGrant } from '../shared/agent-chat-control';

const metadata = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  origin: string;
  runRoot: string;
  artifacts: string;
};
const receiptFile = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as {
  receipt: { commandId: string; operationId: string | null };
};
if (!receiptFile.receipt.operationId)
  throw new Error('The command has not produced a Host operation yet.');
const operationId = receiptFile.receipt.operationId;
const instructions = readFileSync(join(metadata.runRoot, 'instructions.txt'), 'utf8');
const base = /Base URL: ([^\n]+)/.exec(instructions)?.[1]?.trim();
const token = /Authorization: Bearer ([^\n]+)/.exec(instructions)?.[1]?.trim();
if (base !== `${metadata.origin}/api/agent-chat/v1` || !token?.startsWith('ac1_'))
  throw new Error('Wrong isolated lab handoff.');
const fetch = createStreamingLoopbackFetch(base);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Control request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}
interface Operation {
  operationId: string;
  conversationId: string;
  phase: string;
  waitReason: string | null;
  terminalOutcome: string | null;
  createdAt: number;
}
interface Pending {
  kind: string;
  operationId: string;
  hostRequestId: string;
  state: string;
  content: { actionCode: string; resourceCode: string };
}
interface State {
  grants: AgentChatPublicGrant[];
  renderer: { view: { pendingInput?: Pending; error?: string } } | null;
}
interface Receipt {
  receipt: { status: string; result: unknown; host: { operation: Operation } | null };
}
const decisions: unknown[] = [];
const handled = new Set<string>();
let previous = '';
let finished = false;
const started = Date.now();
while (Date.now() - started < 5 * 60_000) {
  const receipt = await request<Receipt>(`/commands/${receiptFile.receipt.commandId}`);
  const state = await request<State>('/state');
  const operation = receipt.receipt.host?.operation;
  const fingerprint = JSON.stringify([
    operation?.phase,
    operation?.waitReason,
    operation?.terminalOutcome,
  ]);
  if (fingerprint !== previous) {
    console.log(fingerprint);
    previous = fingerprint;
  }
  if (operation?.phase === 'terminal' || operation?.waitReason === 'user_retry') {
    finished = true;
    writeFileSync(
      join(metadata.artifacts, `${operationId}-result.json`),
      JSON.stringify({ receipt, state, decisions }, null, 2),
    );
    console.log(
      JSON.stringify({
        operationId,
        outcome: operation.terminalOutcome,
        waitReason: operation.waitReason,
        decisions: decisions.length,
      }),
    );
    process.exitCode =
      operation.terminalOutcome === 'completed_published' ||
      operation.terminalOutcome === 'completed_readonly'
        ? 0
        : 1;
    break;
  }
  const pending = state.renderer?.view.pendingInput;
  if (pending?.operationId === operationId && !handled.has(pending.hostRequestId)) {
    if (
      pending.kind !== 'permission' ||
      pending.state !== 'live_pending' ||
      pending.content.resourceCode !== 'staged_files' ||
      !['read', 'write', 'edit'].includes(pending.content.actionCode)
    ) {
      console.log(JSON.stringify({ needsDecision: pending, operationId }));
      process.exitCode = 2;
      finished = true;
      break;
    }
    const grant = state.grants.find(
      (item) => item.conversationId === operation?.conversationId && item.status === 'active',
    );
    if (!grant) throw new Error('The target conversation grant is unavailable.');
    const command = {
      requestId: `watch-${pending.hostRequestId}`,
      conversationId: grant.conversationId,
      grantVersion: grant.version,
      type: 'permission.reply',
      parameters: { operationId, requestId: pending.hostRequestId, choice: 'once' },
    };
    const reply = await request<{ receipt: { commandId: string } }>('/commands', command);
    handled.add(pending.hostRequestId);
    decisions.push({ command, commandId: reply.receipt.commandId });
    console.log(
      JSON.stringify({
        permission: pending.content.actionCode,
        reply: 'once',
        commandId: reply.receipt.commandId,
      }),
    );
  }
  await Bun.sleep(750);
}
if (!finished) {
  const state = await request<State>('/state');
  const receipt = await request<Receipt>(`/commands/${receiptFile.receipt.commandId}`);
  writeFileSync(
    join(metadata.artifacts, `${operationId}-timeout.json`),
    JSON.stringify({ receipt, state, decisions }, null, 2),
  );
  console.error(
    JSON.stringify({
      operationId,
      timeout: true,
      message: 'Five-minute observation limit reached; the Host operation may still be running.',
    }),
  );
  process.exitCode = 3;
}
