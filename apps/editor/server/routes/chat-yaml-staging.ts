import type express from 'express';

import {
  cancelChatYamlStageFinalize,
  ChatYamlFinalizeWitnessError,
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStageWithDisposition,
  finalizeChatYamlStage,
  listChatYamlStage,
  readFinalizedChatYamlStageResult,
  type ChatYamlStageFinalizeInput,
} from '../chat-yaml-staging.js';
import {
  cancelChatPipelineTrial,
  getChatPipelineTrialProgress,
  trialRunChatYamlStage,
} from '../chat-pipeline-trial-run.js';
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

function parseLocalBranch(
  value: unknown,
  label = 'localBranch',
): FinalizeLocalBranch | null | undefined {
  if (value === undefined || value === null) return value;
  const branch = asRequestRecord(value);
  if (typeof branch.sourcePath !== 'string' || !branch.sourcePath.trim()) {
    throw new Error(`${label}.sourcePath is required.`);
  }
  if (typeof branch.yaml !== 'string') {
    throw new Error(`${label}.yaml must be a string.`);
  }
  if (
    branch.layout !== undefined &&
    branch.layout !== null &&
    (typeof branch.layout !== 'object' || Array.isArray(branch.layout))
  ) {
    throw new Error(`${label}.layout must be an object or null.`);
  }
  const changed = optionalBoolean(branch.changed, `${label}.changed`);
  return {
    sourcePath: branch.sourcePath.trim(),
    yaml: branch.yaml,
    ...(branch.layout !== undefined
      ? { layout: branch.layout as FinalizeLocalBranch['layout'] }
      : {}),
    ...(changed !== undefined ? { changed } : {}),
  };
}

function optionalTrialId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('trialId must be a string.');
  const trialId = value.trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(trialId)) {
    throw new Error('trialId must contain only letters, digits, underscores, or hyphens.');
  }
  return trialId;
}

function parseFinalizeInput(value: unknown): ChatYamlStageFinalizeInput {
  const body = asRequestRecord(value);
  if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
    throw new Error('stageId is required.');
  }
  if (typeof body.relativePath !== 'string' || !body.relativePath.trim()) {
    throw new Error('relativePath is required.');
  }
  if (body.forceFork !== undefined) {
    throw new Error(
      'forceFork is invalid and no longer accepted; the server derives publication conflicts.',
    );
  }
  const allowInvalid = optionalBoolean(body.allowInvalid, 'allowInvalid');
  const localBranch = parseLocalBranch(body.localBranch);
  const activeLocalBranch = parseLocalBranch(body.activeLocalBranch, 'activeLocalBranch');
  const trialId = optionalTrialId(body.trialId);
  const forceForkReason = body.forceForkReason;
  if (
    forceForkReason !== undefined &&
    forceForkReason !== 'path-moved' &&
    forceForkReason !== 'compile-failed'
  ) {
    if (forceForkReason === 'trial-run-failed') {
      throw new Error('forceForkReason is invalid: Trial verification is decided by the server.');
    }
    throw new Error('forceForkReason must be path-moved or compile-failed.');
  }
  return {
    stageId: body.stageId.trim(),
    relativePath: body.relativePath.trim(),
    ...(localBranch !== undefined ? { localBranch } : {}),
    ...(activeLocalBranch !== undefined ? { activeLocalBranch } : {}),
    ...(forceForkReason !== undefined ? { forceForkReason } : {}),
    ...(trialId !== undefined ? { trialId } : {}),
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
  if (err instanceof ChatYamlFinalizeWitnessError) {
    return err.kind === 'chat-yaml-finalize-witness-timeout' ? 504 : 503;
  }
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
  return res.status(stageErrorStatus(err)).json({
    error: errorMessage(err),
    ...(err instanceof ChatYamlFinalizeWitnessError ? { kind: err.kind } : {}),
  });
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

  app.post('/api/workspace/chat-yaml-stage/trial-run', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as {
      stageId?: unknown;
      relativePath?: unknown;
      trialId?: unknown;
    };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    if (typeof body.relativePath !== 'string' || !body.relativePath.trim()) {
      return res.status(400).json({ error: 'relativePath is required.' });
    }
    if (typeof body.trialId !== 'string' || !body.trialId.trim()) {
      return res.status(400).json({ error: 'trialId is required.' });
    }
    try {
      return res.json(
        await trialRunChatYamlStage(ws, {
          stageId: body.stageId.trim(),
          relativePath: body.relativePath.trim(),
          trialId: body.trialId.trim(),
        }),
      );
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/trial-run/progress', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { stageId?: unknown; trialId?: unknown };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    if (typeof body.trialId !== 'string' || !body.trialId.trim()) {
      return res.status(400).json({ error: 'trialId is required.' });
    }
    const stageId = body.stageId.trim();
    const trialId = body.trialId.trim();
    try {
      listChatYamlStage(ws, stageId);
      return res.json({
        progress: getChatPipelineTrialProgress(ws, { stageId, trialId }),
      });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/trial-run/cancel', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as { stageId?: unknown; trialId?: unknown };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    if (typeof body.trialId !== 'string' || !body.trialId.trim()) {
      return res.status(400).json({ error: 'trialId is required.' });
    }
    const input = {
      stageId: body.stageId.trim(),
      trialId: body.trialId.trim(),
    };
    const trialCancelled = cancelChatPipelineTrial(ws, input);
    const finalizeCancelled = cancelChatYamlStageFinalize(ws, input);
    return res.json({ cancelled: trialCancelled || finalizeCancelled });
  });

  app.post('/api/workspace/chat-yaml-stage/finalize', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    try {
      return res.json(await finalizeChatYamlStage(ws, parseFinalizeInput(req.body)));
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
      const stageId = body.stageId.trim();
      const disposition = discardChatYamlStageWithDisposition(ws, stageId);
      const finalizedResult =
        disposition === 'finalized' ? readFinalizedChatYamlStageResult(ws, stageId) : null;
      return res.json({
        discarded: disposition === 'discarded',
        disposition,
        ...(finalizedResult ? { finalizedResult } : {}),
      });
    } catch (err) {
      return respondStageError(res, err);
    }
  });
}
