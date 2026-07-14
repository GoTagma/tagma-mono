import type express from 'express';

import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
  finalizeChatYamlStage,
  listChatYamlStage,
  type ChatYamlStageFinalizeInput,
} from '../chat-yaml-staging.js';
import { errorMessage } from '../path-utils.js';
import { requireWorkspace } from '../require-workspace.js';
import {
  canBypassYamlEditLock,
  getActiveYamlEditLock,
  publicYamlEditLock,
} from '../yaml-edit-lock.js';
import type { WorkspaceState } from '../workspace-state.js';

type FinalizeLocalBranch = NonNullable<ChatYamlStageFinalizeInput['localBranch']>;

function asRequestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object.');
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function parseLocalBranch(value: unknown): FinalizeLocalBranch | null | undefined {
  if (value === undefined || value === null) return value;
  const branch = asRequestRecord(value);
  if (typeof branch.sourcePath !== 'string' || !branch.sourcePath.trim()) {
    throw new Error('localBranch.sourcePath is required.');
  }
  if (typeof branch.yaml !== 'string') {
    throw new Error('localBranch.yaml must be a string.');
  }
  if (
    branch.layout !== undefined &&
    branch.layout !== null &&
    (typeof branch.layout !== 'object' || Array.isArray(branch.layout))
  ) {
    throw new Error('localBranch.layout must be an object or null.');
  }
  const changed = optionalBoolean(branch.changed, 'localBranch.changed');
  return {
    sourcePath: branch.sourcePath.trim(),
    yaml: branch.yaml,
    ...(branch.layout !== undefined
      ? { layout: branch.layout as FinalizeLocalBranch['layout'] }
      : {}),
    ...(changed !== undefined ? { changed } : {}),
  };
}

function parseFinalizeInput(value: unknown): ChatYamlStageFinalizeInput {
  const body = asRequestRecord(value);
  if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
    throw new Error('stageId is required.');
  }
  if (typeof body.relativePath !== 'string' || !body.relativePath.trim()) {
    throw new Error('relativePath is required.');
  }
  const forceFork = optionalBoolean(body.forceFork, 'forceFork');
  const allowInvalid = optionalBoolean(body.allowInvalid, 'allowInvalid');
  const localBranch = parseLocalBranch(body.localBranch);
  const forceForkReason = body.forceForkReason;
  if (
    forceForkReason !== undefined &&
    forceForkReason !== 'path-moved' &&
    forceForkReason !== 'compile-failed'
  ) {
    throw new Error('forceForkReason must be path-moved or compile-failed.');
  }
  return {
    stageId: body.stageId.trim(),
    relativePath: body.relativePath.trim(),
    ...(localBranch !== undefined ? { localBranch } : {}),
    ...(forceFork !== undefined ? { forceFork } : {}),
    ...(forceForkReason !== undefined ? { forceForkReason } : {}),
    ...(allowInvalid !== undefined ? { allowInvalid } : {}),
  };
}

function requireChatYamlStageLock(
  req: express.Request,
  res: express.Response,
  ws: WorkspaceState,
): boolean {
  const lock = getActiveYamlEditLock(ws);
  if (lock && canBypassYamlEditLock(lock, req.get('X-Tagma-Yaml-Lock-Id'))) {
    return true;
  }
  res.status(423).json({
    error: 'An active OpenCode YAML edit lock is required for chat staging.',
    lock: publicYamlEditLock(lock),
  });
  return false;
}

function stageErrorStatus(err: unknown): number {
  const message = errorMessage(err).toLowerCase();
  if (message.includes('not found')) return 404;
  if (
    message.includes('invalid') ||
    message.includes('required') ||
    message.includes('must ') ||
    message.includes('outside') ||
    message.includes('already finalized') ||
    message.includes('did not compile')
  ) {
    return 400;
  }
  return 500;
}

function respondStageError(res: express.Response, err: unknown): express.Response {
  return res.status(stageErrorStatus(err)).json({ error: errorMessage(err) });
}

export function registerChatYamlStagingRoutes(app: express.Express): void {
  app.post('/api/workspace/chat-yaml-stage/start', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { activePath?: unknown };
    if (
      body.activePath !== undefined &&
      body.activePath !== null &&
      typeof body.activePath !== 'string'
    ) {
      return res.status(400).json({ error: 'activePath must be a string or null.' });
    }
    try {
      return res.json(
        createChatYamlStage(ws, {
          activePath: typeof body.activePath === 'string' ? body.activePath : null,
        }),
      );
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/list', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { stageId?: unknown };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    try {
      return res.json(listChatYamlStage(ws, body.stageId.trim()));
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/compile', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { stageId?: unknown; relativePath?: unknown };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    if (typeof body.relativePath !== 'string' || !body.relativePath.trim()) {
      return res.status(400).json({ error: 'relativePath is required.' });
    }
    try {
      return res.json(compileChatYamlStage(ws, body.stageId.trim(), body.relativePath.trim()));
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/finalize', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    try {
      return res.json(finalizeChatYamlStage(ws, parseFinalizeInput(req.body)));
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/discard', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { stageId?: unknown };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    try {
      return res.json({ discarded: discardChatYamlStage(ws, body.stageId.trim()) });
    } catch (err) {
      return respondStageError(res, err);
    }
  });
}
