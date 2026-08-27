import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

import {
  loadOrCreateChatOperationV2ControlKey,
  prepareChatOperationV2Control,
  resolveChatOperationV2ControlPaths,
} from '../server/chat-operations/control-root';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-control-'));
  tempRoots.push(root);
  return root;
}

function writePrivateControlKeyFixture(keyPath: string, contents: Uint8Array): void {
  const controlDir = dirname(keyPath);
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  chmodSync(controlDir, 0o700);
  writeFileSync(keyPath, contents, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}

function directoryStat(mode = 0o700) {
  return {
    mode,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
}

function fileStat(mode = 0o600) {
  return {
    mode,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function fileSystemError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit absolute chat control directory has highest priority', () => {
  const controlDir = win32.join('D:\\', 'Tagma control');

  expect(
    resolveChatOperationV2ControlPaths({
      env: {
        TAGMA_CHAT_CONTROL_DIR: controlDir,
        TAGMA_EDITOR_USER_DIR: win32.join('C:\\', 'Tagma', 'editor'),
        LOCALAPPDATA: win32.join('C:\\', 'Users', 'test', 'AppData', 'Local'),
      },
      platform: 'win32',
      homedir: () => win32.join('C:\\', 'Users', 'test'),
    }),
  ).toEqual({
    controlDir,
    databasePath: win32.join(controlDir, 'chat-operation-v2.sqlite'),
    keyPath: win32.join(controlDir, 'control-hmac-v2.key'),
  });
});

test('the editor user directory resolves to its sibling server-control directory', () => {
  const editorUserDir = win32.join('C:\\', 'Users', 'test', 'Tagma', 'editor');
  const controlDir = win32.join('C:\\', 'Users', 'test', 'Tagma', 'server-control');

  expect(
    resolveChatOperationV2ControlPaths({
      env: {
        TAGMA_EDITOR_USER_DIR: editorUserDir,
        LOCALAPPDATA: win32.join('C:\\', 'ignored'),
      },
      platform: 'win32',
      homedir: () => win32.join('C:\\', 'Users', 'test'),
    }),
  ).toEqual({
    controlDir,
    databasePath: win32.join(controlDir, 'chat-operation-v2.sqlite'),
    keyPath: win32.join(controlDir, 'control-hmac-v2.key'),
  });
});

test('platform defaults use only stable operating-system state directories', () => {
  const windowsLocalAppData = win32.join('C:\\', 'Users', 'test', 'AppData', 'Local');
  const linuxHome = '/home/test';

  expect(
    resolveChatOperationV2ControlPaths({
      env: { LOCALAPPDATA: windowsLocalAppData },
      platform: 'win32',
      homedir: () => win32.join('C:\\', 'Users', 'ignored'),
    }).controlDir,
  ).toBe(win32.join(windowsLocalAppData, 'Tagma', 'server-control'));
  expect(
    resolveChatOperationV2ControlPaths({
      env: {},
      platform: 'darwin',
      homedir: () => '/Users/test',
    }).controlDir,
  ).toBe('/Users/test/Library/Application Support/Tagma/server-control');
  expect(
    resolveChatOperationV2ControlPaths({
      env: { XDG_STATE_HOME: '/var/lib/test-state' },
      platform: 'linux',
      homedir: () => linuxHome,
    }).controlDir,
  ).toBe('/var/lib/test-state/tagma/server-control');
  expect(
    resolveChatOperationV2ControlPaths({
      env: {},
      platform: 'linux',
      homedir: () => linuxHome,
    }).controlDir,
  ).toBe(posix.join(linuxHome, '.local', 'state', 'tagma', 'server-control'));
});

test('invalid authority coordinates fail closed instead of falling back to repo or temp paths', () => {
  const windowsFallback = win32.join('C:\\', 'Users', 'test', 'AppData', 'Local');

  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: {
        TAGMA_CHAT_CONTROL_DIR: 'repo-local-control',
        LOCALAPPDATA: windowsFallback,
      },
      platform: 'win32',
      homedir: () => win32.join('C:\\', 'Users', 'test'),
    }),
  ).toThrow(/TAGMA_CHAT_CONTROL_DIR must be an absolute path/i);
  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: {
        TAGMA_EDITOR_USER_DIR: 'relative-editor-user',
        LOCALAPPDATA: windowsFallback,
      },
      platform: 'win32',
    }),
  ).toThrow(/TAGMA_EDITOR_USER_DIR must be an absolute path/i);
  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: {},
      platform: 'win32',
      homedir: () => tmpdir(),
    }),
  ).toThrow(/LOCALAPPDATA must be an absolute path/i);
  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: { XDG_STATE_HOME: 'relative-state' },
      platform: 'linux',
      homedir: () => '/home/test',
    }),
  ).toThrow(/absolute path/i);
  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: {},
      platform: 'freebsd',
      homedir: () => '/home/test',
    }),
  ).toThrow(/unsupported platform/i);
});

