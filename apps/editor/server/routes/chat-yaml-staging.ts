import type express from 'express';

import {
  advanceChatYamlStageSessionRelocation,
  assertChatYamlStageLockOwner,
  cancelChatYamlStageFinalize,
  clearChatYamlStageSessionRelocation,
  ChatYamlFinalizeWitnessError,
  ChatYamlStageLockOwnershipError,
  ChatYamlStageSessionRelocationError,
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStageWithDisposition,
  finalizeChatYamlStage,
  listChatYamlStage,
  listChatYamlStageSessionRelocations,
  prepareChatYamlStageSessionRelocation,
  readChatYamlStageSessionRelocation,
  readFinalizedChatYamlStageResult,
  type ChatYamlStageFinalizeInput,
  type ChatYamlStageSessionRelocationAdvanceInput,
  type ChatYamlStageSessionRelocationClearInput,
  type ChatYamlStageSessionRelocationIdentity,
  type ChatYamlStageSessionRelocationPhase,
} from '../chat-yaml-staging.js';
import {
  cancelChatPipelineTrial,
  getChatPipelineTrialProgress,
  trialRunChatYamlStage,
} from '../chat-pipeline-trial-run.js';
import { authorizeChatYamlStagePaths } from '../chat-yaml-write-policy.js';
import { errorMessage } from '../path-utils.js';
import { requireWorkspace } from '../require-workspace.js';
import {
  acquireYamlEditLock,
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
  const retainStage = optionalBoolean(body.retainStage, 'retainStage');
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
    ...(retainStage !== undefined ? { retainStage } : {}),
  };
}

