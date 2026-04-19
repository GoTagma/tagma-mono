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

export function resolveRuntimePaths(options: RuntimePathOptions): RuntimePaths {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);

  if (options.isPackaged) {
    const sidecarDir = p.join(options.resourcesPath, 'editor-sidecar');
    return {
      command: p.join(sidecarDir, executableName(platform)),
      args: [],
      cwd: options.userDataDir ?? sidecarDir,
      env: {
        ...process.env,
        PORT: '0',
        TAGMA_EDITOR_DIST_DIR: p.join(options.resourcesPath, 'editor-dist'),
      },
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
