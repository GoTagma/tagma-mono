import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertWorkflowYamlPath,
  enumerateWorkflowYamls,
  isValidWorkflowStem,
  sanitizeWorkflowStem,
  workflowYamlPath,
} from '../server/workflow-paths';

const tempRoots: string[] = [];

function makeWorkDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-workflow-paths-'));
  tempRoots.push(root);
  mkdirSync(join(root, '.tagma', 'workflows'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workflow path helpers', () => {
  test('sanitizes workflow stems with the same conservative filename rules as pipelines', () => {
    expect(sanitizeWorkflowStem('release-flow')).toBe('release-flow');
    expect(isValidWorkflowStem('release_flow')).toBe(true);
    expect(isValidWorkflowStem('bad/name')).toBe(false);
    expect(isValidWorkflowStem('.hidden')).toBe(false);
  });

  test('enumerates .tagma/workflows/*.workflow.yaml files', () => {
    const workDir = makeWorkDir();
    writeFileSync(
      join(workDir, '.tagma', 'workflows', 'release.workflow.yaml'),
      'workflow:\n  name: Release\n  pipelines: []\n',
      'utf-8',
    );
    writeFileSync(join(workDir, '.tagma', 'workflows', 'notes.yaml'), 'not a workflow\n', 'utf-8');

    const entries = enumerateWorkflowYamls(workDir);
    expect(entries.map((entry) => entry.stem)).toEqual(['release']);
    expect(entries[0]?.yamlBasename).toBe('release.workflow.yaml');
  });

  test('assertWorkflowYamlPath accepts only direct workflow YAMLs inside .tagma/workflows', () => {
    const workDir = makeWorkDir();
    const target = workflowYamlPath(workDir, 'release');
    expect(assertWorkflowYamlPath(workDir, target, 'workflow')).toBe(target);

    expect(() =>
      assertWorkflowYamlPath(workDir, join(workDir, '.tagma', 'release.workflow.yaml'), 'workflow'),
    ).toThrow();
    expect(() =>
      assertWorkflowYamlPath(
        workDir,
        join(workDir, '.tagma', 'workflows', 'nested', 'release.workflow.yaml'),
        'workflow',
      ),
    ).toThrow();
  });

  test('assertWorkflowYamlPath resolves workspace-relative workflow paths from workDir', () => {
    const workDir = makeWorkDir();
    const target = workflowYamlPath(workDir, 'release');
    writeFileSync(target, 'workflow:\n  name: Release\n  pipelines: []\n', 'utf-8');

    expect(
      assertWorkflowYamlPath(workDir, '.tagma/workflows/release.workflow.yaml', 'workflow'),
    ).toBe(target);
  });

  test('accepts a Windows drive-case alias for the workspace and workflow path', () => {
    if (process.platform !== 'win32') return;
    const workDir = makeWorkDir();
    const aliasedWorkDir = workDir.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    const target = workflowYamlPath(workDir, 'release');

    expect(assertWorkflowYamlPath(aliasedWorkDir, target, 'workflow').toLowerCase()).toBe(
      target.toLowerCase(),
    );
  });

  test('accepts a Windows intermediate-directory case alias', () => {
    if (process.platform !== 'win32') return;
    const workDir = makeWorkDir();
    const aliasedWorkDir = workDir.replace(/([^\\]+)$/, (segment) => segment.toUpperCase());
    const target = workflowYamlPath(workDir, 'release').replace(
      /\\\.tagma\\workflows\\/i,
      '\\.TAGMA\\WORKFLOWS\\',
    );

    expect(assertWorkflowYamlPath(aliasedWorkDir, target, 'workflow').toLowerCase()).toBe(
      target.toLowerCase(),
    );
  });

  test('accepts Windows forward-slash workflow paths', () => {
    if (process.platform !== 'win32') return;
    const workDir = makeWorkDir();
    const target = workflowYamlPath(workDir, 'release').replace(/\\/g, '/');

    expect(assertWorkflowYamlPath(workDir, target, 'workflow').replace(/\\/g, '/')).toBe(target);
  });

  test('accepts Windows case and separator aliases together', () => {
    if (process.platform !== 'win32') return;
    const workDir = makeWorkDir();
    const aliasedWorkDir = workDir.replace(/([^\\]+)$/, (segment) => segment.toUpperCase());
    const target = workflowYamlPath(workDir, 'release')
      .replace(/\\\.tagma\\workflows\\/i, '\\.TAGMA\\WORKFLOWS\\')
      .replace(/\\/g, '/');

    expect(
      assertWorkflowYamlPath(aliasedWorkDir, target, 'workflow')
        .replace(/\\/g, '/')
        .toLowerCase(),
    ).toBe(
      target.toLowerCase(),
    );
  });

  test('rejects nested, outside, and cross-drive workflow paths', () => {
    const workDir = makeWorkDir();
    expect(() =>
      assertWorkflowYamlPath(
        workDir,
        join(workDir, '.tagma', 'workflows', 'nested', 'release.workflow.yaml'),
        'workflow',
      ),
    ).toThrow();
    expect(() =>
      assertWorkflowYamlPath(workDir, join(workDir, 'outside.workflow.yaml'), 'workflow'),
    ).toThrow();

    if (process.platform === 'win32') {
      const drive = workDir.slice(0, 1).toUpperCase();
      const otherDrive = drive === 'C' ? 'D' : 'C';
      expect(() =>
        assertWorkflowYamlPath(
          workDir,
          `${otherDrive}:\\outside\\release.workflow.yaml`,
          'workflow',
        ),
      ).toThrow();
    }
  });

  test('keeps POSIX workflow path containment case-sensitive', () => {
    if (process.platform === 'win32') return;
    const workDir = makeWorkDir();
    const target = workflowYamlPath(workDir, 'release');
    const wrongCase = target.replace('/.tagma/workflows/', '/.tagma/Workflows/');

    expect(wrongCase).not.toBe(target);
    expect(() => assertWorkflowYamlPath(workDir, wrongCase, 'workflow')).toThrow();
  });

  test('rejects symlinked workflow directories', () => {
    const workDir = makeWorkDir();
    const workflowDir = join(workDir, '.tagma', 'workflows');
    rmSync(workflowDir, { recursive: true, force: true });
    const outside = join(workDir, 'outside-workflows');
    mkdirSync(outside);
    let linkable = true;
    try {
      symlinkSync(outside, workflowDir, 'dir');
    } catch {
      linkable = false;
    }
    if (!linkable) return;

    expect(enumerateWorkflowYamls(workDir)).toEqual([]);
    expect(() =>
      assertWorkflowYamlPath(workDir, join(workflowDir, 'a.workflow.yaml'), 'workflow'),
    ).toThrow();
  });
});
