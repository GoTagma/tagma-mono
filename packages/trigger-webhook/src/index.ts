// ═══ Webhook Trigger Plugin ═══
//
// Spins up a Bun.serve HTTP listener and resolves the trigger when a POST
// arrives on the configured path. Optional HMAC-SHA256 validation via the
// `x-tagma-signature: sha256=<hex>` header protects against unauthenticated
// callers when the secret env var is set.
//
// Multiple tasks sharing the same `(port, path)` pair hit the same listener
// instance and are enqueued as waiters — the next inbound request wakes one
// waiter (FIFO). This keeps the plugin lightweight even when a pipeline has
// many webhook-triggered tasks.
//
// Usage in pipeline.yaml:
//   plugins: ["@tagma/trigger-webhook"]
//   tracks:
//     - tasks:
//         - id: deploy
//           trigger:
//             type: webhook
//             port: 8787
//             path: /hooks/deploy
//             secret_env: TAGMA_WEBHOOK_SECRET
//             timeout: 10m

import type { TriggerPlugin, TriggerContext } from '@tagma/types';
import { createHmac, timingSafeEqual } from 'node:crypto';

type Resolver = (payload: unknown) => void;

interface WebhookServerState {
  readonly port: number;
  readonly path: string;
  readonly secretEnv: string | undefined;
  readonly waiters: Resolver[];
}

// Module-level so concurrent tasks on the same (port, path) share one
// listener. Bun.serve refuses to bind a port twice, so this sharing is
// required — not just an optimization.
const servers = new Map<string, WebhookServerState>();

function serverKey(port: number, path: string): string {
  return `${port}::${path}`;
}

function parseDurationSafe(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  const str = String(raw).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    case 's':
    default:   return n * 1000;
  }
}

function verifySignature(rawBody: string, header: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function ensureServer(
  port: number,
  path: string,
  secretEnv: string | undefined,
): WebhookServerState {
  const key = serverKey(port, path);
  const existing = servers.get(key);
  if (existing) return existing;

  const state: WebhookServerState = {
    port,
    path,
    secretEnv,
    waiters: [],
  };

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== path) {
        return new Response('not found', { status: 404 });
      }
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 });
      }

      const rawBody = await req.text();

      // HMAC gate — bypassed when no secret env is configured, which is
      // acceptable for loopback dev but should always be set in production.
      const secret = state.secretEnv ? process.env[state.secretEnv] : undefined;
      if (state.secretEnv) {
        if (!secret) {
          return new Response(`env var ${state.secretEnv} not set`, { status: 500 });
        }
        const sigHeader = req.headers.get('x-tagma-signature') ?? '';
        if (!verifySignature(rawBody, sigHeader, secret)) {
          return new Response('invalid signature', { status: 401 });
        }
      }

      // Decode JSON if possible so downstream tasks get structured data.
      // Falls back to the raw string body otherwise.
      let payload: unknown = rawBody;
      const contentType = req.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          /* keep raw body */
        }
      }

      const waiter = state.waiters.shift();
      if (waiter) {
        waiter(payload);
        return new Response('ok', { status: 202 });
      }
      // No task is currently waiting on this endpoint — reject loudly so
      // callers know the webhook wasn't actually consumed by a pipeline.
      return new Response('no waiting task', { status: 409 });
    },
    error(err) {
      console.error(`[webhook] server error on :${port}${path}:`, err);
      return new Response('internal error', { status: 500 });
    },
  });

  servers.set(key, state);
  return state;
}

const WebhookTrigger: TriggerPlugin = {
  name: 'webhook',
  schema: {
    description:
      'Wait for an HTTP POST to arrive on a local listener before the task runs.',
    fields: {
      port: {
        type: 'number',
        required: true,
        default: 8787,
        min: 1,
        max: 65535,
        description: 'TCP port to listen on.',
        placeholder: '8787',
      },
      path: {
        type: 'string',
        required: true,
        default: '/webhook',
        description: 'URL path to match (e.g. /hooks/deploy).',
        placeholder: '/webhook',
      },
      secret_env: {
        type: 'string',
        description:
          'Env var containing the HMAC-SHA256 secret. When set, POSTs must include an x-tagma-signature: sha256=<hex> header computed over the raw body.',
        placeholder: 'TAGMA_WEBHOOK_SECRET',
      },
      timeout: {
        type: 'duration',
        description: 'Maximum wait time (e.g. 10m). Omit or 0 to wait indefinitely.',
        placeholder: '10m',
      },
    },
  },

  watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown> {
    const rawPort = config.port;
    const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`webhook trigger: "port" must be 1-65535, got ${String(rawPort)}`);
    }

    const path = (config.path as string | undefined) ?? '/webhook';
    if (!path.startsWith('/')) {
      throw new Error(`webhook trigger: "path" must start with "/", got ${path}`);
    }

    const secretEnv = config.secret_env as string | undefined;
    const timeoutMs = config.timeout != null
      ? parseDurationSafe(config.timeout, 0)
      : 0;

    const state = ensureServer(port, path, secretEnv);

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      if (ctx.signal.aborted) {
        rejectPromise(new Error('Pipeline aborted'));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const onFire: Resolver = (payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(payload);
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error('Pipeline aborted'));
      };

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const idx = state.waiters.indexOf(onFire);
        if (idx !== -1) state.waiters.splice(idx, 1);
      };

      state.waiters.push(onFire);
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(
            new Error(
              `webhook trigger timeout: no POST on :${port}${path} within ${String(config.timeout)}`,
            ),
          );
        }, timeoutMs);
      }
    });
  },
};

// ═══ Plugin self-description exports ═══
export const pluginCategory = 'triggers';
export const pluginType = 'webhook';
export default WebhookTrigger;
