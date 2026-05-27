import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  incrementYamlRunVersion,
  readYamlRunVersion,
  yamlRunVersionKey,
} from '../server/yaml-run-version';

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('YAML run versions', () => {
  test('increments a workspace-relative YAML key once per run start', () => {
    const dir = makeDir('tagma-yaml-run-version-');
    const yamlPath = join(dir, '.tagma', 'build', 'build.yaml');
    try {
      expect(yamlRunVersionKey(dir, yamlPath)).toBe('.tagma/build/build.yaml');
      expect(readYamlRunVersion(dir, yamlPath)).toBe(0);
      expect(incrementYamlRunVersion(dir, yamlPath)).toBe(1);
      expect(incrementYamlRunVersion(dir, yamlPath)).toBe(2);
      expect(readYamlRunVersion(dir, yamlPath)).toBe(2);

      const storePath = join(dir, '.tagma', 'run-versions.json');
      expect(existsSync(storePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as {
        entries: Record<string, number>;
      };
      expect(parsed.entries['.tagma/build/build.yaml']).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores YAML paths outside the workspace', () => {
    const dir = makeDir('tagma-yaml-run-version-fence-');
    try {
      expect(yamlRunVersionKey(dir, join(tmpdir(), 'outside.yaml'))).toBeNull();
      expect(incrementYamlRunVersion(dir, join(tmpdir(), 'outside.yaml'))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
