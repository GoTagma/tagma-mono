import { describe, expect, test } from 'bun:test';
import {
  upsertPermission,
  removePermission,
  type PendingPermission,
} from '../src/utils/permission-store-helpers';

const sample: PendingPermission = {
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

  test('no-op when id not present', () => {
    expect(removePermission([sample], 'perm_nope')).toEqual([sample]);
  });
});
