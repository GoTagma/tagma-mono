import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir as systemHomedir } from 'node:os';
import { posix, win32, type PlatformPath } from 'node:path';

export const CHAT_OPERATION_V2_DATABASE_FILENAME = 'chat-operation-v2.sqlite';
export const CHAT_OPERATION_V2_KEY_FILENAME = 'control-hmac-v2.key';

export interface ChatOperationV2ControlOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

export interface ChatOperationV2ControlPaths {
  controlDir: string;
  databasePath: string;
  keyPath: string;
}

export interface ChatOperationV2ControlKeyOptions {
  platform?: NodeJS.Platform;
  randomBytes?: (size: number) => Uint8Array;
  fileSystem?: ChatOperationV2ControlFileSystem;
}

export interface ChatOperationV2ControlFileSystem {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  lstatSync(path: string): ChatOperationV2ControlFileStat;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array, options: { flag: 'wx'; mode: number }): void;
}

export interface ChatOperationV2ControlFileStat {
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ChatOperationV2ControlKey {
  readonly key: Buffer;
  readonly keyId: string;
  readonly created: boolean;
}

export interface PrepareChatOperationV2ControlOptions
  extends ChatOperationV2ControlOptions, ChatOperationV2ControlKeyOptions {}

export interface PreparedChatOperationV2Control
  extends ChatOperationV2ControlPaths, ChatOperationV2ControlKey {}

const DEFAULT_CONTROL_FILE_SYSTEM: ChatOperationV2ControlFileSystem = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  lstatSync: (path) => lstatSync(path),
  readFileSync: (path) => readFileSync(path),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
};

function pathApiFor(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix;
}

function isStableAbsolutePath(platform: NodeJS.Platform, path: string): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path);
  return win32.isAbsolute(path) && win32.parse(path).root.length > 1;
}

export function resolveChatOperationV2ControlPaths(
  options: ChatOperationV2ControlOptions = {},
): ChatOperationV2ControlPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? systemHomedir;
  const pathApi = pathApiFor(platform);
  const explicitDir = env.TAGMA_CHAT_CONTROL_DIR;
  const editorUserDir = env.TAGMA_EDITOR_USER_DIR;
  let controlDir: string;

  if (explicitDir) {
    if (!isStableAbsolutePath(platform, explicitDir)) {
      throw new Error('TAGMA_CHAT_CONTROL_DIR must be an absolute path.');
    }
    controlDir = pathApi.normalize(explicitDir);
  } else if (editorUserDir) {
    if (!isStableAbsolutePath(platform, editorUserDir)) {
      throw new Error('TAGMA_EDITOR_USER_DIR must be an absolute path.');
    }
    controlDir = pathApi.join(pathApi.dirname(pathApi.normalize(editorUserDir)), 'server-control');
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData || !isStableAbsolutePath(platform, localAppData)) {
      throw new Error(
        'LOCALAPPDATA must be an absolute path when no explicit Chat control directory is configured.',
      );
    }
    controlDir = win32.join(localAppData, 'Tagma', 'server-control');
  } else if (platform === 'darwin') {
    const home = homedir();
    if (!posix.isAbsolute(home)) {
      throw new Error('The macOS home directory must be an absolute path.');
    }
    controlDir = posix.join(home, 'Library', 'Application Support', 'Tagma', 'server-control');
  } else if (platform === 'linux') {
    const stateHome = env.XDG_STATE_HOME || posix.join(homedir(), '.local', 'state');
    if (!posix.isAbsolute(stateHome)) {
      throw new Error(
        'XDG_STATE_HOME or the Linux home directory must resolve to an absolute path.',
      );
    }
    controlDir = posix.join(stateHome, 'tagma', 'server-control');
  } else {
    throw new Error(
      `Unsupported platform for the ChatTurn Operation V2 control directory: ${platform}`,
    );
  }

  return {
    controlDir,
    databasePath: pathApi.join(controlDir, CHAT_OPERATION_V2_DATABASE_FILENAME),
    keyPath: pathApi.join(controlDir, CHAT_OPERATION_V2_KEY_FILENAME),
  };
}

