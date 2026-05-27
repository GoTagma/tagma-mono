import { describe, expect, test } from 'bun:test';
import { renderSaveIndicator } from '../src/components/VersionStatusBar';

describe('renderSaveIndicator', () => {
  test('returns Unsaved element when isDirty', () => {
    const el = renderSaveIndicator({ isDirty: true, lastAutosaveAt: null });
    expect(el).not.toBeNull();
    expect(JSON.stringify(el)).toContain('Unsaved');
  });

  test('returns Saved HH:MM:SS element when clean and lastAutosaveAt is set', () => {
    const t = new Date(2026, 3, 26, 14, 32, 5).getTime();
    const el = renderSaveIndicator({ isDirty: false, lastAutosaveAt: t });
    expect(el).not.toBeNull();
    expect(JSON.stringify(el)).toMatch(/Saved.*14:32:05/);
  });

  test('returns null when clean and never saved', () => {
    const el = renderSaveIndicator({ isDirty: false, lastAutosaveAt: null });
    expect(el).toBeNull();
  });
});
