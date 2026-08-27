import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalizeWorkspacePath,
  computeWorkspaceScopeRecordHmac,
  createTrustedWorkspaceScopeRecord,
  createWorkspaceIdentity,
  isTrustedWorkspaceScopeRecord,
  parseTrustedWorkspaceScopeRecord,
} from '../server/chat-operations/workspace-identity';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const RECORD_HMAC_DOMAIN = 'tagma.chat-operation-v2.workspace-scope-record';
const RECORD_HMAC_VERSION = 1;
const roots: string[] = [];

function expectedRecordHmac(fields: {
  workspaceScopeId: string;
  canonicalPath: string;
  createdAt: number;
  controlGeneration: number;
}): string {
  const canonicalRecord = JSON.stringify([
    RECORD_HMAC_VERSION,
    fields.workspaceScopeId,
    fields.canonicalPath,
    fields.createdAt,
    fields.controlGeneration,
  ]);
  return createHmac('sha256', TEST_KEY)
    .update(RECORD_HMAC_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalRecord, 'utf8')
    .digest('hex');
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-workspace-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ChatTurn Operation V2 workspace identity', () => {
  test('uses native real paths and collapses symbolic-link aliases to one canonical identity', () => {
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const expectedRealPath = realpathSync.native(workspace).replace(/\\/g, '/');
    const expectedCanonicalPath =
      process.platform === 'win32' ? expectedRealPath.toLowerCase() : expectedRealPath;
    const direct = createWorkspaceIdentity(workspace, TEST_KEY);
    const throughAlias = createWorkspaceIdentity(alias, TEST_KEY);

    expect(direct.canonicalPath).toBe(expectedCanonicalPath);
    expect(throughAlias).toEqual(direct);
  });

  test('normalizes Windows drive, UNC, separator, and path casing for identity', () => {
    const realpathNative = (value: string) => value;

    const driveIdentity = createWorkspaceIdentity('C:\\Team\\Tagma\\', TEST_KEY, {
      platform: 'win32',
      realpathNative,
    });
    const driveAlias = createWorkspaceIdentity('c:/team/TAGMA', TEST_KEY, {
      platform: 'win32',
      realpathNative,
    });
    const uncIdentity = createWorkspaceIdentity('\\\\Server\\Share\\Tagma\\', TEST_KEY, {
      platform: 'win32',
      realpathNative,
    });
    const uncAlias = createWorkspaceIdentity('//server/share/tagma', TEST_KEY, {
      platform: 'win32',
      realpathNative,
    });

    expect(driveIdentity).toEqual(driveAlias);
    expect(driveIdentity.canonicalPath).toBe('c:/team/tagma');
    expect(uncIdentity).toEqual(uncAlias);
    expect(uncIdentity.canonicalPath).toBe('//server/share/tagma');
  });

  test('keeps POSIX path casing significant while normalizing its coordinate', () => {
    const realpathNative = (value: string) => value;
    const upper = createWorkspaceIdentity('/srv/Tagma/', TEST_KEY, {
      platform: 'linux',
      realpathNative,
    });
    const lower = createWorkspaceIdentity('/srv/tagma', TEST_KEY, {
      platform: 'linux',
      realpathNative,
    });

    expect(upper.canonicalPath).toBe('/srv/Tagma');
    expect(lower.canonicalPath).toBe('/srv/tagma');
    expect(lower.canonicalPathHmac).not.toBe(upper.canonicalPathHmac);
  });

  test('creates a deterministic SHA-256 HMAC from a provided stable 32-byte key', () => {
    const identity = createWorkspaceIdentity('/srv/tagma', TEST_KEY, {
      platform: 'linux',
      realpathNative: (value) => value,
    });

    expect(identity.canonicalPathHmac).toBe(
      createHmac('sha256', TEST_KEY).update('/srv/tagma', 'utf8').digest('hex'),
    );
    expect(identity.canonicalPathHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      createWorkspaceIdentity('/srv/tagma', Buffer.alloc(31), {
        platform: 'linux',
        realpathNative: (value) => value,
      }),
    ).toThrow(/32 bytes/i);
  });

  test('creates and validates the complete trusted workspace-scope record', () => {
    const record = createTrustedWorkspaceScopeRecord(
      {
        workspaceScopeId: 'scope-0001',
        workspacePath: '/srv/tagma',
        createdAt: 1_777_777_777_777,
        controlGeneration: 1,
      },
      TEST_KEY,
      {
        platform: 'linux',
        realpathNative: (value) => value,
      },
    );

    expect(record).toEqual({
      workspaceScopeId: 'scope-0001',
      canonicalPathHmac: createHmac('sha256', TEST_KEY).update('/srv/tagma', 'utf8').digest('hex'),
      canonicalPath: '/srv/tagma',
      createdAt: 1_777_777_777_777,
      controlGeneration: 1,
      recordHmac: expectedRecordHmac({
        workspaceScopeId: 'scope-0001',
        canonicalPath: '/srv/tagma',
        createdAt: 1_777_777_777_777,
        controlGeneration: 1,
      }),
    });
    expect(
      computeWorkspaceScopeRecordHmac(
        {
          workspaceScopeId: record.workspaceScopeId,
          canonicalPath: record.canonicalPath,
          createdAt: record.createdAt,
          controlGeneration: record.controlGeneration,
        },
        TEST_KEY,
        { platform: 'linux' },
      ),
    ).toBe(record.recordHmac);
    expect(parseTrustedWorkspaceScopeRecord(record, TEST_KEY, { platform: 'linux' })).toEqual(
      record,
    );
    expect(isTrustedWorkspaceScopeRecord(record, TEST_KEY, { platform: 'linux' })).toBe(true);
  });

  test('fails closed for malformed, noncanonical, tampered, or wrong-key scope records', () => {
    const record = createTrustedWorkspaceScopeRecord(
      {
        workspaceScopeId: 'scope-0001',
        workspacePath: 'C:\\Team\\Tagma',
        createdAt: 1,
        controlGeneration: 1,
      },
      TEST_KEY,
      {
        platform: 'win32',
        realpathNative: (value) => value,
      },
    );
    const cases: unknown[] = [
      null,
      { ...record, workspaceScopeId: '' },
      { ...record, canonicalPath: 'C:/Team/Tagma' },
      { ...record, canonicalPathHmac: '0'.repeat(64) },
      { ...record, recordHmac: '0'.repeat(64) },
      (() => {
        const { recordHmac: _recordHmac, ...unsigned } = record;
        return unsigned;
      })(),
      { ...record, createdAt: -1 },
      { ...record, controlGeneration: 0 },
      { ...record, unexpected: true },
    ];

    for (const value of cases) {
      expect(isTrustedWorkspaceScopeRecord(value, TEST_KEY, { platform: 'win32' })).toBe(false);
      expect(() =>
        parseTrustedWorkspaceScopeRecord(value, TEST_KEY, { platform: 'win32' }),
      ).toThrow(/workspace scope record/i);
    }
    expect(isTrustedWorkspaceScopeRecord(record, Buffer.alloc(32, 7), { platform: 'win32' })).toBe(
      false,
    );
    expect(() =>
      parseTrustedWorkspaceScopeRecord(record, Buffer.alloc(32, 7), { platform: 'win32' }),
    ).toThrow(/workspace scope record/i);
  });

  test('authenticates every trusted scope authority field independently of path lookup identity', () => {
    const record = createTrustedWorkspaceScopeRecord(
      {
        workspaceScopeId: 'scope-0001',
        workspacePath: '/srv/tagma',
        createdAt: 100,
        controlGeneration: 1,
      },
      TEST_KEY,
      {
        platform: 'linux',
        realpathNative: (value) => value,
      },
    );
    const tamperedRecords = [
      { ...record, workspaceScopeId: 'scope-0002' },
      { ...record, createdAt: 101 },
      { ...record, controlGeneration: 2 },
    ];

    for (const tampered of tamperedRecords) {
      expect(tampered.canonicalPath).toBe(record.canonicalPath);
      expect(tampered.canonicalPathHmac).toBe(record.canonicalPathHmac);
      expect(isTrustedWorkspaceScopeRecord(tampered, TEST_KEY, { platform: 'linux' })).toBe(false);
      expect(() =>
        parseTrustedWorkspaceScopeRecord(tampered, TEST_KEY, { platform: 'linux' }),
      ).toThrow(/workspace scope record/i);
    }
  });

  test('treats a new canonical path as a distinct identity without move or clone inference', () => {
    const options = {
      platform: 'linux' as const,
      realpathNative: (value: string) => value,
    };
    const oldPath = createWorkspaceIdentity('/workspaces/original', TEST_KEY, options);
    const newPath = createWorkspaceIdentity('/workspaces/moved', TEST_KEY, options);

    expect(newPath.canonicalPath).not.toBe(oldPath.canonicalPath);
    expect(newPath.canonicalPathHmac).not.toBe(oldPath.canonicalPathHmac);
  });

  test('rejects empty inputs, non-absolute resolver results, or unavailable workspaces', () => {
    expect(() => canonicalizeWorkspacePath('')).toThrow(/workspace path/i);
    expect(() =>
      canonicalizeWorkspacePath('relative/path', {
        platform: 'linux',
        realpathNative: (value) => value,
      }),
    ).toThrow(/absolute/i);
    expect(() => canonicalizeWorkspacePath(join(makeRoot(), 'missing'))).toThrow();
  });
});
