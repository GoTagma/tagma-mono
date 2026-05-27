import { describe, expect, test } from 'bun:test';

import {
  cancelHotupdate,
  endHotupdate,
  getHotupdateStatus,
  tryBeginHotupdate,
} from '../server/release/hotupdate-lock';

describe('hotupdate lock', () => {
  test('allows only one editor/sidecar/opencode/release update at a time', () => {
    const editor = new AbortController();
    const opencode = new AbortController();
    const release = new AbortController();

    expect(tryBeginHotupdate('editor', editor)).toEqual({ ok: true });
    expect(tryBeginHotupdate('opencode', opencode)).toEqual({
      ok: false,
      activeKind: 'editor',
    });
    expect(tryBeginHotupdate('release', release)).toEqual({
      ok: false,
      activeKind: 'editor',
    });

    expect(cancelHotupdate('opencode')).toBe(false);
    expect(opencode.signal.aborted).toBe(false);
    expect(cancelHotupdate('release')).toBe(false);
    expect(release.signal.aborted).toBe(false);

    expect(cancelHotupdate('editor')).toBe(true);
    expect(editor.signal.aborted).toBe(true);
    endHotupdate(editor);
  });

  test('releases the lock only for the owning controller', () => {
    const owner = new AbortController();
    const stranger = new AbortController();

    expect(tryBeginHotupdate('sidecar', owner)).toEqual({ ok: true });
    endHotupdate(stranger);
    expect(tryBeginHotupdate('release', stranger)).toEqual({
      ok: false,
      activeKind: 'sidecar',
    });

    endHotupdate(owner);
    expect(tryBeginHotupdate('release', stranger)).toEqual({ ok: true });
    endHotupdate(stranger);
  });

  test('reports the active update for UI state recovery', () => {
    const owner = new AbortController();

    expect(getHotupdateStatus()).toEqual({ active: false });
    expect(tryBeginHotupdate('release', owner)).toEqual({ ok: true });

    const status = getHotupdateStatus();
    expect(status.active).toBe(true);
    if (status.active) {
      expect(status.kind).toBe('release');
      expect(Number.isNaN(Date.parse(status.startedAt))).toBe(false);
    }

    endHotupdate(owner);
    expect(getHotupdateStatus()).toEqual({ active: false });
  });
});
