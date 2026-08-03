import { describe, expect, test } from 'bun:test';

const APPROVAL_PROMPT = 'approve / reject > ';
const RESULT_PREFIX = '@@stdin-approval-result@@';
const CHILD_TIMEOUT_MS = 1_000;

const adapterUrl = new URL('./adapters/stdin-approval.ts', import.meta.url).href;

// The adapter intentionally owns process.stdin/process.stdout, so exercise it in
// a child Bun process instead of replacing those globals in the test runner.
const terminalRunner = `
import { attachStdinApprovalAdapter } from ${JSON.stringify(adapterUrl)};

class TerminalGateway {
  constructor() {
    this.pendingEntries = new Map();
    this.listeners = new Set();
  }

  request({ id, taskId, message, timeoutMs }) {
    const request = {
      id,
      createdAt: new Date().toISOString(),
      runId: 'terminal-journey',
      trackId: 'terminal',
      taskId,
      message,
      timeoutMs,
    };
    let settle;
    const decision = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = { request, settle, timer: null };
    this.pendingEntries.set(id, entry);
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => this.expire(id), timeoutMs);
    }
    this.emit({ type: 'requested', request });
    return {
      request,
      decision,
      abort: (reason) => this.abort(id, reason),
    };
  }

  resolve(id, decision) {
    const entry = this.pendingEntries.get(id);
    if (!entry) return false;
    this.pendingEntries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const fullDecision = {
      approvalId: id,
      outcome: decision.outcome,
      actor: decision.actor,
      reason: decision.reason,
      decidedAt: new Date().toISOString(),
    };
    this.emit({ type: 'resolved', request: entry.request, decision: fullDecision });
    entry.settle(fullDecision);
    return true;
  }

  pending() {
    return Array.from(this.pendingEntries.values(), (entry) => entry.request);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abortAll(reason) {
    for (const id of Array.from(this.pendingEntries.keys())) {
      this.abort(id, reason);
    }
  }

  abort(id, reason) {
    const entry = this.pendingEntries.get(id);
    if (!entry) return;
    this.pendingEntries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    this.emit({ type: 'aborted', request: entry.request, reason });
    entry.settle({
      approvalId: id,
      outcome: 'aborted',
      reason,
      decidedAt: new Date().toISOString(),
    });
  }

  expire(id) {
    const entry = this.pendingEntries.get(id);
    if (!entry) return;
    this.pendingEntries.delete(id);
    this.emit({ type: 'expired', request: entry.request });
    entry.settle({
      approvalId: id,
      outcome: 'timeout',
      reason: 'approval timed out',
      decidedAt: new Date().toISOString(),
    });
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function report(id, outcome) {
  process.stderr.write('${RESULT_PREFIX}' + id + ':' + outcome + '\\n');
}

function request(gateway, id, timeoutMs = 0) {
  return gateway.request({
    id,
    taskId: id,
    message: id + ' approval',
    timeoutMs,
  });
}

async function run() {
  const gateway = new TerminalGateway();
  const adapter = attachStdinApprovalAdapter(gateway);
  const scenario = process.env.TAGMA_STDIN_APPROVAL_SCENARIO;
  const first = request(gateway, 'first', scenario === 'timeout' ? 30 : 0);

  if (scenario === 'queued') {
    const second = request(gateway, 'second');
    const firstDecision = await first.decision;
    report('first', firstDecision.outcome);
    const secondDecision = await second.decision;
    report('second', secondDecision.outcome);
    adapter.detach();
    return;
  }

  if (scenario === 'aborted') {
    const second = request(gateway, 'second');
    setTimeout(() => first.abort('user cancelled the first request'), 30);
    const firstDecision = await first.decision;
    report('first', firstDecision.outcome);
    const secondDecision = await second.decision;
    report('second', secondDecision.outcome);
    adapter.detach();
    return;
  }

  if (scenario === 'timeout') {
    const second = request(gateway, 'second');
    const firstDecision = await first.decision;
    report('first', firstDecision.outcome);
    const secondDecision = await second.decision;
    report('second', secondDecision.outcome);
    adapter.detach();
    return;
  }

  if (scenario === 'detach') {
    setTimeout(() => {
      adapter.detach();
      request(gateway, 'second');
    }, 30);
    await pause(80);
    report('detach', 'complete');
    return;
  }

  const firstDecision = await first.decision;
  report('first', firstDecision.outcome);
  adapter.detach();
}

void run().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
`;

