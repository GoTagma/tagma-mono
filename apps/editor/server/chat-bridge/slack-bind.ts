/**
 * Slack desktop binding — the relayed `/pair <code>` replacement for Slack.
 *
 * Slack is configured its own way (Module 3 / spec
 * docs/superpowers/specs/2026-05-17-bot-bridge-per-platform-and-chat-sync-design.md):
 * the workspace owner ARMS a bind from the trusted desktop panel
 * (workspace-scoped HTTP route), then messages the bot once; the conductor
 * turns that into a pending REQUEST which the owner explicitly Approves in the
 * desktop UI. No code travels over Slack, so nothing is interceptable — the
 * authorize decision is made in the trusted client by the workspace owner.
 *
 * In-memory only, like pair-code.ts: state is short-lived and there's no value
 * in surviving a sidecar restart (re-arm is one click).
 *
 * Security properties (see tests):
 *  - No armed bind → recordSlackBindRequest returns null, so the conductor
 *    stays silent and never leaks that the bot exists to a random sender.
 *  - Arming is consumed by the first request, so a different sender cannot
 *    ride a stale arm; each distinct {chatId,senderId} gets its own request
 *    and its own explicit Approve.
 *  - Approve is keyed to the exact {chatId,senderId} observed.
 */

import type { ChatKind } from './transports/types.js';

const ARM_TTL_MS = 10 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;

export interface SlackBindRequest {
  chatId: string;
  senderId: string;
  senderLabel: string | null;
  chatKind: ChatKind;
  workspaceKey: string;
  requestedAt: number;
}

interface ArmedBind {
  workspaceKey: string;
  expiresAt: number;
}

export type SlackBindTakeResult =
  | { status: 'matched'; request: SlackBindRequest }
  | { status: 'not_found' }
  | { status: 'wrong_workspace' };

export type SlackBindDenyResult = 'denied' | 'not_found' | 'wrong_workspace';

let armed: ArmedBind | null = null;
/** key = `${chatId}::${senderId}` */
const requests = new Map<string, SlackBindRequest>();

let nowFn: () => number = () => Date.now();
function now(): number {
  return nowFn();
}

function reqKey(chatId: string, senderId: string): string {
  return `${chatId}::${senderId}`;
}

function evictExpired(): void {
  const t = now();
  if (armed && armed.expiresAt <= t) armed = null;
  for (const [k, r] of requests) {
    if (r.requestedAt + REQUEST_TTL_MS <= t) requests.delete(k);
  }
}

/** Arm (or re-arm, replacing any prior) a Slack bind for a workspace. */
export function armSlackBind(workspaceKey: string): { expiresAt: number } {
  evictExpired();
  armed = { workspaceKey, expiresAt: now() + ARM_TTL_MS };
  return { expiresAt: armed.expiresAt };
}

export function getArmedSlackBind(): { workspaceKey: string; expiresAt: number } | null {
  evictExpired();
  return armed ? { ...armed } : null;
}

/**
 * Turn an inbound Slack message from an unbound chat into a pending approval.
 * Returns the (existing or new) request, or null when there is nothing armed
 * and no pending request — in which case the caller MUST stay silent.
 */
export function recordSlackBindRequest(input: {
  chatId: string;
  senderId: string;
  senderLabel: string | null;
  chatKind: ChatKind;
}): { request: SlackBindRequest; created: boolean } | null {
  evictExpired();
  const key = reqKey(input.chatId, input.senderId);
  const existing = requests.get(key);
  // Idempotent: re-messaging while pending returns the same request with
  // created:false so the caller can notify exactly once (no spam).
  if (existing) return { request: existing, created: false };
  if (!armed) return null;
  const request: SlackBindRequest = {
    chatId: input.chatId,
    senderId: input.senderId,
    senderLabel: input.senderLabel,
    chatKind: input.chatKind,
    workspaceKey: armed.workspaceKey,
    requestedAt: now(),
  };
  requests.set(key, request);
  armed = null; // consume: one arm authorizes one pairing intent
  return { request, created: true };
}

/** All non-expired pending requests (optionally just one workspace's). */
export function listSlackBindRequests(workspaceKey?: string): SlackBindRequest[] {
  evictExpired();
  const all = [...requests.values()];
  return workspaceKey ? all.filter((r) => r.workspaceKey === workspaceKey) : all;
}

/** Pop the exact request for approval. Caller then binds + allowlists. */
export function takeSlackBindRequest(chatId: string, senderId: string): SlackBindRequest | null {
  evictExpired();
  const key = reqKey(chatId, senderId);
  const r = requests.get(key);
  if (!r) return null;
  requests.delete(key);
  return r;
}

/**
 * Pop a request only when it belongs to the active workspace. A wrong-workspace
 * attempt must not consume another window's pending Slack approval.
 */
export function takeSlackBindRequestForWorkspace(
  workspaceKey: string,
  chatId: string,
  senderId: string,
): SlackBindTakeResult {
  evictExpired();
  const key = reqKey(chatId, senderId);
  const r = requests.get(key);
  if (!r) return { status: 'not_found' };
  if (r.workspaceKey !== workspaceKey) return { status: 'wrong_workspace' };
  requests.delete(key);
  return { status: 'matched', request: r };
}

export function denySlackBindRequest(chatId: string, senderId: string): boolean {
  evictExpired();
  return requests.delete(reqKey(chatId, senderId));
}

export function denySlackBindRequestForWorkspace(
  workspaceKey: string,
  chatId: string,
  senderId: string,
): SlackBindDenyResult {
  evictExpired();
  const key = reqKey(chatId, senderId);
  const r = requests.get(key);
  if (!r) return 'not_found';
  if (r.workspaceKey !== workspaceKey) return 'wrong_workspace';
  requests.delete(key);
  return 'denied';
}

export function pendingSlackBindCount(): number {
  evictExpired();
  return requests.size;
}

export function _resetForTests(): void {
  armed = null;
  requests.clear();
}

export function _setNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}
