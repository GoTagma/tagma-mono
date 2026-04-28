import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneLogDirs } from './log-prune';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-prune-'));
}

describe('pruneLogDirs', () => {
  test('returns silently when logsDir does not exist', async () => {
    const root = fixture();
    try {
      await expect(pruneLogDirs(join(root, 'nope'), 5, 'run_live')).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps the live run plus (keep-1) most recent historical runs', async () => {
    const root = fixture();
    try {
      for (const id of ['run_001', 'run_002', 'run_003', 'run_004', 'run_005']) {
        mkdirSync(join(root, id));
      }
      await pruneLogDirs(root, 3, 'run_005'); // keep=3 → 1 live + 2 historical
      expect(readdirSync(root).sort()).toEqual(['run_003', 'run_004', 'run_005']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never deletes the excluded live runId even if it would be pruned', async () => {
    const root = fixture();
    try {
      for (const id of ['run_001', 'run_002', 'run_003']) mkdirSync(join(root, id));
      await pruneLogDirs(root, 1, 'run_001');
      expect(readdirSync(root).sort()).toEqual(['run_001']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('never deletes any excluded live runIds', async () => {
    const root = fixture();
    try {
      for (const id of ['run_001', 'run_002', 'run_003', 'run_004']) mkdirSync(join(root, id));
      await pruneLogDirs(root, 2, 'run_004', ['run_001', 'run_004']);
      expect(readdirSync(root).sort()).toEqual(['run_001', 'run_004']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores entries that do not look like run dirs', async () => {
    const root = fixture();
    try {
      mkdirSync(join(root, 'run_001'));
      mkdirSync(join(root, 'not_a_run'));
      await pruneLogDirs(root, 1, 'run_001');
      expect(readdirSync(root).sort()).toEqual(['not_a_run', 'run_001']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
