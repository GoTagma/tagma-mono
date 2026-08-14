/**
 * A single-consumer, bounded async event journal.
 *
 * The private execution broker must never let a renderer that is not reading
 * events retain an unbounded amount of child-process output. The runtime's
 * authoritative output files remain separate; this journal is only the live
 * event view.
 */
export class ExecutionEventJournal<T> implements AsyncIterable<T> {
  private readonly buffered: Array<{ readonly event: T; readonly bytes: number }> = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private bufferedBytes = 0;
  private closed = false;
  private iteratorClaimed = false;
  private dropped = 0;

  constructor(
    private readonly maxBufferedEvents = 1024,
    private readonly maxBufferedBytes = 1024 * 1024,
    private readonly eventBytes: (event: T) => number = () => 0,
  ) {
    if (!Number.isInteger(maxBufferedEvents) || maxBufferedEvents < 1) {
      throw new Error('Execution event buffer limit must be a positive integer.');
    }
    if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new Error('Execution event byte limit must be a positive integer.');
    }
  }

  publish(event: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    const bytes = this.eventBytes(event);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('Execution event size must be a non-negative safe integer.');
    }
    if (bytes > this.maxBufferedBytes) {
      this.dropped += 1;
      return;
    }
    while (
      this.buffered.length >= this.maxBufferedEvents ||
      this.bufferedBytes + bytes > this.maxBufferedBytes
    ) {
      const removed = this.buffered.shift();
      if (!removed) break;
      this.bufferedBytes -= removed.bytes;
      this.dropped += 1;
    }
    this.buffered.push({ event, bytes });
    this.bufferedBytes += bytes;
  }

  takeDroppedCount(): number {
    const count = this.dropped;
    this.dropped = 0;
    return count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorClaimed) {
      throw new Error('Execution events support exactly one consumer.');
    }
    this.iteratorClaimed = true;
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) {
      this.bufferedBytes -= buffered.bytes;
      return Promise.resolve({ value: buffered.event, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
