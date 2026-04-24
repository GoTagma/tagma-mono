# OpenCode Chat Bubble Width Cap

**Date:** 2026-04-25
**Scope:** `apps/editor/src/components/chat/ChatPanel.tsx`
**Type:** UI fix

## Problem

In the OpenCode chat panel, user-typed content can extend past the right edge of the panel, ignoring the bubble's intended width cap. The assistant bubble occasionally has the same symptom when the reply contains a long unbreakable token (e.g. a URL).

Root cause is two independent bugs on the user side:

1. The wrapping container uses `max-w-[85%]`, but the inner text element has only `whitespace-pre-wrap` — which preserves whitespace and wraps at soft breaks, but does NOT break long unbreakable tokens. A pasted URL or a space-less CJK run therefore pushes the bubble beyond its `max-w-[85%]` parent and visually overflows the panel.
2. The user asked for a 90% width cap, but the current value is 85%. (Unrelated to overflow, but part of the stated requirement.)

The assistant markdown bubble is largely fine already: `.chat-markdown` in `index.css` sets `overflow-wrap: break-word` and `pre { overflow-x: auto; max-width: 100% }`, so prose wraps and code blocks scroll horizontally. The only thing it shares with the user bubble is the 85% → 90% cap.

## Goal

Cap both user and assistant message bubbles at **90% of the chat panel width**, and guarantee that no content — user text, assistant prose, or assistant code — ever visually overflows the bubble's right edge.

## Changes

All in `apps/editor/src/components/chat/ChatPanel.tsx`. No CSS file changes required.

### 1. Raise the bubble width cap from 85% to 90%

Four locations, one-to-one replacements of `max-w-[85%]` → `max-w-[90%]`:

| Line (approx) | Component            | Role           |
|---------------|----------------------|----------------|
| 680           | `YamlActionBubble`   | assistant-side |
| 720           | `PendingUserBubble`  | user-side      |
| 742           | `ThinkingBubble`     | assistant-side |
| 799           | `MessageBubble`      | both roles     |

### 2. Force user text to wrap inside its bubble

Add Tailwind's `break-words` (CSS `overflow-wrap: break-word`) to the user text element:

- **Line 866** (`PartRenderer`, user branch): append `break-words` to the existing classes.
- **Line 721** (`PendingUserBubble` text element): append `break-words` — the pending bubble must behave identically to the settled user bubble so there is no visual jump when the optimistic message is replaced by the server copy.

No change to `whitespace-pre-wrap` — the user's whitespace and line breaks must still be preserved verbatim.

### 3. Assistant markdown — no change

`.chat-markdown` in `apps/editor/src/index.css` already handles:
- prose wrapping (`overflow-wrap: break-word; word-break: break-word`)
- inline code wrapping (`word-break: break-all`)
- fenced code block horizontal scroll (`pre { overflow-x: auto; max-width: 100% }`)
- table horizontal scroll (`table { display: block; overflow-x: auto; max-width: 100% }`)

Code blocks already match Option B (internal horizontal scroll, not hard-wrap). Leave as-is.

## Non-goals

- No change to the chat panel's outer width, padding, or layout.
- No change to the composer textarea width (`flex-1` is correct — it fills the row).
- No refactor to deduplicate `max-w-[90%]` into a shared constant. Four call sites is under the three-lines-is-better-than-abstraction threshold.

## Testing

Manual verification in the Electron app with a running OpenCode session:

1. Paste a 300-character URL into the composer and send. User bubble must stay within 90% width; the URL must wrap (break inside the token) rather than extend past the panel edge.
2. Send a message containing a long space-less CJK run (e.g. 100 Chinese characters with no punctuation). Same expectation.
3. Ask the assistant for a reply containing a fenced code block with lines wider than the bubble. The bubble must stay within 90%, and the code block must scroll horizontally inside the bubble.
4. The pending (optimistic) user bubble and the settled user bubble must visually match — same width cap, same wrapping behavior — so there is no flicker when the server copy arrives.
5. Resize the panel (drag the right-dock handle) at a few widths, including very narrow. Bubbles must continue to respect the 90% cap and wrap correctly at every width.

## Rollback

Single-file, CSS-class-only diff. Revert the commit to restore the prior behavior.
