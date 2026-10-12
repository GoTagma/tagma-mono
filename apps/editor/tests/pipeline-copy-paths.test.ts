import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { rewriteCopiedPipelineYaml } from '../server/pipeline-copy-paths';

const virtualRoot = join(tmpdir(), `tagma-copy-paths-${randomUUID()}`);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rewrite(
  config: Parameters<typeof serializePipeline>[0],
  root = virtualRoot,
  destinationName = 'branch',
) {
  const sourceWorkDir = join(root, 'source');
  const destinationWorkDir = join(root, 'sandbox');
  const destinationYamlPath = join(
    destinationWorkDir,
    '.tagma',
    destinationName,
    `${destinationName}.yaml`,
  );
  const yaml = rewriteCopiedPipelineYaml(serializePipeline(config), {
    sourceWorkDir,
    destinationWorkDir,
    sourceIdentityPath: join(sourceWorkDir, '.tagma', 'origin', 'origin.yaml'),
    sourceContentPath: join(root, 'stage', '.tagma', 'branch', 'branch.yaml'),
    destinationYamlPath,
    pipelineName: config.name,
  });
  return { config: parseYaml(yaml), destinationWorkDir, destinationYamlPath };
}

function pipeline(cwd: string, taskCwd?: string) {
  return {
    name: 'Copy coordinates',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd,
        tasks: [
          {
            id: 'check',
            name: 'Check',
            command: 'echo copied',
            ...(taskCwd ? { cwd: taskCwd } : {}),
          },
        ],
      },
    ],
  };
}

