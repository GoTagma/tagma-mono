import { relative } from 'node:path';
import { isPathWithin } from '../path-utils';
import {
  executionTargetsFromMetadata,
  readTargetFromPattern,
  targetFromPattern,
  containsSymlinkAncestor,
} from '../chat-yaml-write-policy';
import {
  CHAT_PERMISSION_TARGET_LIMIT,
  isChatPermissionTargetSummary,
  type ChatPermissionTargetSummary,
} from '../../shared/chat-permission-targets';

/** Describes only targets proved inside the existing staged root; it grants no access. */
export function describeChatPermissionTargets(input: {
  readonly permission: string;
  readonly patterns: readonly string[];
  readonly metadata?: unknown;
  readonly workDir: string;
  readonly agentRoot: string;
}): ChatPermissionTargetSummary | undefined {
  if (
    !['read', 'edit', 'write', 'external_directory'].includes(input.permission) ||
    input.patterns.length > 256
  )
    return;
  const metadata = ['edit', 'write'].includes(input.permission)
    ? executionTargetsFromMetadata(input.metadata)
    : null;
  if (metadata?.reason) return;
  const targets =
    metadata?.targets ??
    input.patterns.map((pattern) => {
      if (['?', '*', '{', '}', '[', ']'].some((character) => pattern.includes(character)))
        return null;
      return input.permission === 'read'
        ? readTargetFromPattern(pattern, input.workDir, input.agentRoot)
        : targetFromPattern(pattern);
    });
  if (
    targets.length === 0 ||
    targets.length > 256 ||
    targets.some(
      (target) =>
        !target ||
        !isPathWithin(target, input.agentRoot) ||
        containsSymlinkAncestor(target, input.agentRoot),
    )
  )
    return;
  const labels = [
    ...new Set(
      targets.map(
        (target) => relative(input.agentRoot, target!).replace(/\\/g, '/') || '(draft root)',
      ),
    ),
  ];
  const visible: string[] = [];
  for (const label of labels) {
    if (
      visible.length < CHAT_PERMISSION_TARGET_LIMIT &&
      isChatPermissionTargetSummary({ targets: [label], omitted: 0 })
    )
      visible.push(label);
  }
  return { targets: visible, omitted: labels.length - visible.length };
}