function controlKeyResult(key: Uint8Array, created: boolean): ChatOperationV2ControlKey {
  const keyBuffer = Buffer.from(key);
  const result = {
    keyId: `sha256:${createHash('sha256').update(keyBuffer).digest('hex')}`,
    created,
  } as ChatOperationV2ControlKey;
  Object.defineProperty(result, 'key', {
    value: keyBuffer,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assertControlKeyLength(key: Uint8Array, source: string): void {
  if (key.byteLength !== 32) {
    throw new Error(
      `ChatTurn Operation V2 ${source} must contain exactly 32 bytes; found ${key.byteLength}.`,
    );
  }
}

function assertPrivatePosixMode(
  stat: ChatOperationV2ControlFileStat,
  platform: NodeJS.Platform,
  label: string,
  expectedMode: number,
): void {
  if (platform !== 'win32' && (stat.mode & 0o777) !== expectedMode) {
    throw new Error(
      `${label} must use POSIX mode ${expectedMode.toString(8).padStart(4, '0')} without group or world permissions.`,
    );
  }
}

function assertControlDirectory(
  fileSystem: ChatOperationV2ControlFileSystem,
  controlDir: string,
  platform: NodeJS.Platform,
): void {
  const stat = fileSystem.lstatSync(controlDir);
  if (stat.isSymbolicLink()) {
    throw new Error('The ChatTurn Operation V2 control directory must not be a symbolic link.');
  }
  if (!stat.isDirectory()) {
    throw new Error('The ChatTurn Operation V2 control directory must be a directory.');
  }
  assertPrivatePosixMode(stat, platform, 'The ChatTurn Operation V2 control directory', 0o700);
}

function assertControlKeyFile(
  fileSystem: ChatOperationV2ControlFileSystem,
  keyPath: string,
  platform: NodeJS.Platform,
): void {
  const stat = fileSystem.lstatSync(keyPath);
  if (stat.isSymbolicLink()) {
    throw new Error('The ChatTurn Operation V2 control key must not be a symbolic link.');
  }
  if (!stat.isFile()) {
    throw new Error('The ChatTurn Operation V2 control key must be a regular file.');
  }
  assertPrivatePosixMode(stat, platform, 'The ChatTurn Operation V2 control key', 0o600);
}

export function loadOrCreateChatOperationV2ControlKey(
  keyPath: string,
  options: ChatOperationV2ControlKeyOptions = {},
): ChatOperationV2ControlKey {
  const platform = options.platform ?? process.platform;
  const pathApi = pathApiFor(platform);
  if (!isStableAbsolutePath(platform, keyPath)) {
    throw new Error('The ChatTurn Operation V2 control key must use an absolute path.');
  }
  const randomBytes = options.randomBytes ?? systemRandomBytes;
  const fileSystem = options.fileSystem ?? DEFAULT_CONTROL_FILE_SYSTEM;
  const controlDir = pathApi.dirname(keyPath);
  fileSystem.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  assertControlDirectory(fileSystem, controlDir, platform);

  let keyExists = true;
  try {
    assertControlKeyFile(fileSystem, keyPath, platform);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    keyExists = false;
  }
  if (keyExists) {
    const existingKey = fileSystem.readFileSync(keyPath);
    assertControlKeyLength(existingKey, 'control key');
    return controlKeyResult(existingKey, false);
  }

  const key = Buffer.from(randomBytes(32));
  assertControlKeyLength(key, 'generated control key');
  try {
    fileSystem.writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    assertControlKeyFile(fileSystem, keyPath, platform);
    const winningKey = fileSystem.readFileSync(keyPath);
    assertControlKeyLength(winningKey, 'control key');
    return controlKeyResult(winningKey, false);
  }
  assertControlKeyFile(fileSystem, keyPath, platform);
  return controlKeyResult(key, true);
}

export function prepareChatOperationV2Control(
  options: PrepareChatOperationV2ControlOptions = {},
): PreparedChatOperationV2Control {
  const paths = resolveChatOperationV2ControlPaths(options);
  const keyMaterial = loadOrCreateChatOperationV2ControlKey(paths.keyPath, options);
  const prepared = {
    ...paths,
    keyId: keyMaterial.keyId,
    created: keyMaterial.created,
  } as PreparedChatOperationV2Control;
  Object.defineProperty(prepared, 'key', {
    value: keyMaterial.key,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(prepared);
}
