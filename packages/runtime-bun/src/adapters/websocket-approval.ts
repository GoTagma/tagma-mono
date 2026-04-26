import type { ApprovalGateway, ApprovalEvent } from '@tagma/core';

export interface WebSocketApprovalAdapterOptions {
  port?: number;
  hostname?: string;
  token?: string;
  allowAnyOrigin?: boolean;
}

export interface WebSocketApprovalAdapter {
  readonly port: number;
  readonly detach: () => void;
}

const MAX_PAYLOAD_BYTES = 4_096;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 1_000;

export function attachWebSocketApprovalAdapter(
  gateway: ApprovalGateway,
  options: WebSocketApprovalAdapterOptions = {},
): WebSocketApprovalAdapter {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? 'localhost';
  const requiredToken = options.token ?? null;
  const enforceOriginCheck = options.allowAnyOrigin !== true;

  function isLoopbackOrigin(origin: string): boolean {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
      return false;
    }
  }

  type WS = import('bun').ServerWebSocket<unknown>;
  const clients = new Set<WS>();
  const clientRates = new Map<WS, { count: number; resetAt: number }>();

  function broadcast(msg: unknown): void {
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      ws.send(text);
    }
  }

  const unsubscribe = gateway.subscribe((event: ApprovalEvent) => {
    switch (event.type) {
      case 'requested':
        broadcast({ type: 'approval_requested', request: event.request });
        break;
      case 'resolved':
        broadcast({ type: 'approval_resolved', request: event.request, decision: event.decision });
        break;
      case 'expired':
        broadcast({ type: 'approval_expired', request: event.request });
        break;
      case 'aborted':
        broadcast({ type: 'approval_aborted', request: event.request, reason: event.reason });
        break;
    }
  });

  const server = Bun.serve({
    port,
    hostname,

    fetch(req, server) {
      if (enforceOriginCheck) {
        const origin = req.headers.get('origin');
        if (origin && !isLoopbackOrigin(origin)) {
          return new Response('forbidden origin', { status: 403 });
        }
      }

      if (requiredToken !== null) {
        const headerToken = req.headers.get('x-tagma-token') ?? '';
        let queryToken = '';
        try {
          queryToken = new URL(req.url).searchParams.get('token') ?? '';
        } catch {
          /* malformed URL */
        }
        const presented = headerToken || queryToken;
        if (presented !== requiredToken) {
          return new Response('unauthorized', { status: 401 });
        }
      }

      if (server.upgrade(req)) return undefined;
      return new Response('tagma-sdk WebSocket approval endpoint', { status: 426 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: 'pending', requests: gateway.pending() }));
      },

      message(ws, raw) {
        const rawStr = typeof raw === 'string' ? raw : raw.toString();

        if (rawStr.length > MAX_PAYLOAD_BYTES) {
          ws.send(JSON.stringify({ type: 'error', message: 'message too large' }));
          return;
        }

        const now = Date.now();
        const rate = clientRates.get(ws) ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        if (now >= rate.resetAt) {
          rate.count = 0;
          rate.resetAt = now + RATE_LIMIT_WINDOW_MS;
        }
        rate.count++;
        clientRates.set(ws, rate);
        if (rate.count > RATE_LIMIT_MAX) {
          ws.send(JSON.stringify({ type: 'error', message: 'rate limit exceeded' }));
          return;
        }

        let msg: unknown;
        try {
          msg = JSON.parse(rawStr);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
          return;
        }

        if (!isResolveMessage(msg)) {
          ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
          return;
        }

        const ok = gateway.resolve(msg.approvalId, {
          outcome: msg.outcome,
          actor: msg.actor ?? 'websocket',
          reason: msg.reason,
        });

        if (!ok) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: `approval ${msg.approvalId} not found or already resolved`,
            }),
          );
        }
      },

      close(ws) {
        clients.delete(ws);
        clientRates.delete(ws);
      },
    },
  });

  return {
    port: server.port!,
    detach() {
      unsubscribe();
      clients.clear();
      server.stop(true);
    },
  };
}

interface ResolveMessage {
  type: 'resolve';
  approvalId: string;
  outcome: 'approved' | 'rejected';
  actor?: string;
  reason?: string;
}

function isResolveMessage(v: unknown): v is ResolveMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m['type'] === 'resolve' &&
    typeof m['approvalId'] === 'string' &&
    (m['outcome'] === 'approved' || m['outcome'] === 'rejected')
  );
}
