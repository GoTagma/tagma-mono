import type { ApprovalGateway, ApprovalEvent } from '../approval';

// ═══ WebSocket Approval Adapter ═══
//
// Bridges the ApprovalGateway to WebSocket clients (e.g. a frontend UI).
// Mirrors the stdin-approval adapter pattern: subscribe to gateway events,
// forward them as JSON to all connected clients, and call gateway.resolve()
// when a client sends a resolution message.
//
// Protocol — server → client:
//   { type: 'pending',             requests: ApprovalRequest[] }   ← sent on connect
//   { type: 'approval_requested',  request:  ApprovalRequest }
//   { type: 'approval_resolved',   request:  ApprovalRequest, decision: ApprovalDecision }
//   { type: 'approval_expired',    request:  ApprovalRequest }
//   { type: 'approval_aborted',    request:  ApprovalRequest, reason: string }
//
// Protocol — client → server:
//   { type: 'resolve', approvalId: string, outcome: 'approved'|'rejected',
//     actor?: string, reason?: string }

export interface WebSocketApprovalAdapterOptions {
  port?: number; // default: 3000
  hostname?: string; // default: 'localhost'
  /**
   * M11: shared secret required from the client during the WebSocket
   * upgrade. The token can be supplied either as the `?token=` query
   * parameter or in the `x-tagma-token` request header. When set, any
   * upgrade request that fails the check is rejected with HTTP 401 and
   * never reaches the WebSocket layer (so a misconfigured client cannot
   * exhaust rate-limit slots either). Leave undefined for backward
   * compatibility with localhost-only deployments.
   */
  token?: string;
  /**
   * M11: opt-out of origin checking. Defaults to false, meaning Origin
   * headers are restricted to loopback hosts (localhost / 127.0.0.1 / ::1).
   * Requests without an Origin header are still allowed so non-browser local
   * clients can connect. Set true only for trusted reverse-proxy setups.
   */
  allowAnyOrigin?: boolean;
}

export interface WebSocketApprovalAdapter {
  readonly port: number;
  readonly detach: () => void;
}

// Maximum allowed message payload (bytes) to prevent DoS via oversized messages.
const MAX_PAYLOAD_BYTES = 4_096;
// Per-client rate limit: at most this many messages per window.
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
      // M11: enforce token before any upgrade so an unauthenticated client
      // can't even open a socket. Tokens may arrive via header or query.
      if (requiredToken !== null) {
        const headerToken = req.headers.get('x-tagma-token') ?? '';
        let queryToken = '';
        try {
          queryToken = new URL(req.url).searchParams.get('token') ?? '';
        } catch {
          /* malformed URL — leave queryToken empty */
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
        // Sync current pending approvals to newly connected client.
        ws.send(JSON.stringify({ type: 'pending', requests: gateway.pending() }));
      },

      message(ws, raw) {
        const rawStr = typeof raw === 'string' ? raw : raw.toString();

        // Payload size guard — reject oversized messages before parsing.
        if (rawStr.length > MAX_PAYLOAD_BYTES) {
          ws.send(JSON.stringify({ type: 'error', message: 'message too large' }));
          return;
        }

        // Per-client rate limit.
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

// ── Type guard ──

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
