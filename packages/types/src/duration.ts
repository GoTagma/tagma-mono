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
