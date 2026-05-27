/**
 * Tool-permission policy for the bot bridge.
 *
 * opencode emits a `permission.updated` event for every tool call that wants
 * confirmation. For the bot we split tools into two classes:
 *
 *   - auto-allow   : reads + queries. Safe to silently approve since the
 *                    worst case is the model peeking at code it could already
 *                    read by listing files.
 *   - needs-approval : writes, mutating edits, shell, network fetch. We send
 *                      a Telegram inline-keyboard "Approve / Deny" and wait
 *                      for a human tap before letting the agent continue.
 *
 * Unknown tools default to `needs-approval`. That's the safe side: a new
 * opencode build adding a power tool we haven't classified yet still asks
 * the user before executing. Update this file when you add a new auto-allow
 * tool — don't widen by removing the default.
 *
 * The classification is deliberately lower-case + suffix-tolerant:
 *   `Read` / `read` / `file_read` / `fs.read` all map to read-class.
 */

export type ToolClass = 'auto-allow' | 'needs-approval';

/**
 * Substrings that mark a tool as read-class. Matched case-insensitively
 * against the tool name. Order doesn't matter — first hit wins.
 */
const READ_CLASS_HINTS: readonly string[] = [
  'read',
  'view',
  'list',
  'glob',
  'grep',
  'search',
  'find',
  'todo_read',
  'todoread',
  'fetch_metadata',
  'inspect',
];

/**
 * Substrings that mark a tool as write/exec-class. Wins over read hints when
 * both match (e.g., "edit" inside "edit_preview" is genuinely a write so we
 * land here regardless). Anything that mutates the workspace, runs a shell,
 * or makes a network call belongs here.
 */
const WRITE_CLASS_HINTS: readonly string[] = [
  'bash',
  'shell',
  'exec',
  'run',
  'write',
  'edit',
  'patch',
  'delete',
  'remove',
  'rm',
  'mv',
  'move',
  'rename',
  'create',
  'multiedit',
  'multi_edit',
  'todo_write',
  'todowrite',
  'webfetch',
  'web_fetch',
  'curl',
  'http',
  'commit',
  'push',
  'merge',
  'rebase',
];

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Classify a tool by its opencode `type` (or any string name). Tools that
 * match a write hint are `needs-approval`; tools that match only read hints
 * are `auto-allow`; everything else is `needs-approval` (default-deny).
 */
export function classifyTool(name: string | null | undefined): ToolClass {
  if (!name) return 'needs-approval';
  const norm = normalize(name);
  for (const hint of WRITE_CLASS_HINTS) {
    if (norm.includes(normalize(hint))) return 'needs-approval';
  }
  for (const hint of READ_CLASS_HINTS) {
    if (norm.includes(normalize(hint))) return 'auto-allow';
  }
  return 'needs-approval';
}

/**
 * Short human label rendered in the Telegram approval prompt. We keep this
 * tight — Telegram inline-keyboard buttons get a small message attached and
 * a long tool description pushes the buttons below the fold on phones.
 */
export function renderPermissionPrompt(toolName: string, title: string | undefined): string {
  const head = title && title.trim().length > 0 ? title.trim() : toolName;
  // Truncate to keep the bubble single-screen on a phone.
  const trimmed = head.length > 200 ? head.slice(0, 200) + '…' : head;
  return `🔐 Tool needs approval: \`${toolName}\`\n\n${trimmed}`;
}
