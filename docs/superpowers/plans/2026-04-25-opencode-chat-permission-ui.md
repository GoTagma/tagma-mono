# OpenCode Chat — inline tool-permission UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface opencode's per-tool permission prompts as inline bubbles in the chat panel, wired to `POST /session/{id}/permissions/{permissionID}` with Allow-once / Always / Reject.

**Architecture:** Additive extension of `apps/editor/src/store/chat-store.ts`. New SSE dispatcher cases (`permission.updated` / `permission.replied`) upsert/remove from a new `pendingPermissions: PendingPermission[]` state field. A new `PermissionBubble` React component renders inline after the existing `YamlActionBubble` in `ChatPanel.tsx`. Clicks invoke `client.postSessionIdPermissionsPermissionId` — success is event-driven (server emits `permission.replied`; no optimistic removal).

**Tech Stack:** TypeScript, React 19, zustand, `@opencode-ai/sdk@^1.14.19` (client in `apps/editor/node_modules/@opencode-ai/sdk`), `bun:test`, Tailwind (follow `YamlActionBubble` classes verbatim).

**Spec:** [`docs/superpowers/specs/2026-04-25-opencode-chat-permission-ui.md`](../specs/2026-04-25-opencode-chat-permission-ui.md)

**Cross-repo note:** `apps/editor/` is a git submodule (`https://github.com/GoTagma/tagma-desktop.git`). All code changes and per-task commits happen inside the submodule. A final task bumps the submodule pointer in the parent `tagma-mono` repo.

---

## File Structure

**Create:**
- `apps/editor/src/utils/permission-store-helpers.ts` — `PendingPermission` type + `upsertPermission` + `removePermission` (pure functions, easily unit-testable).
- `apps/editor/tests/permission-store-helpers.test.ts` — unit tests for the above.
- `apps/editor/src/components/chat/PermissionBubble.tsx` — React component with three reply buttons.

**Modify:**
- `apps/editor/src/store/chat-store.ts` — extend `ChatStore` interface, initial state, `applySseEvent` (new `permission.updated` + `permission.replied` cases), `selectSession` / `newSession` / `deleteSession` (clear on session switch), add `replyPermission` method.
- `apps/editor/src/components/chat/ChatPanel.tsx` — render `PermissionBubble` list after `YamlActionBubble`.

**Parent repo (tagma-mono):**
- `apps` submodule pointer — bumped once at the end after submodule commits land.

---

## SDK reference (for tasks below)

Types from `apps/editor/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (do not import from internal paths — these types re-export through the SDK's public surface):

```ts
// Lines 369-383
export type Permission = {
  id: string;
  type: string;              // e.g. "edit", "bash", "write"
  pattern?: string | Array<string>;
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;             // e.g. "Edit .tagma/foo.yaml"
  metadata: { [key: string]: unknown };
  time: { created: number }; // unix-ms
};

// Lines 384-395
export type EventPermissionUpdated = {
  type: "permission.updated";
  properties: Permission;
};
export type EventPermissionReplied = {
  type: "permission.replied";
  properties: { sessionID: string; permissionID: string; response: string };
};

// Lines 2507-2519 — reply API
// client.postSessionIdPermissionsPermissionId({
//   path: { id: sessionId, permissionID: permId },
//   body: { response: "once" | "always" | "reject" }
// }) => Promise<boolean>
```

---

### Task 1: PendingPermission type + helpers with tests

**Files:**
- Create: `apps/editor/src/utils/permission-store-helpers.ts`
- Create: `apps/editor/tests/permission-store-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/editor/tests/permission-store-helpers.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  upsertPermission,
  removePermission,
  type PendingPermission,
} from '../src/utils/permission-store-helpers';

const sample: PendingPermission = {
  id: 'perm_1',
  sessionID: 'ses_1',
  title: 'Edit .tagma/foo.yaml',
  tool: 'edit',
  metadata: {},
  createdAt: 1,
};

