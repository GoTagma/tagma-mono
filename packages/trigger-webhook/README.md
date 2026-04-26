# @tagma/trigger-webhook

HTTP webhook trigger plugin for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Pauses a task until a POST request arrives on a configured local HTTP listener. Optional HMAC-SHA256 signature validation protects against unauthenticated callers.

## Install

```bash
bun add @tagma/trigger-webhook
```

## Usage

```yaml
pipeline:
  name: deploy-on-demand
  plugins:
    - '@tagma/trigger-webhook'
  tracks:
    - id: deploy
      name: Deploy
      driver: claude-code
      tasks:
        - id: wait-signal
          name: Wait for deploy signal
          trigger:
            type: webhook
            port: 8787
            path: /hooks/deploy
            secret_env: TAGMA_WEBHOOK_SECRET
            timeout: 30m
          prompt: 'Run the deploy playbook for the staging environment'
```

Then fire the webhook from anywhere (CI, Slack, cron, another pipeline):

```bash
BODY='{"env":"staging","sha":"abc123"}'
SIG="sha256=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$TAGMA_WEBHOOK_SECRET" | awk '{print $2}')"
curl -X POST http://localhost:8787/hooks/deploy \
  -H "content-type: application/json" \
  -H "x-tagma-signature: $SIG" \
  -d "$BODY"
```

Or load it programmatically:

```ts
import { createTagma } from '@tagma/sdk';

const tagma = createTagma();
await tagma.registry.loadPlugins(['@tagma/trigger-webhook'], process.cwd());
```

## Config

| Field        | Type     | Default      | Notes                                                                                                                                                        |
| ------------ | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `port`       | number   | _(required)_ | TCP port to listen on (1-65535)                                                                                                                              |
| `path`       | string   | `/webhook`   | URL path to match; must start with `/`                                                                                                                       |
| `host`       | string   | `127.0.0.1`  | Interface to bind. Defaults to loopback. Setting to `0.0.0.0` or any non-loopback address without `secret_env` is refused at config time                      |
| `secret_env` | string   | _(none)_     | Env var holding the HMAC-SHA256 secret. When set, requests must include `x-tagma-signature`                                                                  |
| `timeout`    | duration | _(forever)_  | Max wait time; omit (or set to `0`) for unbounded wait                                                                                                       |

## Behavior

- A single `Bun.serve` listener is created per unique `(host, port, path)` triple and shared across all tasks that watch it. Multiple tasks on the same endpoint form a FIFO waiter queue — the next POST wakes one waiter.
- Default bind is `127.0.0.1` so the endpoint is only reachable from the local machine. A non-loopback `host` without `secret_env` is refused.
- Signature header format: `x-tagma-signature: sha256=<hex>`, HMAC-SHA256 of the raw request body using the secret. Verification is constant-time.
- JSON bodies (`content-type: application/json`) are parsed and handed to the task as the trigger payload. A malformed JSON body under that content-type returns `400 invalid JSON body`. Other content-types are passed through as raw strings.
- Successful delivery responds `202 ok`. A POST arriving while no task is waiting is rejected with `409 no waiting task` so the caller can retry once a pipeline is up. Non-matching paths return `404`, non-POST methods return `405`.
- The listener outlives the task — it's a per-process singleton, not cleaned up between pipeline runs. Restart the host to free the port.

## Security

Always set `secret_env` in production. Without it, any caller that can reach the loopback port can fire the trigger. The plugin already binds to `127.0.0.1` by default; only change `host` when you deliberately need LAN/container reachability, and always pair a non-loopback bind with `secret_env`.

## License

MIT
