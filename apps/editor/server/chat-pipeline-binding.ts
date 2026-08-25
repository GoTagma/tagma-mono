import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import type { WorkspaceState } from './workspace-state.js';
import {
  enumerateFlatPipelineYamls,
  enumeratePipelineYamls,
  tagmaDirOf,
} from './pipeline-paths.js';
import {
  ensureServerRecordControlRootSync,
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from './server-record-auth.js';
import type { ChatPipelineRouteIntent } from '../shared/requested-action.js';

const BINDING_DIRECTORY = '.chat-pipeline-bindings';
const BINDING_RECORD_FILE = 'bindings.json';
const BINDING_REGISTRY_VERSION = 1;
const BINDING_VERSION = 1;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface ChatPipelineBinding {
  version: typeof BINDING_VERSION;
  id: string;
  sessionId: string;
  bindingRequestId: string;
  intent: ChatPipelineRouteIntent;
  originRelativePath: string | null;
  targetRelativePath: string;
  createdAt: number;
}

interface ChatPipelineBindingRegistry {
  version: typeof BINDING_REGISTRY_VERSION;
  bindings: ChatPipelineBinding[];
}

export interface ReserveChatPipelineBindingInput {
  sessionId: string;
  bindingRequestId: string;
  intent: ChatPipelineRouteIntent;
  originRelativePath: string | null;
  forceNew?: boolean;
}

function portableRelative(root: string, target: string): string {
  const value = relative(root, target);
  if (!value || value.startsWith('..') || isAbsolute(value)) {
    throw new Error('Pipeline binding target is outside the workspace .tagma directory.');
  }
  return value.replace(/\\/g, '/');
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Pipeline binding relative path is invalid.');
  }
  return normalized;
}

function pathIdentity(value: string): string {
  const normalized = normalizeRelativePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function bindingPaths(ws: WorkspaceState): {
  controlRoot: string;
  recordPath: string;
  context: ServerRecordContext;
} {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const workspaceTagmaDir = tagmaDirOf(ws.workDir);
  const controlRoot = join(workspaceTagmaDir, BINDING_DIRECTORY);
  return {
    controlRoot,
    recordPath: join(controlRoot, BINDING_RECORD_FILE),
    context: {
      workspaceTagmaDir,
      controlRoot,
      stageId: 'workspace-chat-pipeline-bindings',
      kind: 'chat-bindings',
    },
  };
}

export function parseChatPipelineBinding(value: unknown): ChatPipelineBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat pipeline binding registry is invalid.');
  }
  const binding = value as Partial<ChatPipelineBinding>;
  if (
    binding.version !== BINDING_VERSION ||
    typeof binding.id !== 'string' ||
    !ID_RE.test(binding.id) ||
    typeof binding.sessionId !== 'string' ||
    !ID_RE.test(binding.sessionId) ||
    typeof binding.bindingRequestId !== 'string' ||
    !ID_RE.test(binding.bindingRequestId) ||
    (binding.intent !== 'create' && binding.intent !== 'edit') ||
    (binding.originRelativePath !== null && typeof binding.originRelativePath !== 'string') ||
    typeof binding.targetRelativePath !== 'string' ||
    typeof binding.createdAt !== 'number' ||
    !Number.isFinite(binding.createdAt)
  ) {
    throw new Error('Chat pipeline binding registry is invalid.');
  }
  return {
    version: BINDING_VERSION,
    id: binding.id,
    sessionId: binding.sessionId,
    bindingRequestId: binding.bindingRequestId,
    intent: binding.intent,
    originRelativePath:
      binding.originRelativePath === null
        ? null
        : normalizeRelativePath(binding.originRelativePath),
    targetRelativePath: normalizeRelativePath(binding.targetRelativePath),
    createdAt: binding.createdAt,
  };
}

function readRegistry(ws: WorkspaceState): ChatPipelineBindingRegistry {
  const paths = bindingPaths(ws);
  if (!existsSync(paths.recordPath)) return { version: BINDING_REGISTRY_VERSION, bindings: [] };
  const raw = readAuthenticatedServerRecordSync<Partial<ChatPipelineBindingRegistry>>(
    paths.recordPath,
    paths.context,
  );
  if (raw.version !== BINDING_REGISTRY_VERSION || !Array.isArray(raw.bindings)) {
    throw new Error('Chat pipeline binding registry is invalid.');
  }
  const bindings = raw.bindings.map(parseChatPipelineBinding);
  const ids = new Set<string>();
  const requests = new Set<string>();
  const targets = new Set<string>();
  for (const binding of bindings) {
    const requestKey = `${binding.sessionId}\0${binding.bindingRequestId}`;
    const targetKey = pathIdentity(binding.targetRelativePath);
    if (ids.has(binding.id) || requests.has(requestKey) || targets.has(targetKey)) {
      throw new Error('Chat pipeline binding registry contains duplicate ownership.');
    }
    ids.add(binding.id);
    requests.add(requestKey);
    targets.add(targetKey);
  }
  return { version: BINDING_REGISTRY_VERSION, bindings };
}

function writeRegistry(ws: WorkspaceState, registry: ChatPipelineBindingRegistry): void {
  const paths = bindingPaths(ws);
  ensureServerRecordControlRootSync(paths.context);
  writeAuthenticatedServerRecordSync(paths.recordPath, paths.context, registry);
}

