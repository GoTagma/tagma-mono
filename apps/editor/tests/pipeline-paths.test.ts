import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertPipelineFolderPath,
  assertPipelineYamlPath,
  enumerateFlatPipelineYamls,
  enumeratePipelineYamls,
  isValidPipelineStem,
  pipelineYamlPath,
  sanitizePipelineStem,
} from '../server/pipeline-paths';

const tempRoots: string[] = [];

function makeWorkDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-paths-'));
  tempRoots.push(root);
  mkdirSync(join(root, '.tagma'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sanitizePipelineStem', () => {
  test('accepts kebab-case names with embedded dots', () => {
    expect(sanitizePipelineStem('foo-bar')).toBe('foo-bar');
    expect(sanitizePipelineStem('foo.windows')).toBe('foo.windows');
    expect(sanitizePipelineStem('pipeline_42')).toBe('pipeline_42');
  });

  test('rejects empty / whitespace / overlong inputs', () => {
    expect(() => sanitizePipelineStem('')).toThrow();
    expect(() => sanitizePipelineStem(' foo')).toThrow();
    expect(() => sanitizePipelineStem('foo bar')).toThrow();
    expect(() => sanitizePipelineStem('a'.repeat(200))).toThrow();
  });

  test('rejects path separators and Windows-illegal characters', () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(() => sanitizePipelineStem(bad)).toThrow();
    }
  });

  test('rejects relative-path tokens and leading dots', () => {
    expect(() => sanitizePipelineStem('.')).toThrow();
    expect(() => sanitizePipelineStem('..')).toThrow();
    expect(() => sanitizePipelineStem('.hidden')).toThrow();
  });

  test('rejects reserved .tagma sibling directory names', () => {
    for (const reserved of ['logs', 'plugin-runtime', 'plugin-store', 'node_modules']) {
      expect(() => sanitizePipelineStem(reserved)).toThrow();
    }
  });

  test('rejects reserved .tagma sibling names case-insensitively', () => {
    for (const reserved of ['Logs', 'PLUGIN-RUNTIME', 'Plugin-Store', 'Node_Modules']) {
      expect(() => sanitizePipelineStem(reserved)).toThrow();
    }
  });
});

describe('isValidPipelineStem', () => {
  test('returns true for accepted stems and false otherwise', () => {
    expect(isValidPipelineStem('foo')).toBe(true);
    expect(isValidPipelineStem('logs')).toBe(false);
    expect(isValidPipelineStem('Logs')).toBe(false);
    expect(isValidPipelineStem('..')).toBe(false);
    expect(isValidPipelineStem(123)).toBe(false);
  });
});

describe('enumeratePipelineYamls', () => {
  test('returns one entry per .tagma/<stem>/<stem>.yaml', () => {
    const workDir = makeWorkDir();
    const fooFolder = join(workDir, '.tagma', 'foo');
    mkdirSync(fooFolder);
    writeFileSync(join(fooFolder, 'foo.yaml'), 'pipeline:\n  name: Foo\n');
    const barFolder = join(workDir, '.tagma', 'bar');
    mkdirSync(barFolder);
    writeFileSync(join(barFolder, 'bar.yml'), 'pipeline:\n  name: Bar\n');

    const entries = enumeratePipelineYamls(workDir);
    expect(entries.map((e) => e.stem)).toEqual(['bar', 'foo']);
    expect(entries[0]?.yamlBasename).toBe('bar.yml');
    expect(entries[1]?.yamlBasename).toBe('foo.yaml');
  });

  test('skips reserved directories and stray top-level yamls', () => {
    const workDir = makeWorkDir();
    // Reserved siblings — must NOT be returned.
    mkdirSync(join(workDir, '.tagma', 'logs'));
    writeFileSync(join(workDir, '.tagma', 'logs', 'logs.yaml'), '# not a pipeline\n');
    mkdirSync(join(workDir, '.tagma', 'plugin-runtime'));
    writeFileSync(
      join(workDir, '.tagma', 'plugin-runtime', 'plugin-runtime.yaml'),
      '# not a pipeline\n',
    );
    // Stray flat YAML at the top — handled by enumerateFlatPipelineYamls, not this one.
    writeFileSync(join(workDir, '.tagma', 'stray.yaml'), '# legacy flat\n');
    // Folder whose YAML basename does NOT match the folder name — invalid layout.
    const wrong = join(workDir, '.tagma', 'mismatched');
    mkdirSync(wrong);
    writeFileSync(join(wrong, 'other-name.yaml'), '# stem mismatch\n');

    expect(enumeratePipelineYamls(workDir)).toEqual([]);
  });

  test('skips mixed-case reserved directories', () => {
    const workDir = makeWorkDir();
    mkdirSync(join(workDir, '.tagma', 'Logs'));
    writeFileSync(join(workDir, '.tagma', 'Logs', 'Logs.yaml'), '# not a pipeline\n');

    expect(enumeratePipelineYamls(workDir)).toEqual([]);
  });

  test('skips symlinked pipeline folders', () => {
    // On Windows symlinks require admin or developer mode; skip if creation fails.
    const workDir = makeWorkDir();
    const realFolder = join(workDir, 'real');
    mkdirSync(realFolder);
    writeFileSync(join(realFolder, 'real.yaml'), 'pipeline:\n');
    let linkable = true;
    try {
      symlinkSync(realFolder, join(workDir, '.tagma', 'linked'), 'dir');
    } catch {
      linkable = false;
    }
    if (!linkable) return;
    const entries = enumeratePipelineYamls(workDir);
    expect(entries.find((e) => e.stem === 'linked')).toBeUndefined();
  });
});