function requiredRelocationString(
  body: Record<string, unknown>,
  key: 'stageId' | 'sessionId' | 'relocationId',
): string {
  const value = body[key];
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${key} must be an exact non-empty string.`);
  }
  return value;
}

function relocationIdentity(value: unknown): ChatYamlStageSessionRelocationIdentity {
  const body = asRequestRecord(value);
  if ('sourceDirectory' in body || 'targetDirectory' in body) {
    throw new Error(
      'sourceDirectory and targetDirectory must not be provided; the server derives them from the authenticated stage.',
    );
  }
  return {
    stageId: requiredRelocationString(body, 'stageId'),
    sessionId: requiredRelocationString(body, 'sessionId'),
    relocationId: requiredRelocationString(body, 'relocationId'),
  };
}

function relocationPhase(value: unknown, label: string): ChatYamlStageSessionRelocationPhase {
  if (value !== 'prepared' && value !== 'staged' && value !== 'restoring') {
    throw new Error(`${label} must be prepared, staged, or restoring.`);
  }
  return value;
}

function parseRelocationAdvance(value: unknown): ChatYamlStageSessionRelocationAdvanceInput {
  const body = asRequestRecord(value);
  return {
    ...relocationIdentity(body),
    expectedPhase: relocationPhase(body.expectedPhase, 'expectedPhase'),
    phase: relocationPhase(body.phase, 'phase'),
  };
}

function parseRelocationClear(value: unknown): ChatYamlStageSessionRelocationClearInput {
  const body = asRequestRecord(value);
  const verifiedSessionMissing = body.verifiedSessionMissing === true;
  const hasHomeDirectory = body.verifiedHomeDirectory !== undefined;
  if (verifiedSessionMissing === hasHomeDirectory) {
    throw new Error(
      'Exactly one of verifiedHomeDirectory or verifiedSessionMissing=true is required.',
    );
  }
  const identity = relocationIdentity(body);
  const expectedPhase = relocationPhase(body.expectedPhase, 'expectedPhase');
  if (verifiedSessionMissing) {
    return { ...identity, expectedPhase, verifiedSessionMissing: true };
  }
  if (
    typeof body.verifiedHomeDirectory !== 'string' ||
    !body.verifiedHomeDirectory ||
    body.verifiedHomeDirectory.trim() !== body.verifiedHomeDirectory
  ) {
    throw new Error('verifiedHomeDirectory must be an exact non-empty string.');
  }
  return {
    ...identity,
    expectedPhase,
    verifiedHomeDirectory: body.verifiedHomeDirectory,
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

function assertRequestOwnsChatYamlStage(
  req: express.Request,
  ws: WorkspaceState,
  stageId: string,
): void {
  assertChatYamlStageLockOwner(ws, stageId, req.get('X-Tagma-Yaml-Lock-Id'));
}

async function underWorkspaceWideYamlEditLock<T>(
  ws: WorkspaceState,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = getActiveYamlEditLock(ws);
  if (!lock) throw new Error('An active OpenCode YAML edit lock is required for Trial.');
  const originalYamlPath = lock.yamlPath ?? null;
  const lockId = lock.id;
  const promoted = acquireYamlEditLock(ws, {
    id: lockId,
    reason: lock.reason,
    yamlPath: null,
  });
  if (!promoted.ok) throw new Error('The OpenCode YAML edit lock changed before Trial started.');
  try {
    return await operation();
  } finally {
    const current = getActiveYamlEditLock(ws);
    if (current?.id === lockId) {
      acquireYamlEditLock(ws, {
        id: lockId,
        reason: current.reason,
        yamlPath: originalYamlPath,
      });
    }
  }
}

function stageErrorStatus(err: unknown): number {
  if (err instanceof ChatYamlStageLockOwnershipError) return 423;
  if (err instanceof ChatYamlStageSessionRelocationError) {
    return err.kind === 'conflict' ? 409 : 400;
  }
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
    const stageId = body.stageId.trim();
    try {
      assertRequestOwnsChatYamlStage(req, ws, stageId);
      return res.json(listChatYamlStage(ws, stageId));
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.get('/api/workspace/chat-yaml-stage/session-relocation', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const stageId = req.query.stageId;
    if (typeof stageId !== 'string' || !stageId || stageId.trim() !== stageId) {
      return res.status(400).json({ error: 'stageId must be an exact non-empty string.' });
    }
    try {
      return res.json({ binding: readChatYamlStageSessionRelocation(ws, stageId) });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.get('/api/workspace/chat-yaml-stage/session-relocations', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    return res.json({ bindings: listChatYamlStageSessionRelocations(ws) });
  });

  app.post('/api/workspace/chat-yaml-stage/session-relocation/prepare', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    try {
      const input = relocationIdentity(req.body);
      assertRequestOwnsChatYamlStage(req, ws, input.stageId);
      return res.json({ binding: prepareChatYamlStageSessionRelocation(ws, input) });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/session-relocation/advance', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      const input = parseRelocationAdvance(req.body);
      const activeLock = getActiveYamlEditLock(ws);
      if (activeLock) {
        if (!requireChatYamlStageLock(req, res, ws)) return;
        assertRequestOwnsChatYamlStage(req, ws, input.stageId);
      } else if (input.phase !== 'restoring') {
        return res.status(423).json({
          error:
            'An active OpenCode YAML edit lock is required unless recovering a relocation toward home.',
          lock: null,
        });
      }
      return res.json({ binding: advanceChatYamlStageSessionRelocation(ws, input) });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/session-relocation/clear', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      const input = parseRelocationClear(req.body);
      const activeLock = getActiveYamlEditLock(ws);
      if (activeLock) {
        if (!canBypassYamlEditLock(activeLock, req.get('X-Tagma-Yaml-Lock-Id'))) {
          return res.status(423).json({
            error: 'The active OpenCode YAML edit lock is required to clear this relocation.',
            lock: publicYamlEditLock(activeLock),
          });
        }
        assertRequestOwnsChatYamlStage(req, ws, input.stageId);
      }
      return res.json({ cleared: clearChatYamlStageSessionRelocation(ws, input) });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/authorize-paths', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    const body = (req.body ?? {}) as {
      stageId?: unknown;
      permission?: unknown;
      patterns?: unknown;
      metadata?: unknown;
    };
    if (typeof body.stageId !== 'string' || !body.stageId.trim()) {
      return res.status(400).json({ error: 'stageId is required.' });
    }
    if (typeof body.permission !== 'string' || !body.permission.trim()) {
      return res.status(400).json({ error: 'permission is required.' });
    }
    if (!Array.isArray(body.patterns) || body.patterns.some((value) => typeof value !== 'string')) {
      return res.status(400).json({ error: 'patterns must be an array of strings.' });
    }
    try {
      assertRequestOwnsChatYamlStage(req, ws, body.stageId.trim());
      return res.json(
        authorizeChatYamlStagePaths(ws, {
          stageId: body.stageId.trim(),
          permission: body.permission.trim(),
          patterns: body.patterns as string[],
          metadata: body.metadata,
        }),
      );
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
    const stageId = body.stageId.trim();
    try {
      assertRequestOwnsChatYamlStage(req, ws, stageId);
      return res.json(compileChatYamlStage(ws, stageId, body.relativePath.trim()));
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
    const stageId = body.stageId.trim();
    const relativePath = body.relativePath.trim();
    const trialId = body.trialId.trim();
    try {
      assertRequestOwnsChatYamlStage(req, ws, stageId);
      return res.json(
        await underWorkspaceWideYamlEditLock(ws, () =>
          trialRunChatYamlStage(ws, {
            stageId,
            relativePath,
            trialId,
          }),
        ),
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
      assertRequestOwnsChatYamlStage(req, ws, stageId);
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
    try {
      assertRequestOwnsChatYamlStage(req, ws, input.stageId);
      const trialCancelled = cancelChatPipelineTrial(ws, input);
      const finalizeCancelled = cancelChatYamlStageFinalize(ws, input);
      return res.json({ cancelled: trialCancelled || finalizeCancelled });
    } catch (err) {
      return respondStageError(res, err);
    }
  });

  app.post('/api/workspace/chat-yaml-stage/finalize', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws || !requireChatYamlStageLock(req, res, ws)) return;
    try {
      const input = parseFinalizeInput(req.body);
      assertRequestOwnsChatYamlStage(req, ws, input.stageId);
      return res.json(await finalizeChatYamlStage(ws, input));
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
      assertRequestOwnsChatYamlStage(req, ws, stageId);
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
