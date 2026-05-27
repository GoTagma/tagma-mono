import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Save As failure flow', () => {
  test('does not close the Save As dialog before saveFileAs reports success', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const closeIndex = source.indexOf('setSaveAsInput(null);', source.indexOf('commitSaveAs'));
    const saveIndex = source.indexOf('await saveFileAs(target);', source.indexOf('commitSaveAs'));

    expect(saveIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(saveIndex);
  });
});