describe('enumerateFlatPipelineYamls', () => {
  test('returns top-level *.yaml files unaffected by foldered pipelines', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, '.tagma', 'legacy.yaml'), '# flat\n');
    const goodFolder = join(workDir, '.tagma', 'good');
    mkdirSync(goodFolder);
    writeFileSync(join(goodFolder, 'good.yaml'), 'pipeline:\n');

    const flat = enumerateFlatPipelineYamls(workDir);
    expect(flat.map((e) => e.stem)).toEqual(['legacy']);
  });

  test('skips reserved, invalid, and symlinked flat YAMLs', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, '.tagma', 'logs.yaml'), '# reserved\n');
    writeFileSync(join(workDir, '.tagma', '.hidden.yaml'), '# hidden\n');
    writeFileSync(join(workDir, '.tagma', 'good.yaml'), '# good\n');

    const outside = join(workDir, 'outside.yaml');
    writeFileSync(outside, '# outside\n');
    let linkable = true;
    try {
      symlinkSync(outside, join(workDir, '.tagma', 'linked.yaml'), 'file');
    } catch {
      linkable = false;
    }

    const flat = enumerateFlatPipelineYamls(workDir);
    expect(flat.map((e) => e.stem)).toEqual(['good']);
    if (linkable) {
      expect(flat.find((e) => e.stem === 'linked')).toBeUndefined();
    }
  });

  test('skips mixed-case reserved flat YAMLs', () => {
    const workDir = makeWorkDir();
    writeFileSync(join(workDir, '.tagma', 'Logs.yaml'), '# reserved\n');
    writeFileSync(join(workDir, '.tagma', 'good.yaml'), '# good\n');

    const flat = enumerateFlatPipelineYamls(workDir);
    expect(flat.map((e) => e.stem)).toEqual(['good']);
  });
});

