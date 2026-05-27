/**
 * Per-workspace bot-bridge allowlist + chat-route persistence.
 *
 * Stored in user-local state keyed by workspace path. The whole file is rewritten
 * atomically on every change so a crashed write doesn't corrupt the manifest
 * — same atomic-write pattern as secrets.ts.
 *
 * Reads are cached per-workspace in-memory; writes invalidate the cache.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../path-utils.js';
import {
  type AllowlistEntry,
  type BridgeManifest,
  type ChatRoute,
  type Platform,
} from './types.js';

type AllowlistSource = NonNullable<AllowlistEntry['source']>;

let stateDirOverrideForTests: string | null = null;

function manifestPath(workDir: string): string {
  // Keep remote-chat authorization in user-local state. Workspace files can be
  // cloned from untrusted repos and must not be able to pre-authorize senders.
  const stateDir = stateDirOverrideForTests ?? join(homedir(), '.tagma', 'bot-bridge');
  const workspaceKey = createHash('sha256').update(resolve(workDir)).digest('hex').slice(0, 32);
  return join(stateDir, `${workspaceKey}.json`);
}

const cache = new Map<string, BridgeManifest>();

function emptyManifest(): BridgeManifest {
  return { version: 1, allowlist: [], chats: [] };
}

function loadManifest(workDir: string): BridgeManifest {
  const cached = cache.get(workDir);
  if (cached) return cached;
  const p = manifestPath(workDir);
  if (!existsSync(p)) {
    const manifest = emptyManifest();
    cache.set(workDir, manifest);
    return manifest;
  }
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BridgeManifest>;
    // Be lenient on shape — forward-compat with future fields, but never let
    // a missing array crash a hot path.
    const manifest: BridgeManifest = {
      version: 1,
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
      chats: Array.isArray(parsed.chats) ? parsed.chats : [],
    };
    cache.set(workDir, manifest);
    return manifest;
  } catch (err) {
    console.warn(`[bot-bridge] manifest at ${p} unreadable, starting empty:`, err);
    const manifest = emptyManifest();
    cache.set(workDir, manifest);
    return manifest;
  }
}

function saveManifest(workDir: string, manifest: BridgeManifest): void {
  const path = manifestPath(workDir);
  // `atomicWriteFileSync` writes a sibling temp file then renames — it does
  // NOT create parent dirs. The bot-bridge can persist (via /pair) before the
  // renderer has created `.tagma`, so ensure it exists first (no-op if it
  // already does — the common case once chat has been opened).
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  cache.set(workDir, manifest);
}

export function isSenderAllowed(workDir: string, platform: Platform, fromId: string): boolean {
  const m = loadManifest(workDir);
  return m.allowlist.some((e) => e.platform === platform && e.fromId === fromId);
}

export function hasAllowedSenders(workDir: string, platform: Platform): boolean {
  const m = loadManifest(workDir);
  return m.allowlist.some((e) => e.platform === platform);
}

export function hasManualAllowedSenders(workDir: string, platform: Platform): boolean {
  const m = loadManifest(workDir);
  return m.allowlist.some((e) => e.platform === platform && e.source === 'manual');
}

export function addAllowedSender(
  workDir: string,
  platform: Platform,
  fromId: string,
  label: string | null,
  source: AllowlistSource = 'pair',
): AllowlistEntry {
  const existing = loadManifest(workDir);
  const found = existing.allowlist.find((e) => e.platform === platform && e.fromId === fromId);
  if (found) {
    if (found.source === source || source !== 'manual') return found;
    const updated: AllowlistEntry = {
      ...found,
      label: label ?? found.label,
      source,
    };
    saveManifest(workDir, {
      ...existing,
      allowlist: existing.allowlist.map((entry) =>
        entry.platform === platform && entry.fromId === fromId ? updated : entry,
      ),
    });
    return updated;
  }
  const entry: AllowlistEntry = {
    fromId,
    label,
    platform,
    pairedAt: new Date().toISOString(),
    source,
  };
  saveManifest(workDir, {
    ...existing,
    allowlist: [...existing.allowlist, entry],
  });
  return entry;
}

export function removeAllowedSender(workDir: string, platform: Platform, fromId: string): boolean {
  const existing = loadManifest(workDir);
  const next = existing.allowlist.filter((e) => !(e.platform === platform && e.fromId === fromId));
  if (next.length === existing.allowlist.length) return false;
  saveManifest(workDir, { ...existing, allowlist: next });
  return true;
}

export function bindChat(
  workDir: string,
  platform: Platform,
  chatId: string,
  kind: ChatRoute['kind'],
): ChatRoute {
  const existing = loadManifest(workDir);
  const found = existing.chats.find((c) => c.platform === platform && c.chatId === chatId);
  if (found) {
    if (found.kind === kind) return found;
    const updated = { ...found, kind };
    saveManifest(workDir, {
      ...existing,
      chats: existing.chats.map((chat) =>
        chat.platform === platform && chat.chatId === chatId ? updated : chat,
      ),
    });
    return updated;
  }
  const route: ChatRoute = {
    chatId,
    kind,
    platform,
    pairedAt: new Date().toISOString(),
  };
  saveManifest(workDir, {
    ...existing,
    chats: [...existing.chats, route],
  });
  return route;
}

/**
 * Persist (or clear, with `null`) the opencode session a bound chat drives.
 * Returns false if the chat isn't bound (nothing to attach a session to) or
 * the value is already current — no redundant atomic rewrite in that case.
 */
export function setChatSession(
  workDir: string,
  platform: Platform,
  chatId: string,
  sessionId: string | null,
): boolean {
  const existing = loadManifest(workDir);
  const found = existing.chats.find((c) => c.platform === platform && c.chatId === chatId);
  if (!found) return false;
  const current = found.sessionId ?? null;
  if (current === (sessionId ?? null)) return false;
  const updated: ChatRoute = { ...found };
  if (sessionId) updated.sessionId = sessionId;
  else delete updated.sessionId;
  saveManifest(workDir, {
    ...existing,
    chats: existing.chats.map((chat) =>
      chat.platform === platform && chat.chatId === chatId ? updated : chat,
    ),
  });
  return true;
}

export function unbindChat(workDir: string, platform: Platform, chatId: string): boolean {
  const existing = loadManifest(workDir);
  const next = existing.chats.filter((c) => !(c.platform === platform && c.chatId === chatId));
  if (next.length === existing.chats.length) return false;
  saveManifest(workDir, { ...existing, chats: next });
  return true;
}

export function getManifest(workDir: string): BridgeManifest {
  return loadManifest(workDir);
}

export function clearCache(workDir?: string): void {
  if (workDir) cache.delete(workDir);
  else cache.clear();
}

export function _manifestPathForTests(workDir: string): string {
  return manifestPath(workDir);
}

export function _setStateDirForTests(stateDir: string | null): void {
  stateDirOverrideForTests = stateDir ? resolve(stateDir) : null;
  clearCache();
}
