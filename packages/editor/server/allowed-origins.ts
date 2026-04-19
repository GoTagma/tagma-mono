export function createAllowedOrigins(
  configuredPort: number,
  extraOriginsEnv: string | undefined = process.env.TAGMA_ALLOWED_ORIGINS,
): Set<string> {
  const origins = new Set<string>([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://localhost:${configuredPort}`,
    `http://127.0.0.1:${configuredPort}`,
  ]);

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