test('Windows authority paths must be fully qualified instead of current-drive rooted', () => {
  const currentDriveRooted = win32.join('\\', 'Tagma', 'server-control');

  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: {
        TAGMA_CHAT_CONTROL_DIR: currentDriveRooted,
        LOCALAPPDATA: win32.join('C:\\', 'Users', 'test', 'AppData', 'Local'),
      },
      platform: 'win32',
    }),
  ).toThrow(/absolute path/i);
  expect(() =>
    resolveChatOperationV2ControlPaths({
      env: { LOCALAPPDATA: currentDriveRooted },
      platform: 'win32',
    }),
  ).toThrow(/absolute path/i);
});

test('first key creation persists exactly 32 injected random bytes and exposes only a fingerprint', () => {
  const keyPath = join(makeTempRoot(), 'server-control', 'control-hmac-v2.key');
  const expectedKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const requestedSizes: number[] = [];

  const result = loadOrCreateChatOperationV2ControlKey(keyPath, {
    randomBytes: (size) => {
      requestedSizes.push(size);
      return expectedKey;
    },
  });

  expect(result.created).toBe(true);
  expect(result.key).toBeInstanceOf(Buffer);
  expect(result.key).toEqual(expectedKey);
  expect(readFileSync(keyPath)).toEqual(expectedKey);
  expect(requestedSizes).toEqual([32]);
  expect(result.keyId).toBe(`sha256:${createHash('sha256').update(expectedKey).digest('hex')}`);
  expect(Object.keys(result)).not.toContain('key');
  expect(JSON.stringify(result)).not.toContain(expectedKey.toString('hex'));
});

test('an existing 32-byte control key is reused without requesting new randomness', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  const existingKey = Buffer.alloc(32, 0xa5);
  writePrivateControlKeyFixture(keyPath, existingKey);

  const result = loadOrCreateChatOperationV2ControlKey(keyPath, {
    randomBytes: () => {
      throw new Error('existing keys must not be regenerated');
    },
  });

  expect(result.created).toBe(false);
  expect(result.key).toEqual(existingKey);
  expect(readFileSync(keyPath)).toEqual(existingKey);
});

test('a corrupt existing control key fails fast without overwrite or regeneration', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  const corruptKey = Buffer.alloc(31, 0xcc);
  let randomCalls = 0;
  writePrivateControlKeyFixture(keyPath, corruptKey);

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      randomBytes: () => {
        randomCalls += 1;
        return Buffer.alloc(32, 0xdd);
      },
    }),
  ).toThrow(/exactly 32 bytes/i);
  expect(randomCalls).toBe(0);
  expect(readFileSync(keyPath)).toEqual(corruptKey);
});

test('an exclusive-create race reuses the winner and never overwrites it', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  const losingCandidate = Buffer.alloc(32, 0x11);
  const winningKey = Buffer.alloc(32, 0x22);
  const mkdirs: Array<{ path: string; recursive: true; mode: number }> = [];
  const writes: Array<{ data: Buffer; flag: string; mode: number }> = [];
  let reads = 0;
  let writeAttempted = false;

  const result = loadOrCreateChatOperationV2ControlKey(keyPath, {
    randomBytes: () => losingCandidate,
    fileSystem: {
      mkdirSync: (path, options) => {
        mkdirs.push({ path, ...options });
      },
      lstatSync: (path) => {
        if (path === controlDir) return directoryStat();
        if (!writeAttempted) throw fileSystemError('ENOENT', 'missing');
        return fileStat();
      },
      readFileSync: () => {
        reads += 1;
        return winningKey;
      },
      writeFileSync: (_path, data, options) => {
        writeAttempted = true;
        writes.push({ data: Buffer.from(data), ...options });
        throw fileSystemError('EEXIST', 'won by another process');
      },
    },
  });

  expect(result.created).toBe(false);
  expect(result.key).toEqual(winningKey);
  expect(reads).toBe(1);
  expect(mkdirs).toEqual([{ path: controlDir, recursive: true, mode: 0o700 }]);
  expect(writes).toEqual([{ data: losingCandidate, flag: 'wx', mode: 0o600 }]);
});

