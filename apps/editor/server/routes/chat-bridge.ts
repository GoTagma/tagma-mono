/**
 * Bot-bridge HTTP routes.
 *
 * The bot-bridge process lives inside the sidecar; the desktop renderer
 * needs a way to:
 *   - mint a one-time pair code scoped to the active workspace
 *   - inspect the workspace's current allowlist / chat bindings
 *   - manually add / revoke allowed sender ids
 *
 * Routes are workspace-scoped via the existing `requireWorkspace` middleware
 * so a code minted from window A binds to window A's workspace, not B's.
 */

import type express from 'express';
import { requireWorkspace } from '../require-workspace.js';
import { errorMessage } from '../path-utils.js';
import { createPairCode } from '../chat-bridge/pair-code.js';
import {
  addAllowedSender,
  bindChat,
  getManifest,
  removeAllowedSender,
  unbindChat,
} from '../chat-bridge/allowlist.js';
import { bindChatToWorkspace } from '../chat-bridge/chat-router.js';
import {
  armSlackBind,
  denySlackBindRequestForWorkspace,
  getArmedSlackBind,
  listSlackBindRequests,
  takeSlackBindRequestForWorkspace,
} from '../chat-bridge/slack-bind.js';
import { workspaceRegistry } from '../workspace-registry.js';
import { isBotRunning, isBotSwitchLocked, snapshotStatus } from '../chat-bridge/bot-loop.js';
import { startConfiguredBotBridge, shutdownBotBridge } from '../chat-bridge/index.js';
import {
  botTokenSource,
  credentialBackendAvailability,
  deleteBotToken,
  resolveBotToken,
  setBotToken,
} from '../chat-bridge/token-store.js';
import {
  resolveActivePlatform,
  setActivePlatform,
  isValidPlatform,
  SELECTABLE_PLATFORMS,
} from '../chat-bridge/transports/factory.js';
import type { Platform } from '../chat-bridge/types.js';

function coercePlatform(value: unknown): Platform | null {
  if (value == null) return resolveActivePlatform();
  return isValidPlatform(value) ? value : null;
}

function buildChatBridgeStatusSnapshot() {
  const backend = credentialBackendAvailability();
  const platform = resolveActivePlatform();
  return {
    ...snapshotStatus(),
    platform,
    platforms: SELECTABLE_PLATFORMS,
    tokenSource: botTokenSource(platform),
    keychainAvailable: backend.available,
    keychainMessage: backend.message,
  };
}

function buildManifestPayload(workDir: string) {
  return { ...getManifest(workDir), botRunning: isBotRunning() };
}

function coerceSenderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const senderId = value.trim();
  if (senderId.length === 0 || senderId.length > 128) return null;
  return senderId;
}

function coerceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length > 0 ? label.slice(0, 64) : null;
}

