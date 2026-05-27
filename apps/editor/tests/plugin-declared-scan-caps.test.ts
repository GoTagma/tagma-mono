import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { S } from '../server/state';
import { discoverWorkspaceDeclaredPlugins, invalidatePluginCache } from '../server/plugins/loader';

const tempDirs: string[] = [];

function makeTempDir(name: string): string {
  const abs = resolve(
    join(tmpdir(), `tagma-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  );
  mkdirSync(abs, { recursive: true });
  tempDirs.push(abs);
  return abs;
}

afterEach(() => {
  invalidatePluginCache(S);
  S.workDir = '';
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverWorkspaceDeclaredPlugins caps', () => {
  function makePipelineFolder(workDir: string, stem: string): string {
    const folder = join(workDir, '.tagma', stem);
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  test('skips YAML files larger than the per-file byte cap and warns', () => {
    const workDir = makeTempDir('declared-scan-oversize');

    // Padding pushes the file past the 256 KB per-file cap. The actual plugin
    // declaration is valid YAML — the cap, not parse failure, is what should
    // skip it. Each pipeline now lives in its own folder.
    const padding = 'x'.repeat(300_000);
    const oversizeFolder = makePipelineFolder(workDir, 'oversize');
    writeFileSync(
      join(oversizeFolder, 'oversize.yaml'),
      `# ${padding}\npipeline:\n  plugins:\n    - "@scope/oversize-plugin"\n`,
      'utf-8',
    );
    // A small file with a different plugin proves the scan continues after
    // skipping the oversize entry.
    const smallFolder = makePipelineFolder(workDir, 'small');
    writeFileSync(
      join(smallFolder, 'small.yaml'),
      'pipeline:\n  plugins:\n    - "@scope/small-plugin"\n',
      'utf-8',
    );

    S.workDir = workDir;
    invalidatePluginCache(S);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const declared = discoverWorkspaceDeclaredPlugins(S);
      expect(declared).toContain('@scope/small-plugin');
      expect(declared).not.toContain('@scope/oversize-plugin');
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('oversize') && w.includes('oversize.yaml'))).toBe(true);
  });

  test('stops scanning after the per-workspace YAML count cap and warns', () => {
    const workDir = makeTempDir('declared-scan-many');

    // 70 pipelines > the 64-file cap. Each declares a uniquely-named plugin so
    // we can prove the scanner stopped early — the union must be a strict
    // subset.
    for (let i = 0; i < 70; i++) {
      const idx = String(i).padStart(3, '0');
      const stem = `pipeline-${idx}`;
      const folder = makePipelineFolder(workDir, stem);
      writeFileSync(
        join(folder, `${stem}.yaml`),
        `pipeline:\n  plugins:\n    - "@scope/plugin-${idx}"\n`,
        'utf-8',
      );
    }

    S.workDir = workDir;
    invalidatePluginCache(S);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const declared = discoverWorkspaceDeclaredPlugins(S);
      // Plain `<` not `<=`: the cap is the count of files actually scanned;
      // any later files must not contribute to the result.
      expect(declared.length).toBeLessThan(70);
      expect(declared.length).toBeLessThanOrEqual(64);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('declared-plugin scan stopped'))).toBe(true);
  });
});
