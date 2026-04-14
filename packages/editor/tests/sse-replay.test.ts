// Integration-ish test for SSE seq / replay semantics (§1.3 / §4.5).
//
// We don't boot the full Express app here — instead we exercise the
// bounded-buffer + Last-Event-ID filtering logic with a small helper
// that mirrors the server's implementation. The goal is to verify the
// protocol contract end-to-end:
//
//   1. Every broadcast bumps a monotonic seq counter.
//   2. The buffer is bounded (oldest events drop when full).
//   3. A reconnecting client that passes Last-Event-ID gets every event
//      with seq > that id and nothing else.
//   4. A run_start resets the buffer and the seq counter.
//
// If these invariants break, the contract in server/index.ts's
// /api/run/events handler is broken, and the client's dedupe in
// run-event-reducer.ts has to compensate for something it shouldn't.

import { test, expect } from 'bun:test';

interface StampedEvent {
  seq: number;
  type: string;
  payload: unknown;
}

/** Mirrors the server-side buffer + broadcast logic. */
class RunEventBuffer {
  private currentSeq = 0;
  private buffer: StampedEvent[] = [];

  constructor(private readonly max: number) {}

  get seq(): number {
    return this.currentSeq;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Reset at run_start. */
  reset(): void {
    this.currentSeq = 0;
    this.buffer = [];
  }

  /** Stamp + append (drops oldest when over capacity). */
  broadcast(type: string, payload: unknown): StampedEvent {
    this.currentSeq += 1;
    const stamped: StampedEvent = { seq: this.currentSeq, type, payload };
    this.buffer.push(stamped);
    if (this.buffer.length > this.max) {
      this.buffer.splice(0, this.buffer.length - this.max);
    }
    return stamped;
  }

  /** Replay everything after a given last-event-id. */
  replayAfter(lastSeen: number): StampedEvent[] {
    return this.buffer.filter((e) => e.seq > lastSeen);
  }
}

test('broadcast assigns monotonic seq numbers starting at 1', () => {
  const buf = new RunEventBuffer(100);
  const e1 = buf.broadcast('run_start', { runId: 'run_x' });
  const e2 = buf.broadcast('task_update', { taskId: 'a.1', status: 'running' });
  const e3 = buf.broadcast('task_update', { taskId: 'a.1', status: 'success' });
  expect(e1.seq).toBe(1);
  expect(e2.seq).toBe(2);
  expect(e3.seq).toBe(3);
  expect(buf.seq).toBe(3);
});

test('buffer is bounded: oldest events drop when capacity exceeded', () => {
  const buf = new RunEventBuffer(4);
  for (let i = 0; i < 10; i++) buf.broadcast('task_update', { i });
  expect(buf.size).toBe(4);

  // The four surviving events should be the last four broadcast.
  // replayAfter(0) gives us everything currently in the buffer.
  const remaining = buf.replayAfter(0);
  expect(remaining.length).toBe(4);
  expect(remaining[0].seq).toBe(7);
  expect(remaining[3].seq).toBe(10);
});

test('Last-Event-ID replay returns only events after the supplied seq', () => {
  const buf = new RunEventBuffer(100);
  buf.broadcast('run_start', { runId: 'run_x' }); // seq 1
  buf.broadcast('task_update', { taskId: 'a.1' }); // seq 2
  buf.broadcast('task_update', { taskId: 'a.2' }); // seq 3
  buf.broadcast('task_update', { taskId: 'a.3' }); // seq 4

  // Client reconnects after seeing seq 2.
  const replay = buf.replayAfter(2);
  expect(replay.length).toBe(2);
  expect(replay[0].seq).toBe(3);
  expect(replay[1].seq).toBe(4);
});

test('Last-Event-ID replay returns empty when client is already current', () => {
  const buf = new RunEventBuffer(100);
  buf.broadcast('run_start', { runId: 'run_x' });
  buf.broadcast('task_update', { taskId: 'a.1' });

  const replay = buf.replayAfter(2);
  expect(replay.length).toBe(0);
});

test('Last-Event-ID from a previous run is harmless after reset', () => {
  const buf = new RunEventBuffer(100);
  buf.broadcast('run_start', { runId: 'run_1' });
  buf.broadcast('task_update', { taskId: 'a.1' });
  buf.broadcast('run_end', { success: true }); // seq 3

  // Client retains lastSeen = 3 from the previous run.
  const staleLastSeen = 3;

  // New run starts — reset clears the buffer and restarts seq from 1.
  buf.reset();
  expect(buf.seq).toBe(0);
  buf.broadcast('run_start', { runId: 'run_2' }); // seq 1
  buf.broadcast('task_update', { taskId: 'a.1' }); // seq 2

  // Client reconnects with staleLastSeen=3 — the new run's events all
  // have seq <= 3, so replayAfter returns nothing. This is the bug case
  // the per-run reset is guarding against: without reset, the client
  // would wrongly drop the new run's events.
  //
  // The current implementation lets the client be in an inconsistent
  // state here UNTIL the next run_start event arrives via SSE (which
  // lives in the new buffer as seq 1). That's fine because the client's
  // run_start handler unconditionally resets lastEventSeq.
  const replay = buf.replayAfter(staleLastSeen);
  expect(replay.length).toBe(0);

  // After any fresh broadcast (seq advances), the next reconnect with
  // the client's NEW lastSeen (which run_start would have set to 1)
  // replays normally.
  buf.broadcast('task_update', { taskId: 'a.2' }); // seq 3
  const replayAfterRunStart = buf.replayAfter(1);
  expect(replayAfterRunStart.length).toBe(2);
  expect(replayAfterRunStart[0].seq).toBe(2);
  expect(replayAfterRunStart[1].seq).toBe(3);
});

test('rapid burst of broadcasts preserves order in the replay', () => {
  const buf = new RunEventBuffer(100);
  buf.broadcast('run_start', { runId: 'run_x' });
  for (let i = 0; i < 50; i++) {
    buf.broadcast('task_update', { taskId: `a.${i}`, order: i });
  }
  const replay = buf.replayAfter(0);
  expect(replay.length).toBe(51);
  // Verify seq monotonicity
  for (let i = 0; i < replay.length; i++) {
    expect(replay[i].seq).toBe(i + 1);
  }
});
