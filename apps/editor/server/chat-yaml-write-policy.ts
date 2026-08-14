import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { resolveChatYamlStageAgentRoot } from './chat-yaml-staging.js';
import { isPathWithin } from './path-utils.js';
import type { WorkspaceState } from './workspace-state.js';

export interface ChatYamlStagePathAuthorizationInput {
  stageId: string;
  permission: string;
  patterns: readonly string[];
  metadata?: unknown;
}

export interface ChatYamlStagePathAuthorizationResult {
  allowed: boolean;
  reason: string | null;
}

const PATH_SCOPED_PERMISSIONS = new Set(['edit', 'write', 'external_directory']);
const UNSCOPED_WRITE_PERMISSIONS = new Set(['bash', 'shell']);
const INVALID_EXECUTION_METADATA_REASON =
  'The staged write execution metadata must identify only absolute execution targets.';

type ExecutionTargetsResult =
  { targets: string[]; reason: null } | { targets: null; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactExecutionTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const target = value.trim();
  if (!target || target.includes('\0') || !isAbsolute(target)) return null;
  return resolve(target);
}

/**
 * OpenCode's edit/write permission patterns are relative to its worktree,
 * even when the tool will execute against an absolute filePath. The absolute
 * execution target is carried separately in metadata.filepath. apply_patch
 * carries every source/destination in metadata.files instead.
 */
function executionTargetsFromMetadata(metadata: unknown): ExecutionTargetsResult | null {
  if (metadata === undefined || metadata === null) return null;
  if (!isRecord(metadata)) {
    return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
  }

  if (hasOwn(metadata, 'files')) {
    if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
      return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
    }
    const targets: string[] = [];
    for (const file of metadata.files) {
      if (!isRecord(file)) {
        return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
      }
      const filePath = exactExecutionTarget(file.filePath);
      if (!filePath) {
        return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
      }
      targets.push(filePath);
      if (hasOwn(file, 'movePath') && file.movePath !== null && file.movePath !== undefined) {
        const movePath = exactExecutionTarget(file.movePath);
        if (!movePath) {
          return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
        }
        targets.push(movePath);
      }
    }
    if (hasOwn(metadata, 'filepath')) {
      if (
        typeof metadata.filepath !== 'string' ||
        !metadata.filepath.trim() ||
        metadata.filepath.includes('\0')
      ) {
        return { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
      }
      // apply_patch uses filepath as a relative display summary. If a future
      // or malformed event also advertises an absolute filepath, validate it
      // alongside every authoritative files entry instead of letting files
      // mask a contradictory execution target.
      const absoluteFilepath = exactExecutionTarget(metadata.filepath);
      if (absoluteFilepath) targets.push(absoluteFilepath);
    }
    return { targets, reason: null };
  }

  if (hasOwn(metadata, 'filepath')) {
    const filepath = exactExecutionTarget(metadata.filepath);
    return filepath
      ? { targets: [filepath], reason: null }
      : { targets: null, reason: INVALID_EXECUTION_METADATA_REASON };
  }

  return null;
}

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
  const agentRoot = resolveChatYamlStageAgentRoot(ws, input.stageId);
  const metadataTargets =
    permission === 'edit' || permission === 'write'
      ? executionTargetsFromMetadata(input.metadata)
      : null;
  if (metadataTargets?.reason) {
    return { allowed: false, reason: metadataTargets.reason };
  }

  const targets: string[] = metadataTargets?.targets ?? [];
  if (targets.length === 0) {
    if (input.patterns.length === 0) {
      return { allowed: false, reason: 'The staged write request did not identify a target path.' };
    }
    for (const pattern of input.patterns) {
      const target = targetFromPattern(pattern);
      if (!target) {
        return {
          allowed: false,
          reason:
            'The staged write target must be an absolute path under this turn agent root and must not contain an unbounded path pattern.',
        };
      }
      targets.push(target);
    }
  }

  for (const target of targets) {
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
