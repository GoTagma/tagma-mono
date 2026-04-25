---
title: OpenCode Chat — inline tool-permission UI
date: 2026-04-25
status: draft
supersedes: 2026-04-24-opencode-chat-per-yaml-design.md
---

# OpenCode Chat — inline tool-permission UI

## Summary

Surface opencode's per-tool permission prompts as inline bubbles inside the existing chat stream, with Allow-once / Always / Reject buttons wired to `client.permission.reply`. Today the SSE dispatcher's default branch drops these events (`apps/editor/src/store/chat-store.ts:614-619`), which means the user never sees a prompt and opencode stalls until its own timeout.

This is a narrow, additive feature. Everything else the chat needs — workspace-level session, editor-context injection, post-chat YAML actions — already exists and stays as-is.

## Goals

- Make opencode's native permission flow visible in the chat panel.
- Preserve reading context: render bubbles inline in the message stream, not as modals.
- Never deadlock — the user can always reply; if they leave the panel, opencode's server-side timeout is authoritative.

## Non-goals

- **Per-YAML chat session binding.** The current workspace-level session (one `currentSessionId`, `<editor-context><current-file>` refreshed per turn) is the better design; it lets users carry a single conversation across multiple YAMLs. An earlier version of this spec proposed per-YAML binding — that was a mistake and has been removed.
- Rewriting the opencode server lifecycle, bootstrap, SSE reconnect, or any other part of chat already working.
- Mapping YAML's `permissions: { read, write, execute }` to `session.chat({ tools })` pre-authorization. The `tagma-yaml` agent file (`.opencode/agent/tagma-yaml.md`) already declares the static tool allow-list (`bash: false`, `webfetch: false`, `task: false`). Per-call gating is opencode's job; we just render + relay. If YAML→tools mapping becomes useful later, it can land in a follow-up spec.

## Already-implemented context (do not re-build)

Verified against `apps/editor/` on 2026-04-25:

| Feature | Location | Status |
|---|---|---|
| Workspace-level chat session; switching YAML keeps session | `src/store/chat-store.ts` `currentSessionId`, `buildEditorContext()` | done |
| Per-turn `<editor-context>` with `<workspace>/<current-file>/<plugins>` | `src/store/chat-store.ts:42-74` | done |
| New-YAML detection via pre/post snapshot diff | `src/utils/chat-yaml-reconcile.ts:29` `detectChatYamlTarget` | done |
| Inline "Open new YAML" card (no auto-jump — user must click) | `src/components/chat/ChatPanel.tsx:636` `YamlActionBubble` | done |
| SSE subscription + reconnect with exponential backoff | `src/store/chat-store.ts` `ensureSseSubscription` | done |
| Provider auth (API key / OAuth) | `src/components/chat/ProviderConnectDialog.tsx` + store | done |
| **Tool-permission prompts** | — | **this spec** |

## Design

### SSE dispatcher extension

Add permission-event cases to `applySseEvent` in `src/store/chat-store.ts`. The exact event names and payload shape depend on which `@opencode-ai/sdk` version is installed (package.json pins `^1.14.19`); the implementation plan's first task is to read the SDK's event-type union and wire the handler against the concrete names.

Required behavior:

- **On "new permission request" event:** upsert into `pendingPermissions` keyed by `permissionID`. Ignore events whose `sessionID !== currentSessionId` (same scoping rule as every other handler in the dispatcher).
- **On "permission resolved" event** (reply received from any client — this one or a parallel CLI): remove from `pendingPermissions`.
- **On session switch** (`selectSession`): clear `pendingPermissions` together with `messages`, same way the existing `selectSession` resets turn-scoped flags.
- **On session delete**: if the deleted session is current, clear `pendingPermissions` in the same patch.

### State shape

Extend `ChatStore`:

