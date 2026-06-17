/**
 * One-time pairing codes for the bot-bridge.
 *
 * The desktop chat panel (or a curl in dev) asks the sidecar to generate a
 * 6-digit numeric code scoped to a workspace. The user types `/pair <code>`
 * into their bot on Telegram; on match, the bot adds the sender's
 * platform-native id to that workspace's allowlist and binds chat→workspace.
 *
 * Storage is in-memory only — codes are short-lived (120 s) and there's no
 * value in surviving a sidecar restart (the user can just generate a fresh
 * one). Comparisons use timing-safe equality to keep guess-rate analysis
 * uninteresting.
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import type { PairCode } from './types.js';

const DEFAULT_TTL_MS = 120_000;
const CODE_DIGITS = 6;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_GLOBAL_FAILED_ATTEMPTS = 20;
const ATTEMPT_WINDOW_MS = 10 * 60_000;
const LOCKOUT_MS = 10 * 60_000;

/** key = code; codes are unique while pending, regenerated on collision. */
const pending = new Map<string, PairCode>();

interface AttemptState {
  firstFailedAt: number;
  failedCount: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptState>();
let globalAttempts: AttemptState | null = null;

export type PairCodeAttemptResult =
  | { status: 'matched'; entry: PairCode }
  | { status: 'miss'; attemptsRemaining: number }
  | { status: 'locked'; lockedUntil: number };

function now(): number {
  return Date.now();
}

function evictExpired(): void {
  const t = now();
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= t) pending.delete(code);
  }
  if (pending.size === 0) globalAttempts = null;
}

function evictExpiredAttempts(): void {
  const t = now();
  for (const [key, state] of attempts) {
    const lockExpired = state.lockedUntil > 0 && state.lockedUntil <= t;
    const windowExpired = state.lockedUntil === 0 && state.firstFailedAt + ATTEMPT_WINDOW_MS <= t;
    if (lockExpired || windowExpired) attempts.delete(key);
  }
  if (globalAttempts) {
    const lockExpired = globalAttempts.lockedUntil > 0 && globalAttempts.lockedUntil <= t;
    const windowExpired =
      globalAttempts.lockedUntil === 0 && globalAttempts.firstFailedAt + ATTEMPT_WINDOW_MS <= t;
    if (lockExpired || windowExpired) globalAttempts = null;
  }
}

function generateCode(): string {
  // randomInt is cryptographic; pad to 6 digits so leading zeros render.
  return String(randomInt(0, 1_000_000)).padStart(CODE_DIGITS, '0');
}

export function createPairCode(workspaceKey: string, label: string | null): PairCode {
  evictExpired();
  let code = generateCode();
  // Vanishingly unlikely collision, but spin until clear.
  while (pending.has(code)) code = generateCode();
  const entry: PairCode = {
    code,
    workspaceKey,
    label,
    expiresAt: now() + DEFAULT_TTL_MS,
  };
  pending.set(code, entry);
  return entry;
}

/**
 * Find a matching code without consuming it. The caller decides whether the
 * match is authorized before deleting the code.
 */
function findPairCode(submitted: string): PairCode | null {
  evictExpired();
  if (typeof submitted !== 'string') return null;
  if (submitted.length !== CODE_DIGITS) return null;
  if (!/^\d{6}$/.test(submitted)) return null;
  const submittedBuf = Buffer.from(submitted, 'utf-8');
  let match: PairCode | null = null;
  for (const entry of pending.values()) {
    const cand = Buffer.from(entry.code, 'utf-8');
    if (cand.length !== submittedBuf.length) continue;
    if (timingSafeEqual(cand, submittedBuf)) match = entry;
  }
  return match;
}

export function consumePairCode(submitted: string): PairCode | null {
  const match = findPairCode(submitted);
  if (match) pending.delete(match.code);
  return match;
}

function recordAttempt(
  state: AttemptState | null,
  maxAttempts: number,
): [AttemptState, PairCodeAttemptResult] {
  const t = now();
  const next =
    state && state.firstFailedAt + ATTEMPT_WINDOW_MS > t
      ? state
      : { firstFailedAt: t, failedCount: 0, lockedUntil: 0 };
  next.failedCount += 1;
  if (next.failedCount >= maxAttempts) {
    next.failedCount = 0;
    next.firstFailedAt = t;
    next.lockedUntil = t + LOCKOUT_MS;
    return [next, { status: 'locked', lockedUntil: next.lockedUntil }];
  }
  return [next, { status: 'miss', attemptsRemaining: maxAttempts - next.failedCount }];
}

function recordFailedAttempt(attemptKey: string): PairCodeAttemptResult {
  evictExpiredAttempts();
  const [state, result] = recordAttempt(attempts.get(attemptKey) ?? null, MAX_FAILED_ATTEMPTS);
  attempts.set(attemptKey, state);
  return result;
}

function recordGlobalFailedAttempt(): PairCodeAttemptResult {
  evictExpiredAttempts();
  const [state, result] = recordAttempt(globalAttempts, MAX_GLOBAL_FAILED_ATTEMPTS);
  globalAttempts = state;
  return result;
}

function globalLockout(): PairCodeAttemptResult | null {
  evictExpiredAttempts();
  return globalAttempts && globalAttempts.lockedUntil > now()
    ? { status: 'locked', lockedUntil: globalAttempts.lockedUntil }
    : null;
}

export function consumePairCodeAttempt(
  submitted: string,
  attemptKey: string,
): PairCodeAttemptResult {
  return redeemPairCodeAttempt(submitted, attemptKey);
}

export function redeemPairCodeAttempt(submitted: string, attemptKey: string): PairCodeAttemptResult;
export function redeemPairCodeAttempt(
  submitted: string,
  attemptKey: string,
  canRedeem: (entry: PairCode) => boolean,
): PairCodeAttemptResult;
export function redeemPairCodeAttempt(
  submitted: string,
  attemptKey: string,
  canRedeem?: (entry: PairCode) => boolean,
): PairCodeAttemptResult {
  evictExpired();
  evictExpiredAttempts();
  const key = attemptKey.trim();
  const state = attempts.get(key);
  if (state && state.lockedUntil > now()) {
    return { status: 'locked', lockedUntil: state.lockedUntil };
  }
  const globalLocked = globalLockout();
  if (globalLocked) return globalLocked;
  const entry = findPairCode(submitted);
  if (entry) {
    if (canRedeem && !canRedeem(entry)) {
      const callerResult = recordFailedAttempt(key);
      const globalResult = recordGlobalFailedAttempt();
      return globalResult.status === 'locked' ? globalResult : callerResult;
    }
    pending.delete(entry.code);
    attempts.delete(key);
    if (pending.size === 0) globalAttempts = null;
    return { status: 'matched', entry };
  }
  const callerResult = recordFailedAttempt(key);
  const globalResult = recordGlobalFailedAttempt();
  return globalResult.status === 'locked' ? globalResult : callerResult;
}

export function pendingCount(): number {
  evictExpired();
  return pending.size;
}

export function _resetForTests(): void {
  pending.clear();
  attempts.clear();
  globalAttempts = null;
}
