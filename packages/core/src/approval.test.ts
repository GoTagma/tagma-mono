import { describe, expect, test } from 'bun:test';
import { InMemoryApprovalGateway, scopeApprovalGateway } from './approval';

describe('InMemoryApprovalGateway run scoping', () => {
  test('scoped abort only resolves approvals for the current run', async () => {
    const root = new InMemoryApprovalGateway();
    const runA = scopeApprovalGateway(root, 'run_a');
    const runB = scopeApprovalGateway(root, 'run_b');

    const a = runA.request({
      taskId: 't.a',
      message: 'approve a',
      timeoutMs: 0,
    });
    const b = runB.request({
      taskId: 't.b',
      message: 'approve b',
      timeoutMs: 0,
    });

    runA.abortAll('run a finished');

    await expect(a.decision).resolves.toMatchObject({ outcome: 'aborted' });
    expect(root.pending().map((request) => request.id)).toEqual([b.request.id]);
    expect(runA.pending()).toEqual([]);
    expect(runB.pending()).toEqual([b.request]);

    b.abort('cleanup');
    await expect(b.decision).resolves.toMatchObject({ outcome: 'aborted' });
  });

  test('scoped subscriptions ignore approval events from other runs', () => {
    const root = new InMemoryApprovalGateway();
    const runA = scopeApprovalGateway(root, 'run_a');
    const runB = scopeApprovalGateway(root, 'run_b');
    const seen: string[] = [];

    const unsubscribe = runA.subscribe((event) => {
      seen.push(`${event.type}:${event.request.taskId}`);
    });

    runB.request({ taskId: 't.b', message: 'approve b', timeoutMs: 0 });
    const a = runA.request({ taskId: 't.a', message: 'approve a', timeoutMs: 0 });

    unsubscribe();
    a.abort('cleanup');
    root.abortAll('cleanup');

    expect(seen).toEqual(['requested:t.a']);
  });
});
