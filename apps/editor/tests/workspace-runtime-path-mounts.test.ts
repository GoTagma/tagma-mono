import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PathMountTable } from '../server/execution/path-mounts';

describe('private workspace runtime path mounts', () => {
  test('resolves a structured path through an explicitly registered mount', () => {
    const mounts = new PathMountTable({ dialect: 'posix' });
    mounts.register('workspace', '/srv/workspace');

    expect(
      mounts.resolveLexical({ mount: 'workspace', segments: ['artifacts', 'result.json'] }),
    ).toBe('/srv/workspace/artifacts/result.json');
  });

  test('rejects segments that are not portable atomic path names', () => {
    const mounts = new PathMountTable({ dialect: 'posix' });
    mounts.register('workspace', '/srv/workspace');

    for (const segment of ['', '.', '..', 'two/parts', 'two\\parts', 'nul\0byte']) {
      expect(() => mounts.resolveLexical({ mount: 'workspace', segments: [segment] })).toThrow();
    }
  });

  test('enforces Windows drive, ADS, device-name, and trailing-character rules', () => {
    const mounts = new PathMountTable({ dialect: 'win32' });
    mounts.register('workspace', 'C:\\workspace');

    for (const segment of [
      'C:escape',
      'report.txt:secret',
      'CON',
      'nul.txt',
      'COM1.log',
      'lpt9',
      'report.',
      'report ',
    ]) {
      expect(() => mounts.resolveLexical({ mount: 'workspace', segments: [segment] })).toThrow();
    }
    expect(
      mounts.resolveLexical({ mount: 'workspace', segments: ['COM0.log', 'report.txt'] }),
    ).toBe('C:\\workspace\\COM0.log\\report.txt');
  });

  test('requires an explicitly registered absolute mount root', () => {
    const mounts = new PathMountTable({ dialect: 'posix' });

    expect(() => mounts.register('workspace', 'relative/root')).toThrow(/absolute/i);
    expect(() => mounts.resolveLexical({ mount: 'workspace', segments: ['result.json'] })).toThrow(
      /not registered/i,
    );
  });

  test('reverse maps host paths with dialect-specific case and boundary semantics', async () => {
    const windowsMounts = new PathMountTable({ dialect: 'win32' });
    windowsMounts.register('workspace', 'C:\\Work\\Root');

    expect(await windowsMounts.toPathRef('c:/work/root/Src/Main.ts')).toEqual({
      mount: 'workspace',
      segments: ['Src', 'Main.ts'],
    });
    expect(await windowsMounts.toPathRef('C:\\Work\\Root-other\\Main.ts')).toBeNull();

    const posixMounts = new PathMountTable({ dialect: 'posix' });
    posixMounts.register('workspace', '/Work/Root');

    expect(await posixMounts.toPathRef('/Work/Root/Src/Main.ts')).toEqual({
      mount: 'workspace',
      segments: ['Src', 'Main.ts'],
    });
    expect(await posixMounts.toPathRef('/work/root/Src/Main.ts')).toBeNull();
  });

  test('native resolution detects a pre-existing symlink or junction ancestor escape', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'tagma-path-mounts-'));
    const workspaceRoot = join(temporaryRoot, 'workspace');
    const outsideRoot = join(temporaryRoot, 'outside');
    const safeRoot = join(workspaceRoot, 'safe');
    await mkdir(safeRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    const mounts = new PathMountTable({
      dialect: process.platform === 'win32' ? 'win32' : 'posix',
    });
    mounts.register('workspace', workspaceRoot);

    try {
      await expect(
        mounts.resolve({ mount: 'workspace', segments: ['safe', 'new', 'result.json'] }),
      ).resolves.toBe(join(safeRoot, 'new', 'result.json'));

      try {
        await symlink(
          outsideRoot,
          join(workspaceRoot, 'escape'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (['EACCES', 'EPERM', 'ENOTSUP'].includes(code)) return;
        throw error;
      }

      // This covers a link present during the pre-I/O check, not a race-free authorization boundary.
      await expect(
        mounts.resolve({ mount: 'workspace', segments: ['escape', 'new', 'result.json'] }),
      ).rejects.toThrow(/outside.*mount|escapes.*mount/i);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
