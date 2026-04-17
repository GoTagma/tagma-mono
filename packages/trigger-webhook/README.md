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
import { bootstrapBuiltins, loadPlugins } from '@tagma/sdk';

bootstrapBuiltins();
await loadPlugins(['@tagma/trigger-webhook']);
```

## Config

| Field        | Type     | Default      | Notes                                                                                       |
| ------------ | -------- | ------------ | ------------------------------------------------------------------------------------------- |
| `port`       | number   | _(required)_ | TCP port to listen on (1-65535)                                                             |
| `path`       | string   | `/webhook`   | URL path to match; must start with `/`                                                      |
| `secret_env` | string   | _(none)_     | Env var holding the HMAC-SHA256 secret. When set, requests must include `x-tagma-signature` |
| `timeout`    | duration | _(forever)_  | Max wait time; omit for unbounded wait                                                      |

## Behavior

- A single `Bun.serve` listener is created per unique `(port, path)` pair and shared across all tasks that watch it. Multiple tasks on the same endpoint form a FIFO waiter queue — the next POST wakes one waiter.
- Signature header format: `x-tagma-signature: sha256=<hex>`, HMAC-SHA256 of the raw request body using the secret. Verification is constant-time.
- JSON bodies (`content-type: application/json`) are parsed and handed to the task as the trigger payload; other bodies are passed through as raw strings.
- A POST arriving while no task is waiting is rejected with `409 no waiting task` so the caller can retry once a pipeline is up.
- The listener outlives the task — it's a per-process singleton, not cleaned up between pipeline runs. Restart the host to free the port.

## Security

Always set `secret_env` in production. Without it, anyone who can reach the port can fire the trigger. Bind the host to `127.0.0.1` at the OS level if you only need local callers.

## License

MIT
