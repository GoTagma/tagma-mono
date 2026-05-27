import { describe, expect, test } from 'bun:test';
import {
  buildYamlDiffHunks,
  buildFullYamlPreviewRows,
  buildYamlPreviewLineTargets,
  buildYamlPreviewBlocks,
  revertYamlPreviewHunk,
  serializePreviewYaml,
} from '../src/utils/yaml-preview-diff';

describe('serializePreviewYaml', () => {
  test('wraps the raw pipeline config in a pipeline root', () => {
    const text = serializePreviewYaml({
      name: 'Preview Pipeline',
      tracks: [{ id: 'track', name: 'Track', tasks: [] }],
    });

    expect(text).toContain('pipeline:');
    expect(text).toContain('name: Preview Pipeline');
    expect(text).toContain('tracks:');
  });
});

describe('buildYamlDiffHunks', () => {
  test('marks removed and added lines in a replacement hunk', () => {
    const before = ['pipeline:', '  name: Old', '  tracks: []', ''].join('\n');
    const after = ['pipeline:', '  name: New', '  tracks: []', ''].join('\n');

    const hunks = buildYamlDiffHunks(before, after);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toContainEqual(
      expect.objectContaining({ kind: 'remove', text: '  name: Old' }),
    );
    expect(hunks[0].lines).toContainEqual(
      expect.objectContaining({ kind: 'add', text: '  name: New' }),
    );
  });

  test('returns no hunks for identical yaml', () => {
    const text = ['pipeline:', '  name: Same', '  tracks: []', ''].join('\n');

    expect(buildYamlDiffHunks(text, text)).toEqual([]);
  });
});

describe('buildYamlPreviewBlocks', () => {
  test('preserves metadata for existing hunks and stamps newly touched hunks', () => {
    const baseline = [
      'pipeline:',
      '  name: Old',
      '  tracks:',
      '    - id: first',
      '      name: First',
      '      tasks: []',
      '    - id: second',
      '      name: Second',
      '      tasks:',
      '        - id: task',
      '          name: Task',
      '          prompt: old prompt',
      '',
    ].join('\n');
    const afterEditor = baseline.replace('  name: Old', '  name: New');
    const first = buildYamlPreviewBlocks({
      baselineYaml: baseline,
      previousBlocks: [],
      beforeYaml: baseline,
      afterYaml: afterEditor,
      source: 'editor',
      changedAt: 100,
    });
    const afterChat = afterEditor.replace(
      '          prompt: old prompt',
      '          prompt: chat prompt',
    );

    const second = buildYamlPreviewBlocks({
      baselineYaml: baseline,
      previousBlocks: first,
      beforeYaml: afterEditor,
      afterYaml: afterChat,
      source: 'chat',
      changedAt: 200,
    });

    expect(second).toHaveLength(2);
    expect(second[0].source).toBe('editor');
    expect(second[0].changedAt).toBe(100);
    expect(second[1].source).toBe('chat');
    expect(second[1].changedAt).toBe(200);
  });
});

describe('revertYamlPreviewHunk', () => {
  test('replaces the current hunk segment with the previous segment', () => {
    const before = ['pipeline:', '  name: Old', '  tracks: []', ''].join('\n');
    const after = ['pipeline:', '  name: New', '  tracks: []', ''].join('\n');
    const [hunk] = buildYamlDiffHunks(before, after);

    expect(revertYamlPreviewHunk(after, hunk)).toBe(before);
  });
});

