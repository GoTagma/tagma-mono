import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceState } from '../server/workspace-state';
import {
  formatMigrationWarnings,
  isUnmigratableFlatYaml,
  migrateFlatPipelinesToFolders,
} from '../server/workspace-migrate';
import { enumerateFlatPipelineYamls } from '../server/pipeline-paths';

const tempRoots: string[] = [];

function makeWorkspace(): { workDir: string; ws: WorkspaceState } {
  const workDir = mkdtempSync(join(tmpdir(), 'tagma-migrate-'));
  tempRoots.push(workDir);
  mkdirSync(join(workDir, '.tagma'), { recursive: true });
  const ws = new WorkspaceState(workDir);
  ws.workDir = workDir;
  return { workDir, ws };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('migrateFlatPipelinesToFolders', () => {
  test('moves a flat YAML + its companions into a per-pipeline folder', () => {
    const { workDir, ws } = makeWorkspace();
    const tagmaDir = join(workDir, '.tagma');
    writeFileSync(join(tagmaDir, 'foo.yaml'), 'pipeline:\n  name: Foo\n');
    writeFileSync(
      join(tagmaDir, 'foo.layout.json'),
      JSON.stringify({ positions: { 'a.b': { x: 100 } } }),
    );
    writeFileSync(join(tagmaDir, 'foo.compile.log'), '{"success": true}\n');
    writeFileSync(join(tagmaDir, 'foo.requirements.md'), '# Requirements for `foo.yaml`\n');
    writeFileSync(
      join(tagmaDir, 'foo.manifest.json'),
      JSON.stringify({ kind: 'tagma-pipeline-manifest' }),
    );

    const report = migrateFlatPipelinesToFolders(ws);
    expect(report.migrated).toHaveLength(1);
    expect(report.conflicts).toHaveLength(0);
    expect(report.errors).toHaveLength(0);

    const folder = join(tagmaDir, 'foo');
    expect(existsSync(join(folder, 'foo.yaml'))).toBe(true);
    expect(existsSync(join(folder, 'foo.layout.json'))).toBe(true);
    expect(existsSync(join(folder, 'foo.compile.log'))).toBe(true);
    expect(existsSync(join(folder, 'foo.requirements.md'))).toBe(true);
    expect(existsSync(join(folder, 'foo.manifest.json'))).toBe(true);
    expect(existsSync(join(tagmaDir, 'foo.yaml'))).toBe(false);
    expect(existsSync(join(tagmaDir, 'foo.manifest.json'))).toBe(false);
  });

  test('is idempotent — re-running yields zero outcomes', () => {
    const { workDir, ws } = makeWorkspace();
    writeFileSync(join(workDir, '.tagma', 'bar.yaml'), 'pipeline:\n  name: Bar\n');
    migrateFlatPipelinesToFolders(ws);
    const second = migrateFlatPipelinesToFolders(ws);
    expect(second.migrated).toHaveLength(0);
    expect(second.conflicts).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });

  test('removes the created folder after companion migration fails', () => {
    const { workDir, ws } = makeWorkspace();
    const tagmaDir = join(workDir, '.tagma');
    const folder = join(tagmaDir, 'broken');
    writeFileSync(join(tagmaDir, 'broken.yaml'), 'pipeline:\n  name: Broken\n');
    mkdirSync(join(tagmaDir, 'broken.layout.json'));

    const report = migrateFlatPipelinesToFolders(ws);
    expect(report.migrated).toHaveLength(0);
    expect(report.conflicts).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.detail).toContain('non-file sibling');
    expect(existsSync(join(tagmaDir, 'broken.yaml'))).toBe(true);
    expect(existsSync(folder)).toBe(false);

    const retry = migrateFlatPipelinesToFolders(ws);
    expect(retry.conflicts).toHaveLength(0);
    expect(retry.errors).toHaveLength(1);
    expect(retry.errors[0]?.detail).toContain('non-file sibling');
    expect(existsSync(folder)).toBe(false);
  });

  test('reports conflict when both .tagma/foo.yaml and .tagma/foo/foo.yaml exist', () => {
    const { workDir, ws } = makeWorkspace();
    const tagmaDir = join(workDir, '.tagma');
    const folder = join(tagmaDir, 'foo');
    mkdirSync(folder);
    writeFileSync(join(folder, 'foo.yaml'), 'pipeline:\n  name: Foo (new)\n');
    // Flat copy now collides with an existing folder.
    writeFileSync(join(tagmaDir, 'foo.yaml'), 'pipeline:\n  name: Foo (legacy)\n');

    const report = migrateFlatPipelinesToFolders(ws);
    expect(report.migrated).toHaveLength(0);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.stem).toBe('foo');
    // The legacy file must NOT be touched.
    expect(readFileSync(join(tagmaDir, 'foo.yaml'), 'utf-8')).toContain('Foo (legacy)');
    expect(readFileSync(join(folder, 'foo.yaml'), 'utf-8')).toContain('Foo (new)');

    const warnings = formatMigrationWarnings(report);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('foo');
  });

  test('rebinds ws.yamlPath when the old flat path was bound to the workspace', () => {
    const { workDir, ws } = makeWorkspace();
    const tagmaDir = join(workDir, '.tagma');
    const oldYamlPath = join(tagmaDir, 'baz.yaml');
    writeFileSync(oldYamlPath, 'pipeline:\n  name: Baz\n  tracks: []\n');
    ws.yamlPath = oldYamlPath;
    migrateFlatPipelinesToFolders(ws);
    expect(ws.yamlPath).toBe(join(tagmaDir, 'baz', 'baz.yaml'));
  });

  test('isUnmigratableFlatYaml flags the stranded flat file', () => {
    const { workDir } = makeWorkspace();
    const tagmaDir = join(workDir, '.tagma');
    const folder = join(tagmaDir, 'foo');
    mkdirSync(folder);
    writeFileSync(join(folder, 'foo.yaml'), 'pipeline:\n');
    writeFileSync(join(tagmaDir, 'foo.yaml'), 'pipeline:\n');
    const flat = enumerateFlatPipelineYamls(workDir);
    expect(flat).toHaveLength(1);
    expect(isUnmigratableFlatYaml(workDir, flat[0]!)).toBe(true);
  });
});
