import { describe, expect, test } from 'bun:test';
import type { WorkspaceYamlEntry } from '../src/api/client';
import { upsertWorkspaceYamlEntry } from '../src/utils/workspace-yaml-list';

function entry(path: string, pipelineName: string, contentHash: string): WorkspaceYamlEntry {
  return {
    name: path.split('/').pop() ?? path,
    path,
    pipelineName,
    contentHash,
    layoutHash: null,
    layoutMtimeMs: null,
    layoutSize: null,
    mtimeMs: 1,
    size: 1,
  };
}

describe('workspace YAML list reconciliation', () => {
  test('immediately replaces a deployed pipeline entry with its finalized live metadata', () => {
    const buildPath = 'C:/repo/.tagma/build/build.yaml';
    const current = [
      entry(buildPath, 'Old build name', 'old-hash'),
      entry('C:/repo/.tagma/test/test.yaml', 'Test', 'test-hash'),
    ];
    const finalized = {
      ...entry('c:\\repo\\.tagma\\build\\build.yaml', 'Renamed build', 'new-hash'),
      name: 'build.yaml',
    };

    const next = upsertWorkspaceYamlEntry(current, finalized, 'win32');

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      path: finalized.path,
      pipelineName: 'Renamed build',
      contentHash: 'new-hash',
    });
    expect(next[1]).toBe(current[1]);
  });

  test('appends a newly deployed pipeline without dropping existing instances', () => {
    const current = [entry('/repo/.tagma/build/build.yaml', 'Build', 'build-hash')];
    const created = entry('/repo/.tagma/release/release.yaml', 'Release', 'release-hash');

    expect(upsertWorkspaceYamlEntry(current, created, 'linux')).toEqual([...current, created]);
  });
});