```ts
interface PendingPermission {
  id: string;          // opencode permissionID
  sessionID: string;
  title: string;       // human-readable, e.g. "Edit .tagma/build-pipeline.yaml"
  tool: string;        // "edit" | "write" | "bash" | ... (raw from event)
  metadata?: unknown;  // passed through for debug display; never parsed
  createdAt: number;   // unix-ms (prefer event timestamp; fall back to Date.now)
}

interface ChatStore {
  // ... existing fields ...
  pendingPermissions: PendingPermission[];
  replyPermission: (id: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
}
```

`replyPermission` calls `client.permission.reply({ requestID: id, reply })`. On success, the SSE "resolved" event removes the entry (no optimistic removal — the server is the source of truth). On failure, set `sendError` and leave the bubble so the user can retry.

### UI: `PermissionBubble` component

New file at `src/components/chat/PermissionBubble.tsx`. Renders inline inside the message stream, **not** as a modal.

```
┌─ agent wants to: edit .tagma/build-pipeline.yaml ─┐
│   [Allow once]  [Always for this chat]  [Reject]   │
└────────────────────────────────────────────────────┘
```

Rendering in `ChatPanel.tsx`, appended after the existing end-of-stream bubbles:

```tsx
{postChatYamlAction && !sending && <YamlActionBubble />}
{pendingPermissions.map((p) => <PermissionBubble key={p.id} permission={p} />)}
```

Stack order rationale: permission bubbles are rendered last because they are the thing the user must act on next — anything below them in the stream would be visually de-prioritized and easily missed.

Visual language reuses `YamlActionBubble`'s styling (same width cap, same inline-card treatment) so the chat stream has a single, consistent shape. Disable buttons while a reply is in flight; re-enable on failure so retry works.

### "Always" scope

"Always" maps directly to opencode's native `reply: "always"` — the server scopes it to the current session. That matches the user's mental model: one conversation, one toleration profile. The client does not maintain its own always-allow list.

## Data flow: single permission prompt

```
model calls a gated tool (e.g. edit .tagma/foo.yaml)
 ↓
opencode server emits permission event {id, sessionID, title, tool, ...}
 ↓
applySseEvent upserts into pendingPermissions
 ↓
ChatPanel renders <PermissionBubble/> at end of stream
 ↓
user clicks "Allow once"
 ↓
store.replyPermission(id, 'once')
 ↓
client.permission.reply({ requestID: id, reply: 'once' })
 ↓
opencode resumes tool execution; emits "resolved" event
 ↓
applySseEvent removes entry from pendingPermissions; bubble unmounts
 ↓
message.part.updated events flow for the tool's output
```

If the user switches YAML while a bubble is pending: the bubble stays in `pendingPermissions` (workspace-level state, not per-YAML). When they come back to the chat panel, it's still there. No client-side expiry — opencode's server-side timeout is authoritative.

## Testing strategy

- **Unit:** `upsertPermission` helper — new entry, idempotent re-upsert, removal on resolved.
- **Unit:** `replyPermission` store method — success path (no optimistic mutation; event-driven clear), failure path (sets `sendError`, keeps entry).
- **Component:** `PermissionBubble` — renders three buttons, fires `replyPermission` with the correct arg per button, disables during reply, re-enables on failure.
- **Integration:** spin up opencode server in test; trigger a tool call that gates (e.g. edit outside the agent's static allow-list, or an opencode default that requires confirmation); verify event → bubble → reply → tool resumes → bubble clears.
- **Session-switch test:** open chat with a pending permission, switch session, verify `pendingPermissions` resets; switch back, verify no stale bubble resurfaces.

## References

- `apps/editor/src/store/chat-store.ts` — SSE dispatcher to extend; see the `default` branch comment (lines 614-619) listing the events currently dropped
- `apps/editor/src/components/chat/ChatPanel.tsx:636` + `YamlActionBubble` — styling and insertion point for the new bubble
- `.opencode/agent/tagma-yaml.md` — agent config (static tools allow-list)
- `@opencode-ai/sdk@^1.14.19` — `client.permission.reply({ requestID, reply })`, permission events in `event.subscribe`
