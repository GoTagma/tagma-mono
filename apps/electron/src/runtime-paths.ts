import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

type PathModule = typeof path.win32 | typeof path.posix;

// Pick the platform-specific path module so tests can pass `platform: 'win32'`
// with `D:/...` paths and still get correct resolution on a Linux CI host.
function pathFor(platform: NodeJS.Platform): PathModule {
  return platform === 'win32' ? path.win32 : path.posix;
}

function readPathEnv(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
}

function preferredPathEnvKey(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): 'Path' | 'PATH' {
  return platform === 'win32' && typeof env.Path === 'string' ? 'Path' : 'PATH';
}

function withPathEnv(
  base: NodeJS.ProcessEnv,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (platform === 'win32') {
    // Windows environment keys are case-insensitive, but Node/Bun object keys
    // are not. Passing both PATH and Path can make child-process PATH lookup
    // depend on object insertion order, so keep exactly one spelling.
    const key = preferredPathEnvKey(platform, base);
    delete env.PATH;
    delete env.Path;
    env[key] = value;
  } else {
    env.PATH = value;
  }
  return env;
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
   * Raw JSON string of the `tagma` object from apps/electron/package.json.
   * Passed as-is so the sidecar can read whatever fields it needs without
   * the Electron shell having to enumerate them. The shell only unmarshals
   * this to set the legacy per-field env vars; the sidecar may also consume
   * TAGMA_METADATA_JSON directly for forward-compatible config access.
   */
  tagmaMetadataJson?: string;
  /**
   * The Electron app version (app.getVersion()), i.e. the installer version.
   * This is the baseline editor-dist version used by the sidecar to decide
   * whether a hot update is available and to enforce minShellVersion gates.
   */
  appVersion?: string;
  sidecarPreference?: 'auto' | 'bundled';
}

export interface RuntimePaths {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sidecarSource: 'bundled' | 'user' | 'dev';
  sidecarVersion: string | null;
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
  includeUserOpencode: boolean,
): string {
  const sep = platform === 'win32' ? ';' : ':';
  const layers: string[] = [];
  if (userDataDir && includeUserOpencode) {
    layers.push(p.join(userDataDir, 'opencode', 'bin'));
  }
  layers.push(p.join(resourcesPath, 'opencode', 'bin'));
  const existing = readPathEnv(platform);
  return existing ? `${layers.join(sep)}${sep}${existing}` : layers.join(sep);
}

