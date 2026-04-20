import path from 'node:path';

// Pick the platform-specific path module so tests can pass `platform: 'win32'`
// with `D:/...` paths and still get correct resolution on a Linux CI host.
function pathFor(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface RuntimePathOptions {
  isPackaged: boolean;
  compiledDir: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  /**
   * Writable directory to use as the sidecar's cwd in packaged mode. When
   * omitted we fall back to the sidecar directory under resources/, which on
   * Windows `Program Files` installs is read-only — any future relative-path
   * write from the server will hit EACCES. Pass `app.getPath('userData')`
   * from the Electron main process to route cwd into a user-writable tree.
   */
  userDataDir?: string;
  /**
   * Pinned opencode-ai version bundled with this release (read from
   * packages/electron/package.json `tagma.bundledOpencodeVersion`). Forwarded
   * to the sidecar so the OpenCode CLI settings panel can show "shipped vX"
   * and compare against userData overrides and the latest npm release.
   */
  bundledOpencodeVersion?: string;
}

export interface RuntimePaths {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
}

/**
 * Build the PATH the sidecar should see, with opencode layers prepended.
 *
 * Lookup precedence (highest first):
 *   1. userData/opencode/bin   — runtime updates written by /api/opencode/update
 *   2. resources/opencode/bin  — version pinned at desktop build time (plan A)
 *   3. system PATH             — user's own install (dev workflow)
 *
 * The userData layer wins so an in-app update ships a new opencode without
 * touching signed bundled files in Program Files / Applications. Running on
 * an end user's machine with neither bun nor opencode still works because
 * the bundled layer is always present after a fresh install.
 */
function buildSidecarPath(
  p: typeof path.win32 | typeof path.posix,
  resourcesPath: string,
  userDataDir: string | undefined,
  platform: NodeJS.Platform,
): string {
  const sep = platform === 'win32' ? ';' : ':';
  const layers: string[] = [];
  if (userDataDir) {
    layers.push(p.join(userDataDir, 'opencode', 'bin'));
  }
  layers.push(p.join(resourcesPath, 'opencode', 'bin'));
  const existing = process.env.PATH ?? '';
  return existing ? `${layers.join(sep)}${sep}${existing}` : layers.join(sep);
}

export function resolveRuntimePaths(options: RuntimePathOptions): RuntimePaths {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);

  if (options.isPackaged) {
    const sidecarDir = p.join(options.resourcesPath, 'editor-sidecar');
    const sidecarPath = buildSidecarPath(p, options.resourcesPath, options.userDataDir, platform);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '0',
      TAGMA_EDITOR_DIST_DIR: p.join(options.resourcesPath, 'editor-dist'),
      PATH: sidecarPath,
      // Sidecar reads these to power the OpenCode CLI section in Settings
      // (current install check, bundled-version display, update target dir).
      TAGMA_OPENCODE_BUNDLED_DIR: p.join(options.resourcesPath, 'opencode'),
    };
    if (options.userDataDir) {
      env.TAGMA_OPENCODE_USER_DIR = p.join(options.userDataDir, 'opencode');
    }
    if (options.bundledOpencodeVersion) {
      env.TAGMA_OPENCODE_BUNDLED_VERSION = options.bundledOpencodeVersion;
    }
    return {
      command: p.join(sidecarDir, executableName(platform)),
      args: [],
      cwd: options.userDataDir ?? sidecarDir,
      env,
    };
  }

  const editorDir = p.resolve(options.compiledDir, '..', '..', 'editor');
  return {
    command: 'bun',
    args: [p.join(editorDir, 'server', 'index.ts')],
    cwd: editorDir,
    env: {
      ...process.env,
      PORT: '0',
      TAGMA_EDITOR_DIST_DIR: p.join(editorDir, 'dist'),
    },
  };
}
