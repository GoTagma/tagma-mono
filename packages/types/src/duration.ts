/** Parse "5s" / "1m" / "2h" / "500ms" into ms; fall back to `fallback` on bad input or null. */
export function parseDurationSafe(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  const str = String(raw).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
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
}
