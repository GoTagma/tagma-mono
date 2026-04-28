/** Parse "5s" / "1m" / "2h" / "500ms" into ms; fall back to `fallback` on bad input or null. */
const MAX_TIMER_DURATION_MS = 2_147_483_647;

export function parseDurationSafe(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  const str = String(raw).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  const ms = (() => {
    switch (m[2]) {
      case 'ms':
        return n;
      case 'm':
        return n * 60_000;
      case 'h':
        return n * 3_600_000;
      case 's':
      default:
        return n * 1000;
    }
  })();
  if (!Number.isFinite(ms) || ms > MAX_TIMER_DURATION_MS) return fallback;
  return ms;
}

// Strict duration parser. Mirrors validate-raw.ts and @tagma/core's parseDuration:
// requires an explicit s|m|h|d unit, rejects malformed input and out-of-range
// values by throwing, and is the single source of truth for the
// parseOptionalPluginTimeout wrapper used by both built-in SDK plugins and
// external workspace plugins (trigger-webhook, etc.). Lives here in @tagma/types
// so external plugins do not need to depend on @tagma/sdk to share the wrapper.
const PLUGIN_TIMEOUT_RE = /^(\d*\.?\d+)\s*(s|m|h|d)$/;

function parsePluginDurationStrict(input: string): number {
  const match = PLUGIN_TIMEOUT_RE.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${input}". Expected format: <number>(s|m|h|d)`);
  }
  const value = parseFloat(match[1]!);
  const unit = match[2]!;
  const ms = (() => {
    switch (unit) {
      case 's':
        return value * 1000;
      case 'm':
        return value * 60_000;
      case 'h':
        return value * 3_600_000;
      case 'd':
        return value * 86_400_000;
      default:
        throw new Error(`Unknown duration unit: "${unit}"`);
    }
  })();
  if (!Number.isFinite(ms) || ms > MAX_TIMER_DURATION_MS) {
    throw new Error(
      `Invalid duration "${input}": exceeds maximum supported timer value of ${MAX_TIMER_DURATION_MS}ms`,
    );
  }
  return ms;
}

/**
 * Plugin schemas use `timeout` as an optional duration field. Omitted values
 * fall back to the caller's default; explicit 0 disables the timer; anything
 * else must be a strict duration string (e.g. "30s", "10m"). Bad input throws
 * so a typo cannot silently degrade into "no timeout enforcement".
 */
export function parseOptionalPluginTimeout(value: unknown, fallbackMs: number): number {
  if (value == null) return fallbackMs;
  if (value === 0 || value === '0') return 0;
  return parsePluginDurationStrict(String(value));
}
