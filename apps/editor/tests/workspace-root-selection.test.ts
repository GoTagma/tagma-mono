import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { parse } from 'node:path';

import {
  WORKSPACE_ROOT_SELECTION_ERROR,
  isFilesystemRootPath,
  workspaceRootSelectionIssue,
} from '../shared/workspace-root-selection.js';
import { isValidWorkspaceKey } from '../server/workspace-registry.js';

describe('workspace root selection', () => {
  test('rejects filesystem, drive, and network-share roots across path styles', () => {
    for (const root of [
      '/',
      'F:\\',
      'f:/',
      '\\\\?\\F:\\',
      '\\\\build-server\\workspace-share\\',
      '\\\\?\\UNC\\build-server\\workspace-share\\',
    ]) {
      expect(isFilesystemRootPath(root)).toBe(true);
      expect(workspaceRootSelectionIssue(root)).toBe(WORKSPACE_ROOT_SELECTION_ERROR);
    }
  });

  test('allows ordinary project directories below a filesystem root', () => {
    for (const projectDirectory of [
      '/projects/quick-demo',
      'F:\\projects\\quick-demo',
      'f:/projects/quick-demo',
      '\\\\?\\F:\\projects\\quick-demo',
      '\\\\build-server\\workspace-share\\quick-demo',
      '\\\\?\\UNC\\build-server\\workspace-share\\quick-demo',
    ]) {
      expect(isFilesystemRootPath(projectDirectory)).toBe(false);
      expect(workspaceRootSelectionIssue(projectDirectory)).toBeNull();
    }
  });

  test('workspace registry rejects the current native filesystem root', () => {
    expect(isValidWorkspaceKey(parse(tmpdir()).root)).toBe(false);
  });
});
