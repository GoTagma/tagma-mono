import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { resolveChatYamlStageAgentRoot } from './chat-yaml-staging.js';
import { isPathWithin } from './path-utils.js';
import type { WorkspaceState } from './workspace-state.js';

export interface ChatYamlStagePathAuthorizationInput {
  stageId: string;
  permission: string;
  patterns: readonly string[];
}

export interface ChatYamlStagePathAuthorizationResult {
  allowed: boolean;
  reason: string | null;
}

const PATH_SCOPED_PERMISSIONS = new Set(['edit', 'write', 'external_directory']);
const UNSCOPED_WRITE_PERMISSIONS = new Set(['bash', 'shell']);

function targetFromPattern(pattern: string): string | null {
  let target = pattern.trim();
  if (!target || target.includes('\0')) return null;
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1).trim();
  }
  if (['?', '{', '}', '[', ']'].some((character) => target.includes(character))) return null;
  if (target.endsWith('*')) {
    target = target.slice(0, -1).replace(/[\\/]+$/u, '');
  }
  if (!target || target.includes('*')) return null;
  // Descendant OpenCode sessions may retain the live session cwd. Relative
  // tool paths could therefore be authorized against staging but executed
  // against live `.tagma`; staged writers must use the absolute advertised
  // agent-root paths.
  if (!isAbsolute(target)) return null;
  return resolve(target);
}

function containsSymlinkAncestor(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  let cursor = resolve(root);
  for (const segment of rel.split(/[\\/]+/u)) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      break;
    }
  }
  return false;
}

export function authorizeChatYamlStagePaths(
  ws: WorkspaceState,
  input: ChatYamlStagePathAuthorizationInput,
): ChatYamlStagePathAuthorizationResult {
  const permission = input.permission.trim().toLowerCase();
  if (UNSCOPED_WRITE_PERMISSIONS.has(permission)) {
    return {
      allowed: false,
      reason: `The ${permission} capability cannot be safely scoped to this turn's staged agent root.`,
    };
  }
  if (!PATH_SCOPED_PERMISSIONS.has(permission)) {
    return {
      allowed: false,
      reason: `Unsupported staged write permission: ${permission || 'unknown'}.`,
    };
  }
  if (input.patterns.length === 0) {
    return { allowed: false, reason: 'The staged write request did not identify a target path.' };
  }

  const agentRoot = resolveChatYamlStageAgentRoot(ws, input.stageId);
  for (const pattern of input.patterns) {
    const target = targetFromPattern(pattern);
    if (!target) {
      return {
        allowed: false,
        reason:
          'The staged write target must be an absolute path under this turn agent root and must not contain an unbounded path pattern.',
      };
    }
    if (containsSymlinkAncestor(target, agentRoot)) {
      return {
        allowed: false,
        reason: 'The staged write target traverses a symbolic link or junction.',
      };
    }
    if (!isPathWithin(target, agentRoot)) {
      return {
        allowed: false,
        reason: 'The target is outside this turn staged agent root.',
      };
    }
  }
  return { allowed: true, reason: null };
}
