import { expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeStagedEntry } from '../server/opencode-stage-remove-tool';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import { load } from 'js-yaml';

function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'tagma-stage-remove-')));
  const stage = join(temp, '.tagma', '.chat-staging', 'test-stage');
  const root = join(stage, 'agent-workspace', '.tagma');
  mkdirSync(join(root, 'fresh', 'nested'), { recursive: true });
  writeFileSync(join(root, 'fresh', 'nested', 'file.txt'), 'fresh bytes');
  writeFileSync(join(root, 'target.yaml'), 'classified target');
  const metadata = {
    id: 'test-stage',
    lifecycleOwner: 'chat-operation-v2',
    sessionRelocation: {
      version: 1,
      stageId: 'test-stage',
      sessionId: 'owned-session',
      targetDirectory: root,
      phase: 'staged',
    },
  };
  const save = () => writeFileSync(join(stage, 'stage.json'), JSON.stringify(metadata));
  save();
  const controller = new AbortController();
  const grants: Array<{
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }> = [];
  const context = {
    directory: root,
    sessionID: 'owned-session',
    agent: 'tagma-pipeline',
    abort: controller.signal,
    ask: async (input: (typeof grants)[number]) => {
      grants.push(input);
    },
  };
  return {
    temp,
    root,
    stage,
    metadata,
    save,
    grants,
    context,
    controller,
    dispose: () => rmSync(temp, { recursive: true, force: true }),
  };
}

test('staged removal restores actual absence with exact edit grants and bottom-up empty directories', async () => {
  const f = fixture();
  try {
    for (const path of ['fresh/nested/file.txt', 'fresh/nested', 'fresh']) {
      expect(JSON.parse(await removeStagedEntry({ path }, f.context))).toEqual({
        path,
        removed: true,
      });
      expect(existsSync(join(f.root, path))).toBe(false);
      expect(f.grants.at(-1)).toEqual({
        permission: 'edit',
        patterns: [join(f.root, path)],
        always: [],
        metadata: { filepath: join(f.root, path) },
      });
    }
    expect(readFileSync(join(f.root, 'target.yaml'), 'utf8')).toBe('classified target');
    expect(JSON.parse(await removeStagedEntry({ path: 'fresh' }, f.context))).toMatchObject({
      alreadyAbsent: true,
      removed: false,
    });
  } finally {
    f.dispose();
  }
});

test('staged removal rejects outside paths, root, symlinks, hardlinks and nonempty directories', async () => {
  const f = fixture();
  try {
    const outside = join(f.temp, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(
      f.temp,
      join(f.root, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // Junction ancestors exercise Windows too, without requiring file-symlink privileges.
    linkSync(outside, join(f.root, 'hardlink.txt'));
    for (const path of [
      '.',
      '..',
      outside,
      'fresh',
      'linked-directory',
      'linked-directory/outside.txt',
      'hardlink.txt',
      '\0',
    ]) {
      await expect(removeStagedEntry({ path }, f.context)).rejects.toThrow();
    }
    expect(f.grants).toHaveLength(0);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
    expect(readFileSync(join(f.root, 'fresh/nested/file.txt'), 'utf8')).toBe('fresh bytes');
  } finally {
    f.dispose();
  }
});

test('staged removal rejects foreign agents, sessions, phases and forged live workspace roots', async () => {
  const f = fixture();
  try {
    for (const context of [
      { ...f.context, agent: 'tagma-trial-planner' },
      { ...f.context, sessionID: 'foreign' },
      { ...f.context, directory: join(f.temp, '.tagma') },
    ])
      await expect(removeStagedEntry({ path: 'target.yaml' }, context)).rejects.toThrow();
    f.metadata.sessionRelocation.phase = 'restoring';
    f.save();
    await expect(removeStagedEntry({ path: 'target.yaml' }, f.context)).rejects.toThrow();
    f.metadata.sessionRelocation.phase = 'staged';
    f.metadata.lifecycleOwner = 'foreign';
    f.save();
    await expect(removeStagedEntry({ path: 'target.yaml' }, f.context)).rejects.toThrow();
    expect(f.grants).toHaveLength(0);
    expect(readFileSync(join(f.root, 'target.yaml'), 'utf8')).toBe('classified target');
  } finally {
    f.dispose();
  }
});

for (const change of ['reject', 'abort', 'binding', 'replacement', 'ancestor-link'] as const) {
  test(`staged removal preserves bytes when ${change} occurs during approval`, async () => {
    const f = fixture();
    try {
      const target = join(f.root, 'fresh/nested/file.txt');
      const context = {
        ...f.context,
        ask: async () => {
          if (change === 'reject') throw new Error('Permission denied');
          if (change === 'abort') f.controller.abort();
          if (change === 'binding') {
            f.metadata.sessionRelocation.sessionId = 'foreign';
            f.save();
          }
          if (change === 'replacement') {
            renameSync(target, target + '.original');
            writeFileSync(target, 'replacement');
          }
          if (change === 'ancestor-link') {
            renameSync(join(f.root, 'fresh'), join(f.temp, 'moved'));
            symlinkSync(
              join(f.temp, 'moved'),
              join(f.root, 'fresh'),
              process.platform === 'win32' ? 'junction' : 'dir',
            );
          }
        },
      };
      await expect(removeStagedEntry({ path: 'fresh/nested/file.txt' }, context)).rejects.toThrow();
      expect(readFileSync(target, 'utf8')).toBe(
        change === 'replacement' ? 'replacement' : 'fresh bytes',
      );
    } finally {
      f.dispose();
    }
  });
}

test('only seeded pipeline author exposes staged removal; advisory and planner profiles deny it', () => {
  const f = fixture();
  try {
    const source = join(f.temp, '.tagma');
    seedOpencodeArtifacts(source);
    const files = new Bun.Glob('*.md').scanSync({ cwd: join(source, '.opencode/agents') });
    let count = 0;
    for (const name of files) {
      const text = readFileSync(join(source, '.opencode/agents', name), 'utf8');
      const front = load(text.split('---')[1]!) as {
        tools: Record<string, boolean>;
        permission: Record<string, unknown>;
      };
      const enabled = name === 'tagma-pipeline.md';
      if (enabled) expect(text.length).toBeLessThan(22_000);
      expect(front.tools.tagma_stage_remove).toBe(enabled);
      expect(front.permission.tagma_stage_remove).toBe(enabled ? 'allow' : 'deny');
      count++;
    }
    expect(count).toBeGreaterThan(10);
  } finally {
    f.dispose();
  }
});

test('staged removal compares canonical Host relocation targets across filesystem aliases', async () => {
  const f = fixture();
  try {
    const alias = join(f.temp, 'private-stage-alias');
    symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.metadata.sessionRelocation.targetDirectory = alias;
    f.save();
    expect(
      JSON.parse(await removeStagedEntry({ path: 'fresh/nested/file.txt' }, f.context)),
    ).toMatchObject({ removed: true });
    expect(existsSync(join(f.root, 'fresh/nested/file.txt'))).toBe(false);
    expect(readFileSync(join(f.root, 'target.yaml'), 'utf8')).toBe('classified target');
  } finally {
    f.dispose();
  }
});