function reserveTargetRelativePath(
  ws: WorkspaceState,
  registry: ChatPipelineBindingRegistry,
): string {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const tagmaDir = tagmaDirOf(ws.workDir);
  const unavailable = new Set(
    [
      ...enumeratePipelineYamls(ws.workDir).map((entry) =>
        portableRelative(tagmaDir, entry.yamlPath),
      ),
      ...enumerateFlatPipelineYamls(ws.workDir).map((entry) =>
        portableRelative(tagmaDir, entry.yamlPath),
      ),
      ...registry.bindings.map((binding) => binding.targetRelativePath),
    ].map(pathIdentity),
  );
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const stem = `pipeline-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const candidate = `${stem}/${stem}.yaml`;
    if (!unavailable.has(pathIdentity(candidate))) return candidate;
  }
  throw new Error('Could not reserve a unique Chat-owned pipeline target.');
}

export function readChatPipelineBinding(
  ws: WorkspaceState,
  bindingId: string,
): ChatPipelineBinding | null {
  if (!ID_RE.test(bindingId)) throw new Error('Chat pipeline binding identity is invalid.');
  return readRegistry(ws).bindings.find((binding) => binding.id === bindingId) ?? null;
}

export function rebindChatPipelineBindingTarget(
  ws: WorkspaceState,
  bindingId: string,
  targetRelativePath: string,
): ChatPipelineBinding {
  if (!ID_RE.test(bindingId)) throw new Error('Chat pipeline binding identity is invalid.');
  const registry = readRegistry(ws);
  const index = registry.bindings.findIndex((binding) => binding.id === bindingId);
  if (index < 0) throw new Error('Chat pipeline binding was not found.');
  const normalizedTarget = normalizeRelativePath(targetRelativePath);
  if (
    registry.bindings.some(
      (binding, bindingIndex) =>
        bindingIndex !== index &&
        pathIdentity(binding.targetRelativePath) === pathIdentity(normalizedTarget),
    )
  ) {
    throw new Error('Chat pipeline binding target is already owned by another session.');
  }
  const rebound: ChatPipelineBinding = {
    ...registry.bindings[index]!,
    targetRelativePath: normalizedTarget,
  };
  const bindings = [...registry.bindings];
  bindings[index] = rebound;
  writeRegistry(ws, { version: BINDING_REGISTRY_VERSION, bindings });
  return rebound;
}

export function relocateChatPipelineBindingTarget(
  ws: WorkspaceState,
  bindingId: string,
): ChatPipelineBinding {
  if (!ID_RE.test(bindingId)) throw new Error('Chat pipeline binding identity is invalid.');
  const registry = readRegistry(ws);
  const index = registry.bindings.findIndex((binding) => binding.id === bindingId);
  if (index < 0) throw new Error('Chat pipeline binding was not found.');
  const targetRelativePath = reserveTargetRelativePath(ws, registry);
  return rebindChatPipelineBindingTarget(ws, bindingId, targetRelativePath);
}

/**
 * Atomically reserve one writable pipeline instance for a semantic authoring
 * request. Different sessions may share an origin, never a target. A session
 * reuses its own target only when it explicitly edits that target again.
 */
export function reserveChatPipelineBinding(
  ws: WorkspaceState,
  input: ReserveChatPipelineBindingInput,
): ChatPipelineBinding {
  if (!ID_RE.test(input.sessionId) || !ID_RE.test(input.bindingRequestId)) {
    throw new Error('Chat pipeline binding identity is invalid.');
  }
  const originRelativePath =
    input.originRelativePath === null ? null : normalizeRelativePath(input.originRelativePath);
  if (input.intent === 'edit' && originRelativePath === null) {
    throw new Error('An edit binding requires an inventoried origin pipeline.');
  }
  if (input.intent === 'create' && originRelativePath !== null) {
    throw new Error('A create binding cannot claim an inventoried origin pipeline.');
  }

  const registry = readRegistry(ws);
  const priorRequest = registry.bindings.find(
    (binding) =>
      binding.sessionId === input.sessionId && binding.bindingRequestId === input.bindingRequestId,
  );
  if (priorRequest) {
    if (
      priorRequest.intent !== input.intent ||
      priorRequest.originRelativePath !== originRelativePath
    ) {
      throw new Error(
        'Chat pipeline binding request identity was reused with different semantics.',
      );
    }
    return priorRequest;
  }

  if (!input.forceNew && input.intent === 'edit' && originRelativePath) {
    const owned = [...registry.bindings]
      .reverse()
      .find(
        (binding) =>
          binding.sessionId === input.sessionId &&
          pathIdentity(binding.targetRelativePath) === pathIdentity(originRelativePath),
      );
    if (owned) return owned;
  }

  const binding: ChatPipelineBinding = {
    version: BINDING_VERSION,
    id: randomUUID(),
    sessionId: input.sessionId,
    bindingRequestId: input.bindingRequestId,
    intent: input.intent,
    originRelativePath,
    targetRelativePath: reserveTargetRelativePath(ws, registry),
    createdAt: Date.now(),
  };
  writeRegistry(ws, {
    version: BINDING_REGISTRY_VERSION,
    bindings: [...registry.bindings, binding],
  });
  return binding;
}