describe('pipeline copies across workspace coordinates', () => {
  test.each(['track-cwd', 'task-cwd'] as const)(
    'a copied json_schema completion reads both relocated local companions (%s)',
    async (cwdOwner) => {
      const root = mkdtempSync(join(tmpdir(), 'tagma-copied-schema-'));
      roots.push(root);
      const stagedDir = join(root, 'stage', '.tagma', 'branch');
      const completion = {
        type: 'json_schema',
        path: join(stagedDir, 'data.json'),
        schema_path: join(stagedDir, 'data.schema.json'),
      };
      const config: Parameters<typeof serializePipeline>[0] = {
        ...pipeline('.tagma/origin'),
        tracks: [
          {
            ...pipeline('.tagma/origin').tracks[0]!,
            ...(cwdOwner === 'task-cwd' ? { cwd: 'shared' } : {}),
            tasks: [
              {
                ...pipeline('.tagma/origin').tracks[0]!.tasks[0]!,
                completion,
                ...(cwdOwner === 'task-cwd' ? { cwd: '.tagma/origin' } : {}),
              },
            ],
          },
        ],
      };
      const result = rewrite(config, root);
      const track = result.config.tracks[0]!;
      const task = track.tasks[0]!;
      const copied = task.completion!;
      const destinationDir = dirname(result.destinationYamlPath);
      mkdirSync(destinationDir, { recursive: true });
      writeFileSync(join(destinationDir, 'data.json'), '{"marker":"copied-only"}');
      writeFileSync(join(destinationDir, 'data.schema.json'), '{"type":"object"}');
      expect(copied.path).toBe(join(destinationDir, 'data.json'));
      expect(copied.schema_path).toBe(join(destinationDir, 'data.schema.json'));
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          'const fs=require("node:fs");process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>JSON.parse(fs.readFileSync(p,"utf8")))))',
          String(copied.path),
          String(copied.schema_path),
        ],
        {
          cwd: resolve(result.destinationWorkDir, task.cwd ?? track.cwd ?? '.'),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: '[{"marker":"copied-only"},{"type":"object"}]',
        stderr: '',
        exitCode: 0,
      });
    },
  );

  test('copy preserves task cwd overrides and foreign json_schema coordinates', () => {
    const externalSchema = join(virtualRoot, 'foreign', 'schema.json');
    const result = rewrite({
      name: 'Schema coordinates',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: '.tagma/origin',
          tasks: [
            {
              id: 'nested',
              name: 'Nested',
              cwd: '.tagma/origin/jobs',
              command: 'echo copied',
              completion: { type: 'json_schema', path: 'data.json', schema_path: 'schema.json' },
            },
            {
              id: 'external',
              name: 'External',
              cwd: '.',
              command: 'echo copied',
              completion: {
                type: 'json_schema',
                path: '.tagma/other/data.json',
                schema_path: externalSchema,
              },
            },
          ],
        },
      ],
    });
    const track = result.config.tracks[0]!;
    const nested = track.tasks[0]!;
    expect(nested.completion).toEqual({
      type: 'json_schema',
      path: 'data.json',
      schema_path: 'schema.json',
    });
    expect(resolve(result.destinationWorkDir, nested.cwd!)).toBe(
      join(dirname(result.destinationYamlPath), 'jobs'),
    );
    expect(track.tasks[1]!.completion).toEqual({
      type: 'json_schema',
      path: '.tagma/other/data.json',
      schema_path: externalSchema,
    });
  });

  test('keeps explicit root and shared cwd independent of existing staged directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-existing-copy-cwd-'));
    roots.push(root);
    mkdirSync(join(root, 'stage', '.tagma', 'branch', 'shared'), { recursive: true });
    const result = rewrite(pipeline('.', 'shared'), root).config;
    expect(result.tracks[0]!.cwd).toBe('.');
    expect(result.tracks[0]!.tasks[0]!.cwd).toBe('shared');
  });
  test('relocates a relative track cwd to the copied pipeline folder', () => {
    const result = rewrite(pipeline('.tagma/origin'));
    expect(resolve(result.destinationWorkDir, result.config.tracks[0]!.cwd!)).toBe(
      dirname(result.destinationYamlPath),
    );
  });

  test('relocates nested task cwd independently of the track cwd', () => {
    const result = rewrite(pipeline('.tagma/origin', '.tagma/origin/scripts'));
    expect(resolve(result.destinationWorkDir, result.config.tracks[0]!.tasks[0]!.cwd!)).toBe(
      join(dirname(result.destinationYamlPath), 'scripts'),
    );
  });

  test('keeps absolute pipeline cwd relocation working', () => {
    const result = rewrite(pipeline(join(virtualRoot, 'source', '.tagma', 'origin')));
    expect(result.config.tracks[0]!.cwd).toBe(dirname(result.destinationYamlPath));
  });

  test('keeps an unchanged pipeline folder valid in a fresh workspace', () => {
    const result = rewrite(pipeline('.tagma/origin'), virtualRoot, 'origin');
    expect(resolve(result.destinationWorkDir, result.config.tracks[0]!.cwd!)).toBe(
      dirname(result.destinationYamlPath),
    );
  });

  test('preserves shared workspace coordinates and command bytes', () => {
    const config = pipeline('shared', 'other-shared');
    config.tracks[0]!.tasks[0]!.command = 'echo .tagma/origin is command content';
    const result = rewrite(config).config;
    expect(result.tracks[0]!.cwd).toBe('shared');
    expect(result.tracks[0]!.tasks[0]!.cwd).toBe('other-shared');
    expect(result.tracks[0]!.tasks[0]!.command).toBe(config.tracks[0]!.tasks[0]!.command);
  });

  test('relocates built-in paths using each task effective cwd', () => {
    const sourcePipelineDir = join(virtualRoot, 'source', '.tagma', 'origin');
    const result = rewrite({
      name: 'Plugin coordinates',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: '.tagma/origin',
          middlewares: [{ type: 'static_context', file: join(sourcePipelineDir, 'track.md') }],
          tasks: [
            {
              id: 'check',
              name: 'Check',
              cwd: '.tagma/origin/jobs',
              prompt: 'Inspect the inputs.',
              trigger: { type: 'file', path: '../input.txt' },
              completion: { type: 'file_exists', path: '../output.txt' },
              middlewares: [{ type: 'static_context', file: join(sourcePipelineDir, 'task.md') }],
            },
          ],
        },
      ],
    });
    const track = result.config.tracks[0]!;
    const task = track.tasks[0]!;
    const destinationPipelineDir = dirname(result.destinationYamlPath);
    const taskCwd = resolve(result.destinationWorkDir, task.cwd!);
    expect(track.middlewares?.[0]?.file).toBe(join(destinationPipelineDir, 'track.md'));
    expect(task.middlewares?.[0]?.file).toBe(join(destinationPipelineDir, 'task.md'));
    expect(resolve(taskCwd, String(task.trigger?.path))).toBe(
      join(destinationPipelineDir, 'input.txt'),
    );
    expect(resolve(taskCwd, String(task.completion?.path))).toBe(
      join(destinationPipelineDir, 'output.txt'),
    );
  });

  test('keeps same-workspace copies and external absolute paths distinct', () => {
    const workDir = join(virtualRoot, 'source');
    const external = join(virtualRoot, 'external');
    const original = pipeline('.tagma/origin', external);
    const copied = parseYaml(
      rewriteCopiedPipelineYaml(serializePipeline(original), {
        sourceWorkDir: workDir,
        destinationWorkDir: workDir,
        sourceIdentityPath: join(workDir, '.tagma', 'origin', 'origin.yaml'),
        sourceContentPath: join(virtualRoot, 'stage', '.tagma', 'branch', 'branch.yaml'),
        destinationYamlPath: join(workDir, '.tagma', 'branch', 'branch.yaml'),
        pipelineName: original.name,
      }),
    );
    expect(copied.tracks[0]!.cwd).toBe('.tagma/branch');
    expect(copied.tracks[0]!.tasks[0]!.cwd).toBe(external);
  });

  test('a command can read the copied helper from its relocated cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-copied-cwd-'));
    roots.push(root);
    const result = rewrite(pipeline('.tagma/origin'), root);
    mkdirSync(dirname(result.destinationYamlPath), { recursive: true });
    writeFileSync(join(dirname(result.destinationYamlPath), 'payload.txt'), 'sandbox-only\n');
    const child = Bun.spawn(
      [process.execPath, '-e', "process.stdout.write(await Bun.file('payload.txt').text())"],
      {
        cwd: resolve(result.destinationWorkDir, result.config.tracks[0]!.cwd!),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ stdout, stderr, exitCode }).toEqual({
      stdout: 'sandbox-only\n',
      stderr: '',
      exitCode: 0,
    });
  });
});
