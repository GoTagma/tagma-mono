/**
 * Tiny in-memory rate limiter for outbound proxy / discovery routes.
 *
 * The API surface is minimal — a fixed-window counter keyed by an arbitrary
 * string (workspace key, IP, "key | hostname", whatever the caller wants).
 * We don't try to model leaky-bucket semantics or distributed state because
 * this sidecar is per-machine and per-process; the goal is just to prevent
 * a runaway local script from spamming npmjs.org or a user's local LLM
 * server through the editor.
 *
 * The bucket is also self-trimming: stale keys are dropped lazily on each
 * `take` call so we don't leak memory. A hard ceiling on the map size
 * (`MAX_BUCKETS`) protects against an attacker generating ~unlimited keys
 * by varying e.g. the workspace header.
 */

interface Bucket {
  count: number;
  windowEndsAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 4096;

export interface RateLimit {
  /** Window length in ms. */
  readonly windowMs: number;
  /** Maximum requests per window. */
  readonly max: number;
}

export interface RateLimitDecision {
  ok: boolean;
  remaining: number;
  /** When the next request would be allowed (epoch ms). */
  retryAfterMs: number;
}

function pruneStale(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [k, b] of buckets) {
    if (b.windowEndsAt <= now) buckets.delete(k);
  }
  if (buckets.size < MAX_BUCKETS) return;
  // If we still over-budget, evict oldest insertions until back under cap.
  // Maps keep insertion order so iteration order is FIFO.
  const overflow = buckets.size - MAX_BUCKETS;
  let dropped = 0;
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (++dropped >= overflow) break;
  }
}

/**
 * Try to consume one request from the bucket identified by `key`. Returns
 * a decision whose `ok` flag tells the caller whether to proceed.
 */
export function takeRateLimitToken(key: string, limit: RateLimit): RateLimitDecision {
  const now = Date.now();
  pruneStale(now);
  const existing = buckets.get(key);
  if (!existing || existing.windowEndsAt <= now) {
    const fresh: Bucket = { count: 1, windowEndsAt: now + limit.windowMs };
    buckets.set(key, fresh);
    return { ok: true, remaining: limit.max - 1, retryAfterMs: 0 };
  }
  if (existing.count >= limit.max) {
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(0, existing.windowEndsAt - now),
    };
  }
  existing.count += 1;
  return { ok: true, remaining: limit.max - existing.count, retryAfterMs: 0 };
}

/** Test-only — drains the bucket map. */
export function _resetRateLimits(): void {
  buckets.clear();
}
