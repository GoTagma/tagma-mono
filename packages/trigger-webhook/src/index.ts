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

import {
  parseDurationSafe,
  type TagmaPlugin,
  type TriggerPlugin,
  type TriggerContext,
  type TriggerWatchHandle,
  TriggerTimeoutError,
} from '@tagma/types';
import { createHmac, timingSafeEqual } from 'node:crypto';

type Resolver = (payload: unknown) => void;

interface WebhookServerState {
  readonly key: string;
  readonly port: number;
  readonly path: string;
  readonly secretEnv: string | undefined;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly waiters: Resolver[];
}

// Module-level so concurrent tasks on the same (port, path) share one
// listener. Bun.serve refuses to bind a port twice, so this sharing is
// required — not just an optimization.
const servers = new Map<string, WebhookServerState>();

function serverKey(port: number, path: string, hostname: string): string {
  return `${hostname}::${port}::${path}`;
}

const DEFAULT_WEBHOOK_HOST = '127.0.0.1';

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
  hostname: string,
): WebhookServerState {
  const key = serverKey(port, path, hostname);
  const existing = servers.get(key);
  if (existing) {
    if (existing.secretEnv !== secretEnv) {
      throw new Error(
        `webhook trigger: ${hostname}:${port}${path} is already registered with a different secret_env`,
      );
    }
    return existing;
  }

  // Bun.serve callbacks need to close over the state object before the server
  // handle exists, then the completed object is assigned once below.
  // eslint-disable-next-line prefer-const
  let state: WebhookServerState;
  const server = Bun.serve({
    port,
    // Default to loopback so the webhook endpoint is not reachable from the
    // LAN unless the user explicitly sets `host` in their YAML (e.g. for
    // container/WSL scenarios). Without this, Bun.serve listens on all
    // interfaces and a secret-less webhook would accept traffic from any
    // network-adjacent caller.
    hostname,
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
      //
      // D22: when the sender explicitly declared `application/json`, a parse
      // failure is a contract violation — silently falling through to the
      // raw-string payload meant downstream tasks that did `payload.field`
      // crashed later with "Cannot read properties of undefined", far away
      // from the actual cause. Return 400 so the sender sees the problem
      // up front. Bodies without a JSON content-type still pass through
      // untouched, which preserves the "any POST body" escape hatch.
      let payload: unknown = rawBody;
      const contentType = req.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          payload = JSON.parse(rawBody);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(`invalid JSON body: ${msg}`, { status: 400 });
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

  state = {
    key,
    port,
    path,
    secretEnv,
    server,
    waiters: [],
  };
  servers.set(key, state);
  return state;
}

function closeServerIfIdle(state: WebhookServerState): void {
  if (state.waiters.length > 0) return;
  if (servers.get(state.key) !== state) return;
  servers.delete(state.key);
  state.server.stop(true);
}

export const WebhookTrigger: TriggerPlugin = {
  name: 'webhook',
  schema: {
    description: 'Wait for an HTTP POST to arrive on a local listener before the task runs.',
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
      host: {
        type: 'string',
        default: DEFAULT_WEBHOOK_HOST,
        description:
          'Interface to bind on. Defaults to 127.0.0.1 so the webhook is only reachable from the local machine. Set to 0.0.0.0 to accept LAN traffic (only do this when secret_env is also set).',
        placeholder: DEFAULT_WEBHOOK_HOST,
      },
      timeout: {
        type: 'duration',
        description: 'Maximum wait time (e.g. 10m). Omit or 0 to wait indefinitely.',
        placeholder: '10m',
      },
    },
  },

  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle {
    const rawPort = config.port;
    const port = typeof rawPort === 'number' ? rawPort : Number(rawPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`webhook trigger: "port" must be 1-65535, got ${String(rawPort)}`);
    }

    const path = (config.path as string | undefined) ?? '/webhook';
    if (!path.startsWith('/')) {
      throw new Error(`webhook trigger: "path" must start with "/", got ${path}`);
    }

    const secretEnv =
      typeof config.secret_env === 'string' && config.secret_env.trim().length > 0
        ? config.secret_env.trim()
        : undefined;
    const rawHost = config.host;
    const hostname =
      typeof rawHost === 'string' && rawHost.trim().length > 0
        ? rawHost.trim()
        : DEFAULT_WEBHOOK_HOST;
    const timeoutMs = config.timeout != null ? parseDurationSafe(config.timeout, 0) : 0;

    if (hostname !== DEFAULT_WEBHOOK_HOST && hostname !== 'localhost' && !secretEnv) {
      // Loud warning — the user has opted into a non-loopback bind without
      // HMAC. Refuse by default rather than silently expose the endpoint to
      // the network.
      throw new Error(
        `webhook trigger: binding to "${hostname}" without secret_env is refused — set secret_env to enable HMAC authentication before exposing to non-loopback interfaces`,
      );
    }

    const state = ensureServer(port, path, secretEnv, hostname);

    let dispose = (_reason?: string) => {
      /* assigned below */
    };
    const fired = new Promise<unknown>((resolvePromise, rejectPromise) => {
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
        closeServerIfIdle(state);
      };

      dispose = (reason = 'webhook trigger disposed'): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error(reason));
      };

      state.waiters.push(onFire);
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectPromise(
            new TriggerTimeoutError(
              `webhook trigger timeout: no POST on :${port}${path} within ${String(config.timeout)}`,
            ),
          );
        }, timeoutMs);
      }
    });
    return { fired, dispose };
  },
};

export default {
  name: '@tagma/trigger-webhook',
  capabilities: {
    triggers: {
      webhook: WebhookTrigger,
    },
  },
} satisfies TagmaPlugin;