test('permission failures while reading an existing key fail before generation or writes', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  let randomCalls = 0;
  let writeCalls = 0;

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      randomBytes: () => {
        randomCalls += 1;
        return Buffer.alloc(32);
      },
      fileSystem: {
        mkdirSync: () => undefined,
        lstatSync: (path) => (path === controlDir ? directoryStat() : fileStat()),
        readFileSync: () => {
          throw fileSystemError('EACCES', 'permission denied');
        },
        writeFileSync: () => {
          writeCalls += 1;
        },
      },
    }),
  ).toThrow(/permission denied/i);
  expect(randomCalls).toBe(0);
  expect(writeCalls).toBe(0);
});

test('permission failure during exclusive creation is not retried or treated as a race', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  let reads = 0;
  let writes = 0;

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      randomBytes: () => Buffer.alloc(32, 0x33),
      fileSystem: {
        mkdirSync: () => undefined,
        lstatSync: (path) => {
          if (path === controlDir) return directoryStat();
          throw fileSystemError('ENOENT', 'missing');
        },
        readFileSync: () => {
          reads += 1;
          throw fileSystemError('ENOENT', 'unexpected key read');
        },
        writeFileSync: () => {
          writes += 1;
          throw fileSystemError('EACCES', 'write permission denied');
        },
      },
    }),
  ).toThrow(/write permission denied/i);
  expect(reads).toBe(0);
  expect(writes).toBe(1);
});

test('a key missing after an exclusive-create collision fails without a regeneration retry', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  let reads = 0;
  let randomCalls = 0;
  let writes = 0;
  let writeAttempted = false;

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      randomBytes: () => {
        randomCalls += 1;
        return Buffer.alloc(32, 0x44);
      },
      fileSystem: {
        mkdirSync: () => undefined,
        lstatSync: (path) => {
          if (path === controlDir) return directoryStat();
          if (!writeAttempted) throw fileSystemError('ENOENT', 'missing');
          return fileStat();
        },
        readFileSync: () => {
          reads += 1;
          throw fileSystemError('ENOENT', 'key disappeared');
        },
        writeFileSync: () => {
          writes += 1;
          writeAttempted = true;
          throw fileSystemError('EEXIST', 'exclusive create collision');
        },
      },
    }),
  ).toThrow(/key disappeared/i);
  expect(reads).toBe(1);
  expect(randomCalls).toBe(1);
  expect(writes).toBe(1);
});

test('the key loader refuses a relative authority path before touching the filesystem', () => {
  let fileSystemCalls = 0;
  const fileSystem = {
    mkdirSync: () => {
      fileSystemCalls += 1;
    },
    lstatSync: () => {
      fileSystemCalls += 1;
      return fileStat();
    },
    readFileSync: () => {
      fileSystemCalls += 1;
      return Buffer.alloc(32);
    },
    writeFileSync: () => {
      fileSystemCalls += 1;
    },
  };

  expect(() =>
    loadOrCreateChatOperationV2ControlKey('repo-local-control.key', {
      fileSystem,
    }),
  ).toThrow(/absolute path/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(win32.join('\\', 'Tagma', 'control.key'), {
      platform: 'win32',
      fileSystem,
    }),
  ).toThrow(/absolute path/i);
  expect(fileSystemCalls).toBe(0);
});

test('a faulty random source cannot create a non-32-byte key', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const keyPath = join(controlDir, 'control-hmac-v2.key');
  let writes = 0;

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      randomBytes: () => Buffer.alloc(16, 0xee),
      fileSystem: {
        mkdirSync: () => undefined,
        lstatSync: (path) => {
          if (path === controlDir) return directoryStat();
          throw fileSystemError('ENOENT', 'missing');
        },
        readFileSync: () => {
          throw fileSystemError('ENOENT', 'unexpected key read');
        },
        writeFileSync: () => {
          writes += 1;
        },
      },
    }),
  ).toThrow(/exactly 32 bytes/i);
  expect(writes).toBe(0);
});

