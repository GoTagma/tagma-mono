import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Run save failure flow', () => {
  test.failing(
    'clears a pending Run when saving existing dirty YAML fails, preventing an auto-retry',
    () => {
      const source = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
      const handleRunStart = source.indexOf('const handleRun = useCallback');
      const autoRunEffectStart = source.indexOf('// After save completes and yamlPath is set');
      const handleRunSource = source.slice(handleRunStart, autoRunEffectStart);
      const dirtyRunStart = handleRunSource.indexOf('if (latest.isDirty && !yamlEditLocked) {');
      const dirtyRunEnd = handleRunSource.indexOf('\n    resetYamlPreviewBaseline', dirtyRunStart);
      const dirtyRunSource = handleRunSource.slice(dirtyRunStart, dirtyRunEnd);
      const autoRunEffectEnd = source.indexOf('// Post-workspace bootstrap', autoRunEffectStart);
      const autoRunEffectSource = source.slice(autoRunEffectStart, autoRunEffectEnd);

      expect(handleRunStart).toBeGreaterThanOrEqual(0);
      expect(autoRunEffectStart).toBeGreaterThan(handleRunStart);
      expect(dirtyRunStart).toBeGreaterThanOrEqual(0);
      expect(dirtyRunEnd).toBeGreaterThan(dirtyRunStart);

      // `saveFile` returns false on failure. A false result must clear the
      // queued intent before the existing-path effect sees it and invokes
      // handleRun again.
      expect(dirtyRunSource).toMatch(
        /const\s+(\w+)\s*=\s*await\s+saveFile\(\);\s*if\s*\(\s*!\1\s*\)\s*\{\s*setPendingRun\(false\);\s*return;\s*\}/,
      );
      expect(dirtyRunSource).not.toContain('startRun(');
      expect(autoRunEffectSource).toContain('if (pendingRun && yamlPath)');
    },
  );
});
