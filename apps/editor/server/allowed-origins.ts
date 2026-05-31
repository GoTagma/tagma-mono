export function createAllowedOrigins(
  configuredPort: number,
  extraOriginsEnv: string | undefined = process.env.TAGMA_ALLOWED_ORIGINS,
  options: { devOrigins?: boolean } = {},
): Set<string> {
  const origins = new Set<string>();
  const includeDevOrigins = options.devOrigins ?? process.env.TAGMA_SIDECAR_ACTIVE_SOURCE === 'dev';

  // Vite starts on 5173 and, when that port is already busy, automatically
  // tries the next port. Keep this bounded to local dev origins instead of
  // allowing every localhost port.
  if (includeDevOrigins) {
    for (let port = 5173; port <= 5183; port += 1) {
      addLoopbackAllowedOrigins(origins, port);
    }
  }

  addLoopbackAllowedOrigins(origins, configuredPort);

  for (const origin of (extraOriginsEnv ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)) {
    origins.add(origin);
  }

  return origins;
}

export function addLoopbackAllowedOrigins(origins: Set<string>, port: number): void {
  origins.add(`http://localhost:${port}`);
  origins.add(`http://127.0.0.1:${port}`);
}

const configuredPort = parseInt(process.env.PORT ?? '3001');

export const ALLOWED_ORIGINS = createAllowedOrigins(configuredPort);