describe('assertPipelineYamlPath', () => {
  test('accepts canonical .tagma/<stem>/<stem>.yaml shapes', () => {
    const workDir = makeWorkDir();
    const target = pipelineYamlPath(workDir, 'foo');
    expect(() => assertPipelineYamlPath(workDir, target, 'target')).not.toThrow();
  });

  test('rejects flat top-level YAMLs', () => {
    const workDir = makeWorkDir();
    const flat = join(workDir, '.tagma', 'foo.yaml');
    expect(() => assertPipelineYamlPath(workDir, flat, 'target')).toThrow();
  });

  test('rejects mismatched folder/file names', () => {
    const workDir = makeWorkDir();
    const target = join(workDir, '.tagma', 'foo', 'bar.yaml');
    expect(() => assertPipelineYamlPath(workDir, target, 'target')).toThrow(/folder name/i);
  });

  test('rejects reserved folder names', () => {
    const workDir = makeWorkDir();
    const reserved = join(workDir, '.tagma', 'logs', 'logs.yaml');
    expect(() => assertPipelineYamlPath(workDir, reserved, 'target')).toThrow();
    const mixedCaseReserved = join(workDir, '.tagma', 'Logs', 'Logs.yaml');
    expect(() => assertPipelineYamlPath(workDir, mixedCaseReserved, 'target')).toThrow();
  });

  test('rejects nesting deeper than one level', () => {
    const workDir = makeWorkDir();
    const deep = join(workDir, '.tagma', 'parent', 'child', 'child.yaml');
    expect(() => assertPipelineYamlPath(workDir, deep, 'target')).toThrow();
  });

  test('rejects symlinked .tagma directory', () => {
    const workDir = makeWorkDir();
    // Swap .tagma for a symlink and verify the helper refuses.
    const tagmaDir = join(workDir, '.tagma');
    rmSync(tagmaDir, { recursive: true, force: true });
    const realTagma = join(workDir, 'real-tagma');
    mkdirSync(realTagma, { recursive: true });
    let linkable = true;
    try {
      symlinkSync(realTagma, tagmaDir, 'dir');
    } catch {
      linkable = false;
    }
    if (!linkable) return;
    const target = join(tagmaDir, 'foo', 'foo.yaml');
    expect(() => assertPipelineYamlPath(workDir, target, 'target')).toThrow();
  });

  test('rejects future YAMLs under a symlinked pipeline folder', () => {
    const workDir = makeWorkDir();
    const outside = join(workDir, 'outside');
    mkdirSync(outside);
    let linkable = true;
    try {
      symlinkSync(outside, join(workDir, '.tagma', 'linked'), 'dir');
    } catch {
      linkable = false;
    }
    if (!linkable) return;

    const target = join(workDir, '.tagma', 'linked', 'linked.yaml');
    expect(() => assertPipelineYamlPath(workDir, target, 'target')).toThrow();
  });

  test('returns resolved path on success', () => {
    const workDir = makeWorkDir();
    const target = pipelineYamlPath(workDir, 'foo');
    expect(assertPipelineYamlPath(workDir, target, 'target')).toBe(target);
  });
});

describe('assertPipelineFolderPath', () => {
  test('accepts a one-level pipeline folder', () => {
    const workDir = makeWorkDir();
    const folder = join(workDir, '.tagma', 'foo');
    mkdirSync(folder);
    expect(() => assertPipelineFolderPath(workDir, folder, 'folder')).not.toThrow();
  });

  test('rejects reserved folder name', () => {
    const workDir = makeWorkDir();
    const folder = join(workDir, '.tagma', 'logs');
    mkdirSync(folder);
    expect(() => assertPipelineFolderPath(workDir, folder, 'folder')).toThrow();
    const mixedCaseFolder = join(workDir, '.tagma', 'Logs');
    expect(() => assertPipelineFolderPath(workDir, mixedCaseFolder, 'folder')).toThrow();
  });

  test('rejects .tagma itself', () => {
    const workDir = makeWorkDir();
    const tagmaDir = join(workDir, '.tagma');
    expect(() => assertPipelineFolderPath(workDir, tagmaDir, 'folder')).toThrow();
  });

  test('rejects folders outside .tagma and nested below a pipeline folder', () => {
    const workDir = makeWorkDir();
    expect(() => assertPipelineFolderPath(workDir, join(workDir, 'foo'), 'folder')).toThrow();
    expect(() =>
      assertPipelineFolderPath(workDir, join(workDir, '.tagma', 'foo', 'bar'), 'folder'),
    ).toThrow();
  });

  test('rejects symlinked pipeline folders', () => {
    const workDir = makeWorkDir();
    const outside = join(workDir, 'outside-folder');
    mkdirSync(outside);
    const link = join(workDir, '.tagma', 'linked');
    let linkable = true;
    try {
      symlinkSync(outside, link, 'dir');
    } catch {
      linkable = false;
    }
    if (!linkable) return;

    expect(() => assertPipelineFolderPath(workDir, link, 'folder')).toThrow();
  });
});
