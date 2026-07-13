# Editor Agent Notes

## Chat Session Concurrency

- Model and reasoning-effort selections are preferences for the next prompt; prompt dispatch
  snapshots both when it starts.
- Keep those selectors enabled when the visible conversation is idle, even if another
  conversation is active or owns the YAML edit lock. The visible conversation's own send,
  pending prompt, queue, reconciliation, or flush may still block them.
- Provider connection and OpenCode runtime mutations use the broader lock and must remain
  blocked while any conversation is active.
- Chat model-variant choices come from each model's v2 OpenCode `variants` catalog. Preserve
  those ids through the legacy provider adapter; `null` means model default. Do not restore a
  fixed cross-model reasoning-effort enum.

## Chat YAML Branch Isolation

- While a local chat YAML lease is active, file watchers observe OpenCode disk writes but must
  not adopt them into the editable renderer branch in `WorkspaceState`.
- Capture one YAML/layout snapshot per logical turn. Queued prompts and automatic repair prompts
  reuse that snapshot and lease; reconciliation runs only from the finished-turn queue.
- If the user edited the current pipeline too, create one idempotent numbered result copy, restore
  the latest renderer branch to the original, never auto-open the result, and publish its link only
  after reconciliation and lease release finish.

## Managed OpenCode Execution

- Pipeline prompt tasks using the built-in `opencode` driver must resolve the executable through
  `resolveOpencodeBinary()`, using the same user-runtime, bundled, dev-staged, then PATH precedence
  as Chat. Do not let editor-owned AI runs silently select a different global OpenCode version.
- Command tasks remain host commands and must keep their normal PATH resolution, even when the
  command itself invokes `opencode`.
- When the managed layers are intentionally absent in headless development, resolve the system
  fallback with `Bun.which('opencode')` before spawning so Windows `.cmd` shims work.
- OpenCode reserves an agent's configured final `steps` iteration for a forced text-only summary.
  A primary router that makes one `task` call needs `steps: 3`: delegate, relay the result, then cap.

## Windows Pipeline Paths

- Treat resolved pipeline paths as case-insensitively equivalent on Windows before enforcing the
  `.tagma/<stem>/<stem>.yaml` shape. Drive-letter casing and `/` versus `\\` are aliases;
  POSIX path comparisons remain case-sensitive.