function compareVersions(a: string, b: string): number {
  const pa = parseComparableSemver(a);
  const pb = parseComparableSemver(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = pa[key] - pb[key];
    if (delta !== 0) return delta;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const delta = comparePrereleaseIdentifier(ia, ib);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseComparableSemver(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} {
  const withoutBuild = version.split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return {
    major,
    minor,
    patch,
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  if (a === b) return 0;
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : 1;
}

const SIDECAR_VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sidecarUserDir(p: PathModule, userDataDir: string): string {
  return p.join(userDataDir, 'editor-sidecar');
}

function sidecarCurrentFile(p: PathModule, userDataDir: string): string {
  return p.join(sidecarUserDir(p, userDataDir), 'current.json');
}

function sidecarVersionDir(p: PathModule, userDataDir: string, version: string): string {
  return p.join(sidecarUserDir(p, userDataDir), 'versions', version);
}

const RELEASE_BASELINE_FILE = 'release-baseline.json';

function releaseBaselinePath(p: PathModule, userDataDir: string): string {
  return p.join(userDataDir, RELEASE_BASELINE_FILE);
}

interface UserSidecarPointer {
  version: string;
  /**
   * Optional integrity field — when present, the user override is only
   * trusted if the binary on disk hashes to this value. Format is
   * `sha256-<hex>` / `sha512-<hex>`. New pointers always include this so
   * a tamper of the userData binary fails closed; older pointers without
   * it are still honoured during the transition (the upgrade path will
   * re-write them on next /api/editor/update).
   */
  sha256?: string;
  sha512?: string;
}

const HEX_HASH_RE = /^[0-9a-f]+$/;
const SHA256_LEN = 64;
const SHA512_LEN = 128;

function readUserSidecarPointer(
  fsPath: PathModule,
  userDataDir: string | undefined,
): UserSidecarPointer | null {
  if (!userDataDir) return null;
  try {
    const raw = JSON.parse(readFileSync(sidecarCurrentFile(fsPath, userDataDir), 'utf-8')) as {
      version?: unknown;
      sha256?: unknown;
      sha512?: unknown;
    };
    if (typeof raw.version !== 'string' || !raw.version.trim()) return null;
    const version = raw.version.trim();
    if (!SIDECAR_VERSION_RE.test(version)) return null;
    const out: UserSidecarPointer = { version };
    if (
      typeof raw.sha256 === 'string' &&
      raw.sha256.length === SHA256_LEN &&
      HEX_HASH_RE.test(raw.sha256)
    ) {
      out.sha256 = raw.sha256;
    }
    if (
      typeof raw.sha512 === 'string' &&
      raw.sha512.length === SHA512_LEN &&
      HEX_HASH_RE.test(raw.sha512)
    ) {
      out.sha512 = raw.sha512;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Hash a file with the given algorithm. Returns null on read failure so the
 * caller can treat a torn binary the same as a hash mismatch (refuse to
 * launch). Uses sync I/O — this runs at most twice per sidecar launch and
 * the binaries we hash are 30-100MB; staying sync keeps the launch flow
 * single-threaded and ordered.
 */
function hashFile(filePath: string, algo: 'sha256' | 'sha512'): string | null {
  try {
    const buf = readFileSync(filePath);
    return createHash(algo).update(buf).digest('hex');
  } catch {
    return null;
  }
}

function resolveUserSidecarOverride(
  p: PathModule,
  fsPath: PathModule,
  userDataDir: string | undefined,
  platform: NodeJS.Platform,
): { version: string; command: string } | null {
  const pointer = readUserSidecarPointer(fsPath, userDataDir);
  if (!pointer || !userDataDir) return null;
  const command = p.join(
    sidecarVersionDir(p, userDataDir, pointer.version),
    executableName(platform),
  );
  const commandOnDisk = fsPath.join(
    sidecarVersionDir(fsPath, userDataDir, pointer.version),
    executableName(platform),
  );
  if (!existsSync(commandOnDisk)) return null;
  // Release hardening: user-installed sidecars are trusted only when the
  // activation pointer carries an integrity hash. Earlier transition builds
  // accepted hashless pointers, but that makes the check bypassable by
  // deleting the hash field from current.json.
  if (pointer.sha512) {
    const actual = hashFile(commandOnDisk, 'sha512');
    if (actual !== pointer.sha512) {
      console.warn(
        `[tagma] User-installed sidecar at ${command} failed sha512 verification; ignoring override.`,
      );
      return null;
    }
  } else if (pointer.sha256) {
    const actual = hashFile(commandOnDisk, 'sha256');
    if (actual !== pointer.sha256) {
      console.warn(
        `[tagma] User-installed sidecar at ${command} failed sha256 verification; ignoring override.`,
      );
      return null;
    }
  } else {
    console.warn(
      `[tagma] User-installed sidecar pointer for ${command} has no sha256/sha512; ignoring override.`,
    );
    return null;
  }
  return { version: pointer.version, command };
}

function cleanupStaleUserSidecar(
  fsPath: PathModule,
  userDataDir: string | undefined,
  bundledVersion: string | undefined,
): void {
  if (!userDataDir || !bundledVersion) return;
  const pointer = readUserSidecarPointer(fsPath, userDataDir);
  if (!pointer) return;
  if (compareVersions(pointer.version, bundledVersion) >= 0) return;
  try {
    rmSync(sidecarUserDir(fsPath, userDataDir), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function opencodeUserDir(p: PathModule, userDataDir: string): string {
  return p.join(userDataDir, 'opencode');
}

function readUserOpencodeVersion(
  fsPath: PathModule,
  userDataDir: string | undefined,
): string | null {
  if (!userDataDir) return null;
  const userDir = opencodeUserDir(fsPath, userDataDir);
  try {
    if (!existsSync(userDir)) return null;
    const version = readFileSync(fsPath.join(userDir, 'version.txt'), 'utf-8').trim();
    return SIDECAR_VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

function shouldUseUserOpencode(
  fsPath: PathModule,
  userDataDir: string | undefined,
  bundledVersion: string | undefined,
  options: { allowNewerUserVersion?: boolean } = {},
): boolean {
  if (!userDataDir) return false;
  if (!bundledVersion || !SIDECAR_VERSION_RE.test(bundledVersion)) return true;
  const userDir = opencodeUserDir(fsPath, userDataDir);
  if (!existsSync(userDir)) return false;
  const userVersion = readUserOpencodeVersion(fsPath, userDataDir);
  if (userVersion) {
    const cmp = compareVersions(userVersion, bundledVersion);
    if (cmp === 0) return true;
    if (cmp > 0) return !!options.allowNewerUserVersion;
  }
  try {
    rmSync(userDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return false;
}

export function discardUserSidecarOverride(userDataDir: string): void {
  discardUserSidecarOverrideWithPath(pathFor(process.platform), userDataDir);
}

function discardUserSidecarOverrideWithPath(p: PathModule, userDataDir: string): void {
  try {
    rmSync(sidecarUserDir(p, userDataDir), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export function discardUserReleaseOverride(userDataDir: string): void {
  discardUserReleaseOverrideWithPath(pathFor(process.platform), userDataDir);
}

function discardUserReleaseOverrideWithPath(p: PathModule, userDataDir: string): void {
  discardUserSidecarOverrideWithPath(p, userDataDir);
  try {
    rmSync(p.join(userDataDir, 'editor'), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function readReleaseBaseline(fsPath: PathModule, userDataDir: string | undefined): string | null {
  if (!userDataDir) return null;
  try {
    const raw = JSON.parse(readFileSync(releaseBaselinePath(fsPath, userDataDir), 'utf-8')) as {
      bundledVersion?: unknown;
    };
    if (typeof raw.bundledVersion !== 'string') return null;
    const version = raw.bundledVersion.trim();
    return SIDECAR_VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

function writeReleaseBaseline(
  fsPath: PathModule,
  userDataDir: string | undefined,
  bundledVersion: string | undefined,
): void {
  if (!userDataDir || !bundledVersion || !SIDECAR_VERSION_RE.test(bundledVersion)) return;
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      releaseBaselinePath(fsPath, userDataDir),
      JSON.stringify({ bundledVersion }) + '\n',
      'utf-8',
    );
  } catch {
    /* best-effort */
  }
}

function readUserEditorVersion(fsPath: PathModule, userDataDir: string | undefined): string | null {
  if (!userDataDir) return null;
  try {
    const editorDir = fsPath.join(userDataDir, 'editor');
    if (!existsSync(fsPath.join(editorDir, 'dist', 'index.html'))) return null;
    const version = readFileSync(fsPath.join(editorDir, 'dist-version.txt'), 'utf-8').trim();
    return SIDECAR_VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

function syncReleaseBaseline(
  fsPath: PathModule,
  userDataDir: string | undefined,
  bundledVersion: string | undefined,
): void {
  if (!userDataDir || !bundledVersion || !SIDECAR_VERSION_RE.test(bundledVersion)) return;

  const previousBundledVersion = readReleaseBaseline(fsPath, userDataDir);
  const editorVersion = readUserEditorVersion(fsPath, userDataDir);
  const editorAhead = !!editorVersion && compareVersions(editorVersion, bundledVersion) > 0;

  const installerDowngraded =
    !!previousBundledVersion && compareVersions(bundledVersion, previousBundledVersion) < 0;

  // If the user explicitly launches an older installer, the installer's
  // bundled release must win over any userData hot-update layer. For installs
  // predating this marker, an editor override ahead of the bundled installer is
  // the legacy ambiguous state that caused downgrades to keep showing the newer
  // editor after uninstall/reinstall.
  if (installerDowngraded || (!previousBundledVersion && editorAhead)) {
    discardUserReleaseOverrideWithPath(fsPath, userDataDir);
  }

  writeReleaseBaseline(fsPath, userDataDir, bundledVersion);
}

export interface VersionSkew {
  editorVersion: string;
  sidecarVersion: string;
}

function detectVersionSkewWithPath(fsPath: PathModule, userDataDir: string): VersionSkew | null {
  let editorVersion: string | null = null;
  try {
    const distVersionFile = fsPath.join(userDataDir, 'editor', 'dist-version.txt');
    if (existsSync(distVersionFile)) {
      editorVersion = readFileSync(distVersionFile, 'utf-8').trim() || null;
    }
  } catch {
    /* treat unreadable as absent */
  }

  const sidecarPointer = readUserSidecarPointer(fsPath, userDataDir);
  const sidecarVersion = sidecarPointer?.version ?? null;

  if (!editorVersion || !sidecarVersion) return null;
  if (editorVersion === sidecarVersion) return null;
  return { editorVersion, sidecarVersion };
}

/**
 * Detect the rare case where the bundle update's two activations were
 * interrupted mid-flip, leaving the user-installed editor pointer and the
 * user-installed sidecar pointer on different versions. Reads both pointers
 * from `userDataDir` and returns a descriptor when they disagree, or null
 * when they match / at least one is absent.
 */
export function detectVersionSkew(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): VersionSkew | null {
  return detectVersionSkewWithPath(pathFor(platform), userDataDir);
}

export function resolveRuntimePaths(options: RuntimePathOptions): RuntimePaths {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  const fsPath = pathFor(process.platform);

  let metadata: Record<string, unknown> = {};
  try {
    if (options.tagmaMetadataJson) {
      metadata = JSON.parse(options.tagmaMetadataJson);
    }
  } catch {
    /* ignore malformed JSON */
  }

  const bundledOpencodeVersion =
    typeof metadata.bundledOpencodeVersion === 'string'
      ? metadata.bundledOpencodeVersion
      : undefined;
  const editorUpdateChannel = typeof metadata.channel === 'string' ? metadata.channel : undefined;
  const editorUpdateManifestBaseUrl =
    typeof metadata.updateManifestBaseUrl === 'string' ? metadata.updateManifestBaseUrl : undefined;
  const updateManifestPublicKey =
    typeof metadata.updateManifestPublicKey === 'string'
      ? metadata.updateManifestPublicKey
      : undefined;

  if (options.isPackaged) {
    const sidecarDir = p.join(options.resourcesPath, 'editor-sidecar');
    // Plugin install runs `bun install` inside an isolated workspace under
    // `.tagma/plugin-store/<name>`. The packaged sidecar's process.execPath
    // points at the compiled `tagma-editor-server` binary, NOT at bun, so
    // running `[execPath, 'install', ...]` from that single-file binary would
    // re-launch the sidecar. Resolve a bundled `bun` executable if the
    // installer ships one, and pass it down through TAGMA_BUN_BIN. When no
    // bundled bun is present we leave the variable unset so the sidecar's
    // resolveBunBinary helper can throw a clear "set TAGMA_BUN_BIN" error
    // instead of silently corrupting the plugin store.
    const bundledBun = (() => {
      const candidates = [
        p.join(options.resourcesPath, 'bun', 'bin', platform === 'win32' ? 'bun.exe' : 'bun'),
        p.join(options.resourcesPath, 'bun', platform === 'win32' ? 'bun.exe' : 'bun'),
      ];
      return candidates.find((c) => existsSync(c)) ?? null;
    })();
    syncReleaseBaseline(fsPath, options.userDataDir, options.appVersion);
    cleanupStaleUserSidecar(fsPath, options.userDataDir, options.appVersion);
    if (options.userDataDir) {
      const skew = detectVersionSkewWithPath(fsPath, options.userDataDir);
      if (skew) {
        console.warn(
          `[tagma] Version skew detected after last update: editor ${skew.editorVersion}, sidecar ${skew.sidecarVersion}. Re-run "Update Tagma" from the editor to realign.`,
        );
      }
    }
    const userOverride =
      options.sidecarPreference === 'bundled'
        ? null
        : resolveUserSidecarOverride(p, fsPath, options.userDataDir, platform);
    const includeUserOpencode = shouldUseUserOpencode(
      fsPath,
      options.userDataDir,
      bundledOpencodeVersion,
      {
        allowNewerUserVersion:
          !!userOverride || process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE === '1',
      },
    );
    const sidecarPath = buildSidecarPath(
      p,
      options.resourcesPath,
      options.userDataDir,
      platform,
      includeUserOpencode,
    );
    const sidecarSource: RuntimePaths['sidecarSource'] = userOverride ? 'user' : 'bundled';
    const sidecarVersion = userOverride?.version ?? options.appVersion ?? null;
    const env: NodeJS.ProcessEnv = withPathEnv(
      {
        ...process.env,
        PORT: '0',
        TAGMA_EDITOR_DIST_DIR: p.join(options.resourcesPath, 'editor-dist'),
        TAGMA_SIDECAR_ACTIVE_SOURCE: sidecarSource,
        ...(sidecarVersion ? { TAGMA_SIDECAR_ACTIVE_VERSION: sidecarVersion } : {}),
        // Sidecar reads these to power the OpenCode CLI section in Settings
        // (current install check, bundled-version display, update target dir).
        TAGMA_OPENCODE_BUNDLED_DIR: p.join(options.resourcesPath, 'opencode'),
        ...(bundledBun ? { TAGMA_BUN_BIN: bundledBun } : {}),
      },
      sidecarPath,
      platform,
    );
    if (options.userDataDir) {
      const opencodeUserDir = p.join(options.userDataDir, 'opencode');
      env.TAGMA_OPENCODE_USER_DIR = opencodeUserDir;
      if (includeUserOpencode) {
        env.TAGMA_OPENCODE_RUNTIME_USER_DIR = opencodeUserDir;
      } else {
        env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
      }
      // Editor hot-update writable layer: userData/editor-dist wins over the
      // bundled resources/editor-dist when present (static-assets.ts picks it
      // up). This is the destination path for /api/editor/update to stage a
      // fresh frontend bundle into.
      env.TAGMA_EDITOR_USER_DIR = p.join(options.userDataDir, 'editor');
      env.TAGMA_EDITOR_USER_DIST_DIR = p.join(options.userDataDir, 'editor', 'dist');
      env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir(p, options.userDataDir);
    }
    if (bundledOpencodeVersion) {
      env.TAGMA_OPENCODE_BUNDLED_VERSION = bundledOpencodeVersion;
    }
    if (options.appVersion) {
      env.TAGMA_EDITOR_BUNDLED_VERSION = options.appVersion;
      env.TAGMA_SIDECAR_BUNDLED_VERSION = options.appVersion;
    }
    if (editorUpdateChannel) {
      env.TAGMA_EDITOR_UPDATE_CHANNEL = editorUpdateChannel;
      env.TAGMA_SIDECAR_UPDATE_CHANNEL = editorUpdateChannel;
    }
    if (editorUpdateManifestBaseUrl) {
      env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = editorUpdateManifestBaseUrl;
      env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL = editorUpdateManifestBaseUrl;
    }
    if (updateManifestPublicKey) {
      env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY = updateManifestPublicKey;
    }
    env.TAGMA_METADATA_JSON = options.tagmaMetadataJson ?? '{}';
    return {
      command: userOverride?.command ?? p.join(sidecarDir, executableName(platform)),
      args: [],
      cwd: options.userDataDir ?? sidecarDir,
      env,
      sidecarSource,
      sidecarVersion,
    };
  }

  const sidecarVersion = options.appVersion ?? null;
  const editorDir = p.resolve(options.compiledDir, '..', '..', 'editor');
  const devSidecarPort = process.env.TAGMA_DESKTOP_SIDECAR_PORT?.trim();
  const devPort = devSidecarPort && /^\d+$/.test(devSidecarPort) ? devSidecarPort : '0';
  return {
    command: 'bun',
    args: [p.join(editorDir, 'server', 'index.ts')],
    cwd: editorDir,
    env: {
      ...process.env,
      PORT: devPort,
      TAGMA_EDITOR_DIST_DIR: p.join(editorDir, 'dist'),
      TAGMA_SIDECAR_ACTIVE_SOURCE: 'dev',
      ...(sidecarVersion ? { TAGMA_SIDECAR_ACTIVE_VERSION: sidecarVersion } : {}),
      ...(sidecarVersion ? { TAGMA_SIDECAR_BUNDLED_VERSION: sidecarVersion } : {}),
      ...(editorUpdateChannel ? { TAGMA_SIDECAR_UPDATE_CHANNEL: editorUpdateChannel } : {}),
      ...(editorUpdateManifestBaseUrl
        ? { TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL: editorUpdateManifestBaseUrl }
        : {}),
      ...(updateManifestPublicKey
        ? { TAGMA_UPDATE_MANIFEST_PUBLIC_KEY: updateManifestPublicKey }
        : {}),
    },
    sidecarSource: 'dev',
    sidecarVersion,
  };
}
