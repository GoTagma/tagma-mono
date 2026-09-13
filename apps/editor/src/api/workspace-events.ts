type Channel = 'state_event' | 'run_event' | 'workflow_event';
interface Listener {
  event: (message: MessageEvent) => void;
  connection?: (connected: boolean) => void;
}

const streams = new Map<string, WorkspaceEventStream>();

/** One state/run/workflow connection per workspace in this renderer. Chat owns its own cursor. */
class WorkspaceEventStream {
  readonly listeners = new Map<Channel, Set<Listener>>();
  private source: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private hidden = false;
  private disposed = false;
  private runAfter = '';
  private workflowAfter = '';

  constructor(private readonly url: string) {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.pageHide);
      window.addEventListener('pageshow', this.pageShow);
    }
  }

  private pageHide = (): void => {
    this.hidden = true;
    this.close();
  };
  private pageShow = (): void => {
    this.hidden = false;
    this.open();
  };

  add(channel: Channel, listener: Listener): () => void {
    let subscribers = this.listeners.get(channel);
    const newChannel = !subscribers;
    if (!subscribers) {
      subscribers = new Set();
      this.listeners.set(channel, subscribers);
    }
    subscribers.add(listener);
    // A new channel needs its server snapshot/replay. Replacing the one socket
    // also preserves each other channel's independently captured replay cursor.
    if (newChannel) this.open();
    else if (this.connected) listener.connection?.(true);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      subscribers.delete(listener);
      if (subscribers.size) return;
      this.listeners.delete(channel);
      if (channel === 'run_event') this.runAfter = '';
      if (channel === 'workflow_event') this.workflowAfter = '';
      if (this.listeners.size) this.open();
      else {
        this.disposed = true;
        this.close();
        streams.delete(this.url);
        if (typeof window !== 'undefined') {
          window.removeEventListener('pagehide', this.pageHide);
          window.removeEventListener('pageshow', this.pageShow);
        }
      }
    };
  }

  private close(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.source?.close();
    this.source = null;
    this.connected = false;
  }

  private open(): void {
    this.close();
    if (this.disposed || this.hidden || !this.listeners.size) return;
    const query = new URLSearchParams(this.url.split('?')[1]);
    query.set('channels', [...this.listeners.keys()].sort().join(','));
    if (this.runAfter) query.set('runAfter', this.runAfter);
    if (this.workflowAfter) query.set('workflowAfter', this.workflowAfter);
    const source = new EventSource(`${this.url.split('?')[0]}?${query}`);
    this.source = source;
    for (const channel of this.listeners.keys())
      source.addEventListener(channel, (event) => {
        if (this.source !== source) return;
        const message = event as MessageEvent;
        // Native Last-Event-ID is a single register. It cannot represent three
        // interleaved streams: reconnect explicitly with separate run cursors.
        if (channel === 'run_event' && /^run_[A-Za-z0-9_-]+:\d+$/.test(message.lastEventId))
          this.runAfter = message.lastEventId;
        if (channel === 'workflow_event' && /^graph_[A-Za-z0-9_-]+:\d+$/.test(message.lastEventId))
          this.workflowAfter = message.lastEventId;
        for (const listener of this.listeners.get(channel) ?? []) {
          try {
            listener.event(message);
          } catch {
            /* One consumer must not block another. */
          }
        }
      });
    source.onopen = () => {
      if (this.source !== source) return;
      this.connected = true;
      this.notify(true);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.close();
      this.notify(false);
      if (!this.disposed && !this.hidden && !this.source)
        this.retry = setTimeout(() => this.open(), 1_000);
    };
  }

  private notify(connected: boolean): void {
    for (const listeners of this.listeners.values())
      for (const listener of listeners) {
        try {
          listener.connection?.(connected);
        } catch {
          /* Independent subscriptions. */
        }
      }
  }
}

export function subscribeWorkspaceEvents(
  url: string,
  channel: Channel,
  event: Listener['event'],
  connection?: Listener['connection'],
): () => void {
  let stream = streams.get(url);
  if (!stream) {
    stream = new WorkspaceEventStream(url);
    streams.set(url, stream);
  }
  return stream.add(channel, { event, connection });
}