interface TerminalSession {
  readonly state: { stdout: string; stderr: string };
  readonly send: (input: string) => void;
  readonly closeInput: () => void;
  readonly waitForPrompt: (count?: number) => Promise<void>;
  readonly waitForResult: (id: string, outcome?: string) => Promise<void>;
  readonly waitForExit: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function occurrences(text: string, fragment: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = text.indexOf(fragment, start);
    if (index < 0) return count;
    count++;
    start = index + fragment.length;
  }
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  state: { stdout: string; stderr: string },
): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description}. stdout=${JSON.stringify(state.stdout)} stderr=${JSON.stringify(state.stderr)}`,
      );
    }
    await pause(5);
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      append(decoder.decode(value, { stream: true }));
    }
  } finally {
    append(decoder.decode());
    reader.releaseLock();
  }
}

function startTerminalSession(scenario: string): TerminalSession {
  const child = Bun.spawn([process.execPath, '--eval', terminalRunner], {
    cwd: process.cwd(),
    env: { ...process.env, TAGMA_STDIN_APPROVAL_SCENARIO: scenario },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdin = child.stdin as { write(input: string): unknown; end(): void };
  const stdout = child.stdout as ReadableStream<Uint8Array>;
  const stderr = child.stderr as ReadableStream<Uint8Array>;
  const state = { stdout: '', stderr: '' };
  const stdoutDrained = drain(stdout, (chunk) => {
    state.stdout += chunk;
  });
  const stderrDrained = drain(stderr, (chunk) => {
    state.stderr += chunk;
  });

  return {
    state,
    send: (input) => {
      stdin.write(input);
    },
    closeInput: () => {
      stdin.end();
    },
    waitForPrompt: (count = 1) =>
      waitFor(
        `${count} approval prompt${count === 1 ? '' : 's'}`,
        () => occurrences(state.stdout, APPROVAL_PROMPT) >= count,
        state,
      ),
    waitForResult: (id, outcome) =>
      waitFor(
        `result for ${id}${outcome ? ` (${outcome})` : ''}`,
        () =>
          state.stderr.includes(`${RESULT_PREFIX}${id}:${outcome === undefined ? '' : outcome}`),
        state,
      ),
    waitForExit: async () => {
      const exitCode = await child.exited;
      await Promise.all([stdoutDrained, stderrDrained]);
      if (exitCode !== 0) {
        throw new Error(
          `Terminal runner exited with ${exitCode}. stdout=${JSON.stringify(state.stdout)} stderr=${JSON.stringify(state.stderr)}`,
        );
      }
    },
    stop: async () => {
      try {
        stdin.end();
      } catch {
        // The child may already have closed its stdin pipe.
      }
      try {
        child.kill();
      } catch {
        // The child may already have exited normally.
      }
      await Promise.race([child.exited, pause(CHILD_TIMEOUT_MS)]);
      await Promise.allSettled([stdoutDrained, stderrDrained]);
    },
  };
}

describe('stdin approval adapter user journeys', () => {
  test('an operator can approve a pending request from the terminal', async () => {
    const terminal = startTerminalSession('approve');
    try {
      await terminal.waitForPrompt();
      terminal.send(' yes \n');
      await terminal.waitForResult('first', 'approved');
      await terminal.waitForExit();

      expect(terminal.state.stdout).toContain('[APPROVAL REQUIRED] first approval');
      expect(terminal.state.stdout).toContain('id:      first');
    } finally {
      await terminal.stop();
    }
  });

  test('an operator can reject a pending request from the terminal', async () => {
    const terminal = startTerminalSession('reject');
    try {
      await terminal.waitForPrompt();
      terminal.send('reject\n');
      await terminal.waitForResult('first', 'rejected');
      await terminal.waitForExit();
    } finally {
      await terminal.stop();
    }
  });

  test('unrecognized terminal input rejects rather than approving a request', async () => {
    const terminal = startTerminalSession('invalid');
    try {
      await terminal.waitForPrompt();
      terminal.send('perhaps\n');
      await terminal.waitForResult('first', 'rejected');
      await terminal.waitForExit();

      expect(terminal.state.stdout).toContain(
        'unrecognized input "perhaps" - treating as rejection',
      );
    } finally {
      await terminal.stop();
    }
  });

  test('two terminal approvals are presented and resolved in queue order', async () => {
    const terminal = startTerminalSession('queued');
    try {
      await terminal.waitForPrompt(1);
      terminal.send('approve\n');
      await terminal.waitForResult('first', 'approved');
      await terminal.waitForPrompt(2);
      terminal.send('no\n');
      await terminal.waitForResult('second', 'rejected');
      await terminal.waitForExit();

      expect(occurrences(terminal.state.stdout, APPROVAL_PROMPT)).toBe(2);
      expect(terminal.state.stdout.indexOf('first approval')).toBeLessThan(
        terminal.state.stdout.indexOf('second approval'),
      );
    } finally {
      await terminal.stop();
    }
  });

  test.failing(
    'advances to the queued request when the active terminal request is aborted',
    async () => {
      const terminal = startTerminalSession('aborted');
      try {
        await terminal.waitForPrompt(1);
        await terminal.waitForResult('first', 'aborted');
        await terminal.waitForPrompt(2);
        terminal.send('approve\n');
        await terminal.waitForResult('second', 'approved');
        await terminal.waitForExit();
      } finally {
        await terminal.stop();
      }
    },
  );

  test.failing(
    'advances to the queued request when the active terminal request expires',
    async () => {
      const terminal = startTerminalSession('timeout');
      try {
        await terminal.waitForPrompt(1);
        await terminal.waitForResult('first', 'timeout');
        await terminal.waitForPrompt(2);
        terminal.send('approve\n');
        await terminal.waitForResult('second', 'approved');
        await terminal.waitForExit();
      } finally {
        await terminal.stop();
      }
    },
  );

  test('detach prevents later approvals from opening another terminal prompt', async () => {
    const terminal = startTerminalSession('detach');
    try {
      await terminal.waitForPrompt();
      await terminal.waitForResult('detach', 'complete');
      await terminal.waitForExit();

      expect(occurrences(terminal.state.stdout, APPROVAL_PROMPT)).toBe(1);
    } finally {
      await terminal.stop();
    }
  });

  test.failing('EOF settles the active terminal request without leaving it pending', async () => {
    const terminal = startTerminalSession('eof');
    try {
      await terminal.waitForPrompt();
      terminal.closeInput();
      await terminal.waitForResult('first');
      await terminal.waitForExit();
    } finally {
      await terminal.stop();
    }
  });
});
