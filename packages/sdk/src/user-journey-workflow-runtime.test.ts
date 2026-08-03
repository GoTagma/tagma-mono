import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTagma } from './index';

/**
 * End-user workflow journey coverage.
 *
 * These tests intentionally use `createTagma()` without a fake runtime. They
 * write the workflow's child pipeline YAML files to disk and let the default
 * Bun runtime spawn the commands, exercising the same route a YAML file host
 * would use.
 */

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-workflow-journey-'));
}

function writeCommandPipeline(
  path: string,
  name: string,
  argv: readonly string[],
  cwd?: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const cwdLine = cwd === undefined ? '' : `      cwd: ${JSON.stringify(cwd)}\n`;
  writeFileSync(
    path,
    `pipeline:
  name: ${JSON.stringify(name)}
  tracks:
    - id: main
      name: Main
${cwdLine}      tasks:
        - id: command
          name: Command
          command:
            argv: ${JSON.stringify(argv)}
`,
    'utf8',
  );
}

describe('workflow journey - real Bun runtime and child YAML files', () => {
  test('runs relative child files in dependency order from a Unicode-and-space cwd', async () => {
    const root = makeDir();
    const preparePath = join(root, '.tagma', 'child pipelines', '构建 阶段', 'prepare.yaml');
    const prepareWorkDir = join(dirname(preparePath), 'child cwd 非 ASCII');
    const verifyPath = join(root, '.tagma', 'child pipelines', 'verify stage', 'verify.yaml');
    const markerPath = join(root, 'artifacts', 'prepare-cwd.txt');
    const verifiedPath = join(root, 'artifacts', 'dependency-verified.txt');

    try {
      mkdirSync(prepareWorkDir, { recursive: true });
      mkdirSync(dirname(markerPath), { recursive: true });

      writeCommandPipeline(
        preparePath,
        'Prepare',
        [
          process.execPath,
          '-e',
          [
            'const fs = require("node:fs");',
            'const marker = process.argv[process.argv.length - 1];',
            'fs.writeFileSync(marker, process.cwd(), "utf8");',
            'process.stdout.write(process.cwd());',
          ].join(' '),
          markerPath,
        ],
        'child cwd 非 ASCII',
      );
      writeCommandPipeline(verifyPath, 'Verify', [
        process.execPath,
        '-e',
        [
          'const fs = require("node:fs");',
          'const [marker, expectedCwd, verified] = process.argv.slice(-3);',
          'const observedCwd = fs.readFileSync(marker, "utf8");',
          'if (observedCwd !== expectedCwd) {',
          '  process.stderr.write(`expected ${expectedCwd}, got ${observedCwd}`);',
          '  process.exit(2);',
          '}',
          'fs.writeFileSync(verified, "dependency observed", "utf8");',
          'process.stdout.write("dependency observed");',
        ].join(' '),
        markerPath,
        prepareWorkDir,
        verifiedPath,
      ]);

      const runningPipelines: string[] = [];
      const result = await createTagma().runYaml(
        `workflow:
  name: child-yaml-journey
  max_concurrency: 2
  failure_policy: continue_independent
  pipelines:
    - id: prepare
      path: ".tagma/child pipelines/构建 阶段/prepare.yaml"
    - id: verify
      path: ".tagma/child pipelines/verify stage/verify.yaml"
      depends_on: [prepare]
`,
        {
          cwd: root,
          onEvent: (event) => {
            if (
              event.type === 'pipeline_update' &&
              event.status === 'running' &&
              !runningPipelines.includes(event.pipelineId)
            ) {
              runningPipelines.push(event.pipelineId);
            }
          },
        },
      );

      expect(result.kind).toBe('workflow');
      if (result.kind !== 'workflow') throw new Error('Expected workflow result');
      expect(result.result.success).toBe(true);
      expect(result.result.pipelines.map((pipeline) => pipeline.status)).toEqual([
        'success',
        'success',
      ]);
      expect(runningPipelines).toEqual(['prepare', 'verify']);
      expect(readFileSync(markerPath, 'utf8')).toBe(prepareWorkDir);
      expect(readFileSync(verifiedPath, 'utf8')).toBe('dependency observed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips a downstream child pipeline after an actual child command fails', async () => {
    const root = makeDir();
    const failingPath = join(root, '.tagma', 'children', 'failure stage', 'fail.yaml');
    const skippedPath = join(root, '.tagma', 'children', 'downstream stage', 'skipped.yaml');
    const failureMarker = join(root, 'artifacts', 'failure-ran.txt');
    const skippedMarker = join(root, 'artifacts', 'downstream-ran.txt');

    try {
      mkdirSync(dirname(failureMarker), { recursive: true });
      writeCommandPipeline(failingPath, 'Fail', [
        process.execPath,
        '-e',
        [
          'const fs = require("node:fs");',
          'const marker = process.argv[process.argv.length - 1];',
          'fs.writeFileSync(marker, "failed child ran", "utf8");',
          'process.stderr.write("intentional child failure");',
          'process.exit(17);',
        ].join(' '),
        failureMarker,
      ]);
      writeCommandPipeline(skippedPath, 'Skipped', [
        process.execPath,
        '-e',
        [
          'const fs = require("node:fs");',
          'const marker = process.argv[process.argv.length - 1];',
          'fs.writeFileSync(marker, "downstream should not run", "utf8");',
        ].join(' '),
        skippedMarker,
      ]);

      const runningPipelines: string[] = [];
      const result = await createTagma().runYaml(
        `workflow:
  name: child-failure-journey
  failure_policy: continue_independent
  pipelines:
    - id: fail
      path: ".tagma/children/failure stage/fail.yaml"
    - id: downstream
      path: ".tagma/children/downstream stage/skipped.yaml"
      depends_on: [fail]
`,
        {
          cwd: root,
          onEvent: (event) => {
            if (
              event.type === 'pipeline_update' &&
              event.status === 'running' &&
              !runningPipelines.includes(event.pipelineId)
            ) {
              runningPipelines.push(event.pipelineId);
            }
          },
        },
      );

      expect(result.kind).toBe('workflow');
      if (result.kind !== 'workflow') throw new Error('Expected workflow result');
      expect(result.result.success).toBe(false);
      expect(result.result.pipelines.map((pipeline) => pipeline.status)).toEqual([
        'failed',
        'skipped',
      ]);
      expect(runningPipelines).toEqual(['fail']);
      expect(readFileSync(failureMarker, 'utf8')).toBe('failed child ran');
      expect(existsSync(skippedMarker)).toBe(false);
      expect(result.result.pipelines[1]?.result).toBeNull();
      expect(result.result.pipelines[1]?.error).toContain('upstream pipeline did not succeed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