export function registerChatBridgeRoutes(app: express.Express): void {
  // POST /api/chat-bridge/pair/new
  //
  // Body: { label?: string }
  // Returns: { code, expiresAt, workspace, botRunning }
  //
  // The returned code must be relayed to the user out-of-band (UI dialog) so
  // they can type `/pair <code>` to the bot. The code is single-use and
  // expires after 120 s.
  app.post('/api/chat-bridge/pair/new', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Workspace directory is not set' });
    }
    try {
      const body = (req.body ?? {}) as { label?: unknown };
      const label =
        typeof body.label === 'string' && body.label.trim().length > 0
          ? body.label.trim().slice(0, 64)
          : null;
      const entry = createPairCode(ws.workDir, label);
      return res.json({
        code: entry.code,
        expiresAt: entry.expiresAt,
        workspace: ws.workDir,
        botRunning: isBotRunning(),
      });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/slack/bind-arm
  //
  // Slack is configured its own way: no relayed /pair code. The workspace
  // owner arms a bind HERE (workspace-scoped), then messages the bot once;
  // that surfaces as a pending approval below. The authorize decision stays
  // in this trusted desktop client — nothing interceptable travels to Slack.
  app.post('/api/chat-bridge/slack/bind-arm', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const { expiresAt } = armSlackBind(ws.workDir);
      return res.json({ ok: true, expiresAt });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // GET /api/chat-bridge/slack/bind-requests
  //
  // This workspace's armed state + pending approvals — the UI poll target.
  app.get('/api/chat-bridge/slack/bind-requests', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const armed = getArmedSlackBind();
      return res.json({
        armed: armed?.workspaceKey === ws.workDir ? { expiresAt: armed.expiresAt } : null,
        requests: listSlackBindRequests(ws.workDir).map((r) => ({
          chatId: r.chatId,
          senderId: r.senderId,
          senderLabel: r.senderLabel,
          chatKind: r.chatKind,
          requestedAt: r.requestedAt,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/slack/bind-approve   Body: { chatId, senderId }
  //
  // Approve a pending request: allowlist the sender + bind chat→workspace,
  // using the SAME primitives as the /pair path so the one-chat↔one-workspace
  // invariant holds. Only the workspace that armed it may approve it.
  app.post('/api/chat-bridge/slack/bind-approve', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const body = (req.body ?? {}) as { chatId?: unknown; senderId?: unknown };
      if (typeof body.chatId !== 'string' || typeof body.senderId !== 'string') {
        return res.status(400).json({ error: 'chatId and senderId are required' });
      }
      const taken = takeSlackBindRequestForWorkspace(ws.workDir, body.chatId, body.senderId);
      if (taken.status === 'not_found') {
        return res
          .status(404)
          .json({ error: 'No such pending Slack bind request (it may have expired).' });
      }
      if (taken.status === 'wrong_workspace') {
        return res.status(403).json({ error: 'This request belongs to a different workspace.' });
      }
      const entry = taken.request;
      addAllowedSender(ws.workDir, 'slack', entry.senderId, entry.senderLabel, 'slack-bind');
      for (const key of workspaceRegistry.keys()) {
        const other = workspaceRegistry.get(key);
        if (!other?.workDir || other.workDir === ws.workDir) continue;
        unbindChat(other.workDir, 'slack', entry.chatId);
      }
      bindChat(ws.workDir, 'slack', entry.chatId, entry.chatKind);
      bindChatToWorkspace('slack', entry.chatId, ws.workDir);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/slack/bind-deny   Body: { chatId, senderId }
  app.post('/api/chat-bridge/slack/bind-deny', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const body = (req.body ?? {}) as { chatId?: unknown; senderId?: unknown };
      if (typeof body.chatId !== 'string' || typeof body.senderId !== 'string') {
        return res.status(400).json({ error: 'chatId and senderId are required' });
      }
      const denied = denySlackBindRequestForWorkspace(ws.workDir, body.chatId, body.senderId);
      if (denied === 'wrong_workspace') {
        return res.status(403).json({ error: 'This request belongs to a different workspace.' });
      }
      return res.json({ ok: true, removed: denied === 'denied' });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/platform
  //
  // Body: { platform: 'telegram'|'discord'|'slack' }
  // Persists the user's provider choice (dropdown in the bot panel). Only one
  // platform runs per sidecar, so this is rejected with 409 while a bridge is
  // live — the user must Disconnect first.
  app.post('/api/chat-bridge/platform', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { platform?: unknown };
      if (!isValidPlatform(body.platform)) {
        return res
          .status(400)
          .json({ error: 'platform must be one of telegram | discord | slack' });
      }
      if (isBotSwitchLocked()) {
        return res.status(409).json({
          error: 'Disconnect the current bot before switching platform.',
        });
      }
      await setActivePlatform(body.platform);
      return res.json({ ok: true, status: buildChatBridgeStatusSnapshot() });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/disconnect
  //
  // Manually stop the long-poller. Useful when the user wants to take the bot
  // offline without quitting Tagma (e.g. switching machines, debugging, or
  // simply revoking remote access for a while). After disconnect the status
  // endpoint returns `disabled` until the user explicitly calls /connect.
  //
  // Idempotent: calling disconnect on an already-disabled bridge is a no-op.
  app.post('/api/chat-bridge/disconnect', async (_req, res) => {
    try {
      await shutdownBotBridge('user requested disconnect');
      return res.json({ ok: true, status: buildChatBridgeStatusSnapshot() });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/connect
  //
  // Re-enable the bridge after a manual disconnect, or kick it up for the
  // first time without restarting the sidecar. A configured token is required,
  // but the explicit Connect action is the opt-in.
  app.post('/api/chat-bridge/connect', async (_req, res) => {
    try {
      if (isBotRunning()) {
        return res.json({
          ok: true,
          alreadyRunning: true,
          status: buildChatBridgeStatusSnapshot(),
        });
      }
      if (!resolveBotToken(resolveActivePlatform())) {
        return res.status(400).json({
          error:
            'No bot token configured for the active platform. Paste a token in the bot panel first.',
        });
      }
      await startConfiguredBotBridge();
      return res.json({ ok: true, status: buildChatBridgeStatusSnapshot() });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/token
  //
  // Body: { token: string, platform?: 'telegram'|'discord'|'slack' }
  // platform defaults to the active platform. Persists
  // the token to the OS keychain (Windows Credential Manager / Linux Secret
  // Service). Never logs/echoes the token.
  app.post('/api/chat-bridge/token', (req, res) => {
    try {
      const body = (req.body ?? {}) as { token?: unknown; platform?: unknown };
      const platform = coercePlatform(body.platform);
      if (!platform) {
        return res.status(400).json({ error: 'Unsupported platform' });
      }
      if (typeof body.token !== 'string' || body.token.trim().length === 0) {
        return res.status(400).json({ error: 'token must be a non-empty string' });
      }
      setBotToken(platform, body.token);
      return res.json({ ok: true, source: botTokenSource(platform) });
    } catch (err) {
      return res.status(400).json({ error: errorMessage(err) });
    }
  });

  // DELETE /api/chat-bridge/token?platform=…
  //
  // Clears the keychain-stored token for the platform (default: active). An
  // env-var token (if any) still resolves afterwards — keychain layer only.
  app.delete('/api/chat-bridge/token', (req, res) => {
    try {
      const platform = coercePlatform(req.query.platform);
      if (!platform) {
        return res.status(400).json({ error: 'Unsupported platform' });
      }
      deleteBotToken(platform);
      return res.json({ ok: true, source: botTokenSource(platform) });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // POST /api/chat-bridge/allowlist
  //
  // Body: { fromId: string, label?: string, platform?: 'telegram'|'discord'|'slack' }
  //
  // Manually authorize a platform-native sender id for the active workspace.
  // This mirrors NanoBot's allowFrom idea while preserving Tagma's workspace
  // binding model: configured ids may pair and interact; unlisted ids are
  // ignored once the workspace has an allowlist for that platform.
  app.post('/api/chat-bridge/allowlist', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const body = (req.body ?? {}) as {
        fromId?: unknown;
        label?: unknown;
        platform?: unknown;
      };
      const platform = coercePlatform(body.platform);
      const fromId = coerceSenderId(body.fromId);
      if (!platform) return res.status(400).json({ error: 'Unsupported platform' });
      if (!fromId) {
        return res.status(400).json({ error: 'fromId must be a non-empty string <= 128 chars' });
      }
      const entry = addAllowedSender(
        ws.workDir,
        platform,
        fromId,
        coerceLabel(body.label),
        'manual',
      );
      return res.json({ ok: true, entry, manifest: buildManifestPayload(ws.workDir) });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // DELETE /api/chat-bridge/allowlist
  //
  // Body/query: { fromId: string, platform?: 'telegram'|'discord'|'slack' }
  app.delete('/api/chat-bridge/allowlist', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) return res.status(400).json({ error: 'Workspace directory is not set' });
    try {
      const body = (req.body ?? {}) as { fromId?: unknown; platform?: unknown };
      const fromId = coerceSenderId(body.fromId ?? req.query.fromId);
      const platform = coercePlatform(body.platform ?? req.query.platform);
      if (!platform) return res.status(400).json({ error: 'Unsupported platform' });
      if (!fromId) {
        return res.status(400).json({ error: 'fromId must be a non-empty string <= 128 chars' });
      }
      const removed = removeAllowedSender(ws.workDir, platform, fromId);
      return res.json({ ok: true, removed, manifest: buildManifestPayload(ws.workDir) });
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // GET /api/chat-bridge/status
  //
  // Workspace-agnostic snapshot of the bot's runtime state. The renderer
  // polls this every few seconds to drive a connection badge:
  //   disabled    — no token configured or manually disconnected
  //   connecting  — first init() in flight
  //   connected   — most recent getMe heartbeat succeeded
  //   error       — last call failed; lastError carries the cause
  // Lives outside requireWorkspace because the bot is sidecar-global; pairing
  // and manifest reads stay workspace-scoped (see below).
  app.get('/api/chat-bridge/status', (_req, res) => {
    try {
      return res.json(buildChatBridgeStatusSnapshot());
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });

  // GET /api/chat-bridge/manifest
  //
  // Returns the workspace's current allowlist + chat bindings so the desktop
  // UI can render who is paired and which Telegram chats are wired up.
  app.get('/api/chat-bridge/manifest', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Workspace directory is not set' });
    }
    try {
      return res.json(buildManifestPayload(ws.workDir));
    } catch (err) {
      return res.status(500).json({ error: errorMessage(err) });
    }
  });
}