describe('buildFullYamlPreviewRows', () => {
  test('keeps the whole current yaml while inserting diff block rows at changed locations', () => {
    const before = [
      'pipeline:',
      '  name: Old',
      '  tracks:',
      '    - id: t1',
      '      tasks: []',
      '',
    ].join('\n');
    const after = [
      'pipeline:',
      '  name: New',
      '  tracks:',
      '    - id: t1',
      '      tasks: []',
      '',
    ].join('\n');
    const [block] = buildYamlPreviewBlocks({
      baselineYaml: before,
      previousBlocks: [],
      beforeYaml: before,
      afterYaml: after,
      source: 'editor',
      changedAt: 100,
    });

    const rows = buildFullYamlPreviewRows(after, [block]);

    expect(rows.some((row) => row.kind === 'block-header' && row.block.id === block.id)).toBe(true);
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: 'line',
        line: expect.objectContaining({ kind: 'context', text: '    - id: t1' }),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: 'line',
        blockId: block.id,
        line: expect.objectContaining({ kind: 'remove', text: '  name: Old' }),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: 'line',
        blockId: block.id,
        line: expect.objectContaining({ kind: 'add', text: '  name: New' }),
      }),
    );
  });
});

describe('buildYamlPreviewLineTargets', () => {
  test('maps serialized YAML lines to their owning track or task', () => {
    const config = {
      name: 'Preview Pipeline',
      tracks: [
        {
          id: 'alpha',
          name: 'Alpha',
          tasks: [{ id: 'plan', name: 'Plan', prompt: 'Write the plan' }],
        },
      ],
    };
    const yaml = serializePreviewYaml(config);
    const lines = yaml.split('\n');
    const targets = buildYamlPreviewLineTargets(config);

    const trackLine = lines.findIndex((line) => line === '    - id: alpha') + 1;
    const taskLine = lines.findIndex((line) => line === '        - id: plan') + 1;
    const promptLine = lines.findIndex((line) => line === '          prompt: Write the plan') + 1;

    expect(targets.get(trackLine)).toEqual({ kind: 'track', trackId: 'alpha' });
    expect(targets.get(taskLine)).toEqual({
      kind: 'task',
      trackId: 'alpha',
      taskId: 'plan',
      qualifiedId: 'alpha.plan',
    });
    expect(targets.get(promptLine)).toEqual({
      kind: 'task',
      trackId: 'alpha',
      taskId: 'plan',
      qualifiedId: 'alpha.plan',
    });
  });

  test('maps track and task blocks even when id is not the first serialized field', () => {
    const config = {
      name: 'Preview Pipeline',
      tracks: [
        {
          name: 'Alpha',
          id: 'alpha',
          tasks: [{ name: 'Plan', prompt: 'Write the plan', id: 'plan' }],
        },
      ],
    };
    const yaml = serializePreviewYaml(config);
    const lines = yaml.split('\n');
    const targets = buildYamlPreviewLineTargets(config);

    const trackLine = lines.findIndex((line) => line === '    - name: Alpha') + 1;
    const taskLine = lines.findIndex((line) => line === '        - name: Plan') + 1;

    expect(targets.get(trackLine)).toEqual({ kind: 'track', trackId: 'alpha' });
    expect(targets.get(taskLine)).toEqual({
      kind: 'task',
      trackId: 'alpha',
      taskId: 'plan',
      qualifiedId: 'alpha.plan',
    });
  });

  test('keeps duplicate task ids scoped to their track', () => {
    const config = {
      name: 'Preview Pipeline',
      tracks: [
        { id: 'frontend', name: 'Frontend', tasks: [{ id: 'build', prompt: 'UI' }] },
        { id: 'backend', name: 'Backend', tasks: [{ id: 'build', prompt: 'API' }] },
      ],
    };
    const yaml = serializePreviewYaml(config);
    const lines = yaml.split('\n');
    const targets = buildYamlPreviewLineTargets(config);

    const backendTaskLine =
      lines.findIndex((line, index) => {
        return (
          index > lines.findIndex((candidate) => candidate === '    - id: backend') &&
          line === '        - id: build'
        );
      }) + 1;

    expect(targets.get(backendTaskLine)).toEqual({
      kind: 'task',
      trackId: 'backend',
      taskId: 'build',
      qualifiedId: 'backend.build',
    });
  });
});
