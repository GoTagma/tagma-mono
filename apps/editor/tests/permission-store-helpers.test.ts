import { describe, expect, test } from 'bun:test';
import {
  upsertPermission,
  removePermission,
  type PendingPermission,
} from '../src/utils/permission-store-helpers';

const sample: PendingPermission = {
  workspaceKey: 'C:/repo-a',
  id: 'perm_1',
  sessionID: 'ses_1',
  title: 'Edit .tagma/foo.yaml',
  tool: 'edit',
  metadata: {},
  createdAt: 1,
};

describe('upsertPermission', () => {
  test('adds a new permission when id is unseen', () => {
    expect(upsertPermission([], sample)).toEqual([sample]);
  });

  test('replaces an existing permission with the same id', () => {
    const updated: PendingPermission = { ...sample, title: 'changed' };
    expect(upsertPermission([sample], updated)).toEqual([updated]);
  });

  test('keeps permissions with the same id from different sessions separate', () => {
    const sameIdOtherSession: PendingPermission = {
      ...sample,
      sessionID: 'ses_2',
      title: 'other session',
    };
    expect(upsertPermission([sample], sameIdOtherSession)).toEqual([sample, sameIdOtherSession]);
  });

  test('keeps permissions with the same id and session from different workspaces separate', () => {
    const sameIdOtherWorkspace: PendingPermission = {
      ...sample,
      workspaceKey: 'C:/repo-b',
      title: 'other workspace',
    };
    expect(upsertPermission([sample], sameIdOtherWorkspace)).toEqual([
      sample,
      sameIdOtherWorkspace,
    ]);
  });

  test('preserves order when replacing mid-list', () => {
    const other: PendingPermission = { ...sample, id: 'perm_2' };
    const updated: PendingPermission = { ...sample, title: 'changed' };
    expect(upsertPermission([sample, other], updated)).toEqual([updated, other]);
  });
});

describe('removePermission', () => {
  test('removes by id', () => {
    expect(removePermission([sample], 'perm_1')).toEqual([]);
  });

  test('removes only the matching session when sessionID is provided', () => {
    const sameIdOtherSession: PendingPermission = { ...sample, sessionID: 'ses_2' };
    expect(removePermission([sample, sameIdOtherSession], 'perm_1', 'ses_1')).toEqual([
      sameIdOtherSession,
    ]);
  });

  test('removes only the matching workspace when workspaceKey is provided', () => {
    const sameIdOtherWorkspace: PendingPermission = { ...sample, workspaceKey: 'C:/repo-b' };
    expect(
      removePermission([sample, sameIdOtherWorkspace], 'perm_1', 'ses_1', 'C:/repo-a'),
    ).toEqual([sameIdOtherWorkspace]);
  });

  test('no-op when id not present', () => {
    expect(removePermission([sample], 'perm_nope')).toEqual([sample]);
  });
});
