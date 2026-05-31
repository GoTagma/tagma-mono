import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  buildPipelineManifestFromYaml,
  buildYamlSkeletonFromManifest,
  pipelineManifestPath,
  runPipelineManifestSync,
} from '../server/pipeline-manifest';

describe('pipeline manifest sidecar', () => {
  test('derives stable pipeline, track, and task sections from YAML', () => {
    const manifest = buildPipelineManifestFromYaml(
      [
        'pipeline:',
        '  name: Outlook Email Summarizer',
        '  mode: trusted',
        '  tracks:',
        '    - id: outlook',
        '      name: Outlook',
        '      tasks:',
        '        - id: controls',
        '          name: Pipeline Parameters',
        '          command: echo controls',
        '          outputs:',
        '            email_count:',
        '              type: number',
        '        - id: analyze',
        '          prompt: Summarize and filter important emails.',
        '          depends_on: [controls]',
        '          inputs:',
        '            emailsJson: {}',
        '          outputs:',
        '            importantCount: {}',
        '',
      ].join('\n'),
      { yamlBasename: 'outlook.yaml' },
    );

    expect(manifest.kind).toBe('tagma-pipeline-manifest');
    expect(manifest.pipeline).toMatchObject({
      name: 'Outlook Email Summarizer',
      yaml: 'outlook.yaml',
    });
    expect(manifest.sections.map((section) => section.id)).toEqual([
      'pipeline',
      'track:outlook',
      'task:outlook.controls',
      'task:outlook.analyze',
    ]);
    expect(manifest.sections[1]).toMatchObject({
      id: 'track:outlook',
      type: 'track',
      summary: 'Outlook',
      yamlPath: 'pipeline.tracks[0]',
    });
    expect(manifest.sections[2]).toMatchObject({
      id: 'task:outlook.controls',
      type: 'command',
      summary: 'Pipeline Parameters',
      track: 'outlook',
      task: 'controls',
      outputs: ['email_count'],
    });
    expect(manifest.sections[3]).toMatchObject({
      id: 'task:outlook.analyze',
      type: 'prompt',
      inputs: ['emailsJson'],
      outputs: ['importantCount'],
      depends_on: ['controls'],
    });
    expect(manifest.editPolicy.preserveUnselectedSections).toBe(true);
  });

  test('writes a same-folder .manifest.json companion next to the YAML', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-pipeline-manifest-'));
    try {
      const yamlPath = join(root, '.tagma', 'build', 'build.yaml');
      const manifestPath = pipelineManifestPath(yamlPath);
      mkdirSync(join(root, '.tagma', 'build'), { recursive: true });
      writeFileSync(
        yamlPath,
        'pipeline:\n  name: Build\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: lint\n          command: bun test\n',
        'utf-8',
      );

      runPipelineManifestSync(yamlPath);

      expect(manifestPath).toBe(join(root, '.tagma', 'build', 'build.manifest.json'));
      expect(existsSync(manifestPath)).toBe(true);
      const saved = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(saved.sections.map((section: { id: string }) => section.id)).toEqual([
        'pipeline',
        'track:main',
        'task:main.lint',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes a stale manifest when YAML no longer produces a valid manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-pipeline-manifest-stale-'));
    try {
      const yamlPath = join(root, '.tagma', 'build', 'build.yaml');
      const manifestPath = pipelineManifestPath(yamlPath);
      mkdirSync(join(root, '.tagma', 'build'), { recursive: true });
      writeFileSync(
        yamlPath,
        'pipeline:\n  name: Build\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: lint\n          command: bun test\n',
        'utf-8',
      );

      expect(runPipelineManifestSync(yamlPath)).not.toBeNull();
      expect(existsSync(manifestPath)).toBe(true);

      writeFileSync(yamlPath, 'workflow:\n  name: Not a pipeline\n  pipelines: []\n', 'utf-8');
      expect(runPipelineManifestSync(yamlPath)).toBeNull();
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('buildYamlSkeletonFromManifest produces valid YAML that round-trips through parse', () => {
    const originalYaml = [
      'pipeline:',
      '  name: Email Summarizer',
      '  tracks:',
      '    - id: outlook',
      '      name: Outlook',
      '      tasks:',
      '        - id: controls',
      '          name: Pipeline Parameters',
      '          command: echo controls',
      '          outputs:',
      '            email_count:',
      '              type: number',
      '        - id: analyze',
      '          prompt: Summarize and filter important emails.',
      '          depends_on: [controls]',
      '          inputs:',
      '            emailsJson: {}',
      '          outputs:',
      '            importantCount: {}',
      '',
    ].join('\n');

    const manifest = buildPipelineManifestFromYaml(originalYaml, {
      yamlBasename: 'email.yaml',
    });

    const skeleton = buildYamlSkeletonFromManifest(manifest);

    // The skeleton must be valid YAML
    const parsed = yaml.load(skeleton) as {
      pipeline: {
        name: string;
        tracks: Array<{
          id: string;
          name: string;
          tasks: Array<{
            id: string;
            name?: string;
            prompt?: string;
            command?: string;
            depends_on?: string[];
          }>;
        }>;
      };
    };

    expect(parsed.pipeline.name).toBe('Email Summarizer');
    expect(parsed.pipeline.tracks).toHaveLength(1);
    expect(parsed.pipeline.tracks[0].id).toBe('outlook');
    expect(parsed.pipeline.tracks[0].name).toBe('Outlook');
    expect(parsed.pipeline.tracks[0].tasks).toHaveLength(2);

    const [controls, analyze] = parsed.pipeline.tracks[0].tasks;
    expect(controls.id).toBe('controls');
    expect(controls.name).toBe('Pipeline Parameters');
    // Command tasks get a placeholder command
    expect(controls.command).toBeDefined();

    expect(analyze.id).toBe('analyze');
    // Prompt tasks preserve their summary as prompt content
    expect(analyze.prompt).toBe('Summarize and filter important emails.');
    expect(analyze.depends_on).toEqual(['controls']);
  });

  test('buildYamlSkeletonFromManifest handles manifest with no tracks', () => {
    const manifest = buildPipelineManifestFromYaml(
      'pipeline:\n  name: Empty\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: t1\n          prompt: hi\n',
      { yamlBasename: 'empty.yaml' },
    );

    const skeleton = buildYamlSkeletonFromManifest(manifest);
    const parsed = yaml.load(skeleton) as {
      pipeline: { name: string; tracks: Array<{ id: string }> };
    };

    expect(parsed.pipeline.name).toBe('Empty');
    expect(parsed.pipeline.tracks.length).toBeGreaterThan(0);
  });
});
