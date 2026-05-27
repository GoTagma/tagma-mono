import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startChatCompileWatcher, stopChatCompileWatcher } from '../server/chat-compile-watcher';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    stopChatCompileWatcher(join(root, '.tagma'));
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('chat compile watcher writes a compile log for newly created yaml', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-compile-'));
  tempRoots.push(root);
  const tagmaDir = join(root, '.tagma');
  mkdirSync(tagmaDir, { recursive: true });

  startChatCompileWatcher(tagmaDir, undefined, (path) => {
    const logPath = path.replace(/\.ya?ml$/i, '.compile.log');
    writeFileSync(
      logPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          sourceName: path,
          success: true,
          parseOk: true,
          validation: { errors: [], warnings: [] },
          summary: 'Valid pipeline configuration',
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
  });

  // Per-pipeline folder layout: .tagma/<stem>/<stem>.yaml. The chat compile
  // watcher attaches per pipeline folder and reacts when the agent writes the
  // YAML inside it.
  const pipelineFolder = join(tagmaDir, 'created');
  mkdirSync(pipelineFolder, { recursive: true });
  const yamlPath = join(pipelineFolder, 'created.yaml');
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: Created By Chat',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: draft',
      '          name: Draft',
      '          prompt: Write a summary',
      '',
    ].join('\n'),
    'utf-8',
  );

  const logPath = yamlPath.replace(/\.ya?ml$/i, '.compile.log');
  await waitFor(() => existsSync(logPath), 'compile log creation');
  const result = JSON.parse(readFileSync(logPath, 'utf-8')) as {
    success?: boolean;
    sourceName?: string;
  };
  expect(result.success).toBe(true);
  expect(result.sourceName).toBe(yamlPath);

  // The watcher also drives the requirements-sync pass — verify the same-folder
  // .requirements.md is materialized so the runtime preflight has data to
  // read on the very first save (no delayed second flush required).
  const reqPath = yamlPath.replace(/\.ya?ml$/i, '.requirements.md');
  await waitFor(() => existsSync(reqPath), 'requirements doc creation');
  const reqContent = readFileSync(reqPath, 'utf-8');
  expect(reqContent).toContain('schemaVersion');
  expect(reqContent).toContain('generatedFor: created.yaml');
  expect(reqContent).toContain('# Requirements for `created.yaml`');

  const manifestPath = yamlPath.replace(/\.ya?ml$/i, '.manifest.json');
  await waitFor(() => existsSync(manifestPath), 'pipeline manifest creation');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    kind?: string;
    sections?: Array<{ id: string }>;
  };
  expect(manifest.kind).toBe('tagma-pipeline-manifest');
  expect(manifest.sections?.map((section) => section.id)).toEqual([
    'pipeline',
    'track:main',
    'task:main.draft',
  ]);
});