describe('upsertPermission', () => {
  test('adds a new permission when id is unseen', () => {
    expect(upsertPermission([], sample)).toEqual([sample]);
  });

  test('replaces an existing permission with the same id', () => {
    const updated: PendingPermission = { ...sample, title: 'changed' };
    expect(upsertPermission([sample], updated)).toEqual([updated]);
  });

  test('preserves order when replacing mid-list', () => {
    const other: PendingPermission = { ...sample, id: 'perm_2' };
    const updated: PendingPermission = { ...sample, title: 'changed' };
    expect(upsertPermission([sample, other], updated)).toEqual([updated, other]);
  });
});

describe('removePermission', () => {
  test('removes by id', () => {
    expect(removePermission([sample], 'perm_1')).toEqual([]);
  });

  test('no-op when id not present', () => {
    expect(removePermission([sample], 'perm_nope')).toEqual([sample]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root):
```bash
cd apps/editor && bun test tests/permission-store-helpers.test.ts
```
Expected: FAIL — module `../src/utils/permission-store-helpers` does not exist.

- [ ] **Step 3: Implement the helpers**

Create `apps/editor/src/utils/permission-store-helpers.ts`:

```ts
export interface PendingPermission {
  id: string;
  sessionID: string;
  title: string;
  tool: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Upsert a permission into the pending list keyed by id. Preserves position
 * when replacing so the UI doesn't reshuffle on every status update from the
 * server.
 */
export function upsertPermission(
  list: readonly PendingPermission[],
  next: PendingPermission,
): PendingPermission[] {
  const idx = list.findIndex((p) => p.id === next.id);
  if (idx < 0) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

/** Remove a permission by id. No-op when id is not present. */
export function removePermission(
  list: readonly PendingPermission[],
  id: string,
): PendingPermission[] {
  return list.filter((p) => p.id !== id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd apps/editor && bun test tests/permission-store-helpers.test.ts
```
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

From repo root:
```bash
cd apps/editor
git add src/utils/permission-store-helpers.ts tests/permission-store-helpers.test.ts
git commit -m "feat(chat): add PendingPermission type and upsert/remove helpers"
cd ../..
```

---

### Task 2: Extend ChatStore with pendingPermissions state and replyPermission

**Files:**
- Modify: `apps/editor/src/store/chat-store.ts`

- [ ] **Step 1: Add import at the top of chat-store.ts**

Locate the existing import block at the top of the file (begins at line 1 with `import { create } from 'zustand';`). Add the new import alongside the other local-utility imports:

```ts
import {
  upsertPermission,
  removePermission,
  type PendingPermission,
} from '../utils/permission-store-helpers';
```

- [ ] **Step 2: Extend the ChatStore interface**

Locate the `interface ChatStore { ... }` block (around line 128). Add the two fields near the end of the interface, just before the closing brace. Keep the grouping with other turn-scoped fields:

```ts
  /**
   * Pending permission prompts from opencode. Each entry is one tool-call
   * the agent wants confirmed. Populated by `permission.updated` SSE events
   * (see applySseEvent); cleared by `permission.replied`, session switch,
   * and session deletion.
   */
  pendingPermissions: PendingPermission[];
  /**
   * Reply to a pending permission. Calls
   * POST /session/{id}/permissions/{permissionID}. No optimistic mutation —
   * server's subsequent `permission.replied` event clears the entry.
   */
  replyPermission: (id: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
```

- [ ] **Step 3: Add initial state**

Locate the `useChatStore = create<ChatStore>((set, get) => ({ ... }))` call (around line 626). Find the existing initial-state literal field `postChatYamlAction: null,` (around line 663). Add immediately after it:

```ts
  pendingPermissions: [],
```

- [ ] **Step 4: Implement replyPermission method body**

Inside the same store literal, add the method. Place it next to the existing `abort` method (near the end of the store literal, around line 1032):

```ts
  async replyPermission(id, reply) {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    try {
      const client = await getOpencodeClient();
      await unwrap(
        client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: id },
          body: { response: reply },
        }),
      );
      // Do NOT remove from pendingPermissions here. The server emits
      // permission.replied as a consequence of this call; applySseEvent
      // removes the entry. Optimistic removal would race with a failed
      // reply and leave the user with no bubble to retry from.
    } catch (err) {
      set({ sendError: `Couldn't reply to permission: ${describeError(err)}` });
    }
  },
```

- [ ] **Step 5: Reset pendingPermissions on session switch**

Three methods need the reset: `selectSession`, `newSession`, `deleteSession`.

**In `selectSession`** (around line 863), add `pendingPermissions: []` to the `set({ ... })` call:

```ts
    set({
      currentSessionId: id,
      messages,
      historyOpen: false,
      sendError: null,
      sending: false,
      pendingUserText: null,
      pendingPermissions: [],
    });
```

**In `newSession`** (around line 882), add to the same `set((prev) => ({ ... }))` call:

```ts
    set((prev) => ({
      sessions: [s, ...prev.sessions],
      currentSessionId: s.id,
      messages: [],
      historyOpen: false,
      sendError: null,
      sending: false,
      pendingUserText: null,
      pendingPermissions: [],
    }));
```

**In `deleteSession`** (around line 896), extend the conditional reset when the deleted session is current. Find:

```ts
    set((prev) => ({
      sessions: prev.sessions.filter((s) => s.id !== id),
      currentSessionId: prev.currentSessionId === id ? null : prev.currentSessionId,
      messages: prev.currentSessionId === id ? [] : prev.messages,
    }));
```

Add `pendingPermissions` with the same conditional shape:

```ts
    set((prev) => ({
      sessions: prev.sessions.filter((s) => s.id !== id),
      currentSessionId: prev.currentSessionId === id ? null : prev.currentSessionId,
      messages: prev.currentSessionId === id ? [] : prev.messages,
      pendingPermissions:
        prev.currentSessionId === id ? [] : prev.pendingPermissions,
    }));
```

- [ ] **Step 6: Run tests to verify no regressions**

```bash
cd apps/editor && bun test
```
Expected: PASS for all existing tests + the 5 helper tests from Task 1. No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
cd apps/editor
git add src/store/chat-store.ts
git commit -m "feat(chat): wire pendingPermissions state and replyPermission method"
cd ../..
```

---

### Task 3: Extend applySseEvent with permission events

**Files:**
- Modify: `apps/editor/src/store/chat-store.ts`

- [ ] **Step 1: Locate the applySseEvent switch statement**

The function starts around line 469, `function applySseEvent(event, get, set)`. The switch covers `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed`, `session.idle`, `session.error`, `session.status`, `session.created`, `session.updated`, `session.deleted`, and a `default` branch.

- [ ] **Step 2: Add permission.updated case**

Insert **before** the `default:` case (currently around line 614):

```ts
    case 'permission.updated': {
      const perm = event.properties;
      if (perm.sessionID !== currentSessionId) return;
      // opencode emits permission.updated on both initial request and on
      // server-side state changes. Treat it as source of truth: upsert the
      // entry keyed by id. Terminal clears come from permission.replied.
      const next = upsertPermission(state.pendingPermissions, {
        id: perm.id,
        sessionID: perm.sessionID,
        title: perm.title,
        tool: perm.type,
        metadata: perm.metadata,
        createdAt: perm.time?.created ?? Date.now(),
      });
      set({ pendingPermissions: next });
      return;
    }
```

- [ ] **Step 3: Add permission.replied case**

Immediately after the case added in Step 2:

```ts
    case 'permission.replied': {
      const { sessionID, permissionID } = event.properties;
      if (sessionID !== currentSessionId) return;
      // Any client (this panel, a parallel CLI) replying resolves the prompt.
      // Remove regardless of who replied so the bubble disappears.
      set({
        pendingPermissions: removePermission(state.pendingPermissions, permissionID),
      });
      return;
    }
```

- [ ] **Step 4: Run the test suite to catch type regressions**

```bash
cd apps/editor && bun test
```
Expected: PASS for everything. No TypeScript errors — the two new `case` labels are narrowed automatically by the `OpencodeEvent` discriminated union.

- [ ] **Step 5: Commit**

```bash
cd apps/editor
git add src/store/chat-store.ts
git commit -m "feat(chat): handle permission.updated/replied SSE events"
cd ../..
```

---

### Task 4: PermissionBubble component

**Files:**
- Create: `apps/editor/src/components/chat/PermissionBubble.tsx`

This task has no unit tests (following the repo's existing pattern — components are covered by the smoke test in Task 6).

- [ ] **Step 1: Read the YamlActionBubble implementation for styling reference**

Open `apps/editor/src/components/chat/ChatPanel.tsx` around line 642 and read the full `YamlActionBubble` component. Note its wrapper div classes, button styles, and layout — match them verbatim in the new component so the two bubbles share visual language.

- [ ] **Step 2: Create PermissionBubble.tsx**

Create `apps/editor/src/components/chat/PermissionBubble.tsx`:

```tsx
import { useState } from 'react';
import { ShieldCheck, Check, Infinity as InfinityIcon, X } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { PendingPermission } from '../../utils/permission-store-helpers';

interface PermissionBubbleProps {
  permission: PendingPermission;
}

/**
 * Inline prompt for an opencode tool-permission request. Rendered at the end
 * of the chat stream after YamlActionBubble; appears until the server emits
 * permission.replied (which applySseEvent in chat-store removes from state).
 *
 * No client-side timeout — opencode's server-side timeout is authoritative.
 * Buttons disable while a reply is in flight so double-click doesn't fire
 * two POSTs; re-enabled on failure so retry works.
 */
export function PermissionBubble({ permission }: PermissionBubbleProps) {
  const reply = useChatStore((s) => s.replyPermission);
  const [pending, setPending] = useState<null | 'once' | 'always' | 'reject'>(null);

  const onClick = async (response: 'once' | 'always' | 'reject') => {
    if (pending) return;
    setPending(response);
    try {
      await reply(permission.id, response);
    } finally {
      // Whether server removes the entry (on success) or keeps it (on
      // failure — replyPermission sets sendError and doesn't throw),
      // the button must re-enable so the user can act again.
      setPending(null);
    }
  };

  const disabled = pending !== null;

  return (
    <div className="max-w-[90%] self-start px-3 py-2 border border-tagma-border bg-tagma-elevated">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={12} className="text-tagma-warning shrink-0" />
        <span className="text-[11px] font-medium text-tagma-text">
          Permission required
        </span>
        <span className="text-[10px] font-mono text-tagma-muted truncate">
          {permission.tool}
        </span>
      </div>

      <div className="text-[12px] text-tagma-text mb-2 break-words">
        {permission.title}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('once')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-success border border-tagma-success/30 hover:bg-tagma-success/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={11} />
          <span>{pending === 'once' ? 'Replying…' : 'Allow once'}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('always')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-accent border border-tagma-accent/30 hover:bg-tagma-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <InfinityIcon size={11} />
          <span>{pending === 'always' ? 'Replying…' : 'Always for this chat'}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('reject')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-error border border-tagma-error/30 hover:bg-tagma-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <X size={11} />
          <span>{pending === 'reject' ? 'Replying…' : 'Reject'}</span>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/editor && bun test
```
Expected: PASS — imports resolve, no TS errors.

If the YamlActionBubble styling you read in Step 1 uses different class names (e.g. `max-w-[85%]` vs `max-w-[90%]` after the recent bubble-width spec lands, or different tone tokens), adjust the className strings above to match — the goal is visual consistency, not exact-text copy.

- [ ] **Step 4: Commit**

```bash
cd apps/editor
git add src/components/chat/PermissionBubble.tsx
git commit -m "feat(chat): add PermissionBubble component for tool-permission prompts"
cd ../..
```

---

### Task 5: Wire PermissionBubble into ChatPanel

**Files:**
- Modify: `apps/editor/src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: Import the component**

Locate the existing imports at the top of `ChatPanel.tsx`. Add:

```ts
import { PermissionBubble } from './PermissionBubble';
```

- [ ] **Step 2: Subscribe to pendingPermissions in the main panel component**

Find the existing `useChatStore` selector block in the main `ChatPanel` component (the one that selects `messages`, `sending`, `pendingUserText`, `sessionId`, `postChatYamlAction` — around line 543). Add the new selector right after `postChatYamlAction`:

```ts
  const pendingPermissions = useChatStore((s) => s.pendingPermissions);
```

- [ ] **Step 3: Render the bubbles after YamlActionBubble**

Locate the render block that contains:

```tsx
{showPending && <PendingUserBubble text={pendingUserText!} />}
{sending && <ThinkingBubble />}
{postChatYamlAction && !sending && <YamlActionBubble />}
```

(Around line 634-636.) Append immediately after `YamlActionBubble`:

```tsx
{pendingPermissions.map((p) => (
  <PermissionBubble key={p.id} permission={p} />
))}
```

The resulting block should read:

```tsx
{showPending && <PendingUserBubble text={pendingUserText!} />}
{sending && <ThinkingBubble />}
{postChatYamlAction && !sending && <YamlActionBubble />}
{pendingPermissions.map((p) => (
  <PermissionBubble key={p.id} permission={p} />
))}
```

Rationale for position: permission bubbles go last because they're the thing the user must act on next — placing them below `YamlActionBubble` keeps the "newest thing needing attention" at the bottom of the stream, next to the composer.

- [ ] **Step 4: Verify compilation**

```bash
cd apps/editor && bun test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/editor
git add src/components/chat/ChatPanel.tsx
git commit -m "feat(chat): render PermissionBubble list in chat stream"
cd ../..
```

---

### Task 6: Manual smoke test

This verifies the whole flow end-to-end against a real opencode session. No commit.

- [ ] **Step 1: Start the dev environment**

From repo root:
```bash
cd apps/editor && bun run dev
```
Wait for both the Vite client and the Bun server to report ready. Open the UI in a browser at the Vite-reported URL.

- [ ] **Step 2: Trigger a permission prompt**

Open a workspace, open a `.tagma/*.yaml`, and in the chat panel type a request that causes the agent to call an `ask`-gated tool. The `tagma-yaml` agent's default tool gating (via `.opencode/agent/tagma-yaml.md`) ensures the `edit` tool fires permission checks on YAML edits. A prompt such as:

> "Add a dummy `noop` task at the top of the first track."

should produce a `permission.updated` event when the agent tries to edit the YAML.

Expected: a `PermissionBubble` renders inline at the bottom of the chat stream, showing:
- `Permission required` header with shield icon and tool name (`edit`)
- The title (e.g. `Edit .tagma/foo.yaml`)
- Three buttons: `Allow once`, `Always for this chat`, `Reject`

- [ ] **Step 3: Verify Allow once**

Click `Allow once`. Expected: button shows `Replying…` briefly, then the bubble disappears, the tool call completes, the YAML is edited, and the model continues generating.

- [ ] **Step 4: Verify Always for this chat**

Prompt another edit to the same YAML. On the permission bubble, click `Always for this chat`. Expected: the bubble disappears, the tool executes. Send another edit request → no new bubble appears (always-allow held server-side for the session).

- [ ] **Step 5: Verify Reject**

Start a new session (chat history → "New session" or equivalent). Trigger another edit-requiring prompt. When the bubble appears, click `Reject`. Expected: the bubble disappears, the agent's turn continues with a rejection message, no YAML changes are written.

- [ ] **Step 6: Verify session-switch clears**

Trigger a permission prompt but do not click any button. Open session history and switch to a different session. Return to the first session. Expected: the bubble is NOT present (cleared on switch per Task 2's session-reset changes). A fresh prompt on the first session starts clean.

- [ ] **Step 7: Verify session-delete clears**

Trigger a permission prompt. Delete the current session from history. Expected: bubble clears with no residual state in the store.

- [ ] **Step 8: Record results**

If any of Steps 3–7 fail, open an issue against the submodule with the reproduction and the failing step number. If all pass, proceed to Task 7.

---

### Task 7: Bump submodule pointer in tagma-mono

**Files:**
- Modify: `apps` submodule pointer in parent repo

- [ ] **Step 1: From repo root, confirm submodule is ahead**

```bash
cd D:/tagma/tagma-mono
git status
```
Expected output includes:
```
modified:   apps (new commits)
```

- [ ] **Step 2: Stage and commit the pointer bump**

```bash
git add apps
git commit -m "chore(apps): bump submodule pointer for chat permission UI"
```

- [ ] **Step 3: Final smoke check**

```bash
git log -1 --stat
```
Expected: one file changed — `apps` — showing the submodule SHA update.

---

## Completion criteria

- All seven tasks ticked.
- `bun test` passes in `apps/editor`.
- Task 6 manual smoke test completed successfully for all five sub-scenarios (allow, always, reject, session-switch, session-delete).
- Submodule pointer committed in parent repo.

No further changes required to `tagma-mono` outside the submodule pointer.
