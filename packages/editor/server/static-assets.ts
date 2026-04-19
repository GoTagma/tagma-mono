import { resolve } from 'node:path';

export function resolveStaticAssetsDir(
  serverDir: string,
  envDistDir: string | undefined = process.env.TAGMA_EDITOR_DIST_DIR,
): string {
  if (envDistDir && envDistDir.trim()) {
    return envDistDir;
  }
  return resolve(serverDir, '..', 'dist');
}