test('symbolic-link control directories and key files are rejected before key reads', () => {
  const controlDir = win32.join('C:\\', 'Tagma', 'server-control');
  const keyPath = win32.join(controlDir, 'control-hmac-v2.key');
  const regularDirectory = {
    mode: 0o700,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const symbolicLink = {
    mode: 0o777,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
  };
  let reads = 0;

  const fileSystem = (linkedPath: string) => ({
    mkdirSync: () => undefined,
    lstatSync: (path: string) => (path === linkedPath ? symbolicLink : regularDirectory),
    readFileSync: () => {
      reads += 1;
      return Buffer.alloc(32);
    },
    writeFileSync: () => undefined,
  });

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'win32',
      fileSystem: fileSystem(controlDir),
    }),
  ).toThrow(/control directory.*symbolic link/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'win32',
      fileSystem: fileSystem(keyPath),
    }),
  ).toThrow(/control key.*symbolic link/i);
  expect(reads).toBe(0);
});

test('the control directory and existing key must have their required filesystem types', () => {
  const controlDir = posix.join('/state', 'tagma', 'server-control');
  const keyPath = posix.join(controlDir, 'control-hmac-v2.key');
  const nonDirectory = fileStat(0o600);
  const nonFile = directoryStat(0o700);
  let reads = 0;

  const fileSystem = (controlStat: ReturnType<typeof directoryStat>, keyStat: typeof nonFile) => ({
    mkdirSync: () => undefined,
    lstatSync: (path: string) => (path === controlDir ? controlStat : keyStat),
    readFileSync: () => {
      reads += 1;
      return Buffer.alloc(32);
    },
    writeFileSync: () => undefined,
  });

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      fileSystem: fileSystem(nonDirectory, fileStat()),
    }),
  ).toThrow(/control directory must be a directory/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      fileSystem: fileSystem(directoryStat(), nonFile),
    }),
  ).toThrow(/control key must be a regular file/i);
  expect(reads).toBe(0);
});

test('POSIX control directories and existing keys reject group or world permissions', () => {
  const controlDir = posix.join('/state', 'tagma', 'server-control');
  const keyPath = posix.join(controlDir, 'control-hmac-v2.key');
  let reads = 0;
  let randomCalls = 0;
  let writes = 0;

  const fileSystem = (directoryMode: number, keyMode: number) => ({
    mkdirSync: () => undefined,
    lstatSync: (path: string) =>
      path === controlDir ? directoryStat(directoryMode) : fileStat(keyMode),
    readFileSync: () => {
      reads += 1;
      return Buffer.alloc(32);
    },
    writeFileSync: () => {
      writes += 1;
    },
  });
  const randomBytes = () => {
    randomCalls += 1;
    return Buffer.alloc(32);
  };

  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      randomBytes,
      fileSystem: fileSystem(0o750, 0o600),
    }),
  ).toThrow(/control directory.*group or world permissions/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      randomBytes,
      fileSystem: fileSystem(0o700, 0o640),
    }),
  ).toThrow(/control key.*group or world permissions/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      randomBytes,
      fileSystem: fileSystem(0o600, 0o600),
    }),
  ).toThrow(/control directory.*mode 0700/i);
  expect(() =>
    loadOrCreateChatOperationV2ControlKey(keyPath, {
      platform: 'linux',
      randomBytes,
      fileSystem: fileSystem(0o700, 0o400),
    }),
  ).toThrow(/control key.*mode 0600/i);
  expect(reads).toBe(0);
  expect(randomCalls).toBe(0);
  expect(writes).toBe(0);
});

test('preparing control material creates only the stable key and returns the future database path', () => {
  const controlDir = join(makeTempRoot(), 'server-control');
  const key = Buffer.alloc(32, 0x7b);

  const prepared = prepareChatOperationV2Control({
    env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    randomBytes: () => key,
  });

  expect(prepared).toMatchObject({
    controlDir,
    databasePath: join(controlDir, 'chat-operation-v2.sqlite'),
    keyPath: join(controlDir, 'control-hmac-v2.key'),
    keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
    created: true,
  });
  expect(prepared.key).toEqual(key);
  expect(Object.keys(prepared)).not.toContain('key');
  expect(existsSync(prepared.keyPath)).toBe(true);
  expect(existsSync(prepared.databasePath)).toBe(false);
});
