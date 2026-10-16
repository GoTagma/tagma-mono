import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from '@tagma/sdk';
import { serializePipeline } from '@tagma/sdk/yaml';
import type { RawPipelineConfig } from '@tagma/types';
import { prepareTrialCaseWorkspace } from '../server/chat-pipeline-trial-run';

test('real Trial workspace coordinates preserve exact shell arguments and reject a missing cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-input-boundary-'));
  const folder = join(root, 'staged', 'input-proof');
  const yamlPath = join(folder, 'input-proof.yaml');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'capture.js'),
    `const payload = process.argv[2];
if (!payload?.trim()) { console.error('empty-string input rejected'); process.exit(2); }
console.log(JSON.stringify({ payload }));
`,
  );
  // Only the executable path is fixture quoting. Payload quoting is performed
  // by the production command template and active shell, then native argv.
  const executable =
    process.platform === 'win32'
      ? `'${process.execPath.replace(/'/g, "''")}'`
      : `'${process.execPath.replace(/'/g, "'\\''")}'`;
  const command = `${process.platform === 'win32' ? '& ' : ''}${executable} .tagma/input-proof/capture.js {{inputs.payload | shellquote}}`;
  const special = `O'Reilly "quoted" $HOME $(echo unsafe > escaped-probe) ; & | <tag>\n第二行🧭`;
  const vectors = [
    { payload: special, cwd: 'input-proof', expected: 'missing-cwd' },
    { payload: special, cwd: undefined, expected: 'exact-input' },
    { payload: '  padded payload  ', cwd: undefined, expected: 'exact-input' },
    { payload: ' \t\n', cwd: undefined, expected: 'empty-input' },
  ];
  try {
    for (const vector of vectors) {
      const pipeline: RawPipelineConfig = {
        name: 'Workspace input boundary',
        tracks: [
          {
            id: 'input',
            name: 'Input',
            tasks: [
              {
                id: 'capture',
                command,
                ...(vector.cwd ? { cwd: vector.cwd } : {}),
                inputs: { payload: { type: 'string', default: vector.payload } },
                outputs: { payload: { type: 'string' } },
              },
            ],
          },
        ],
      };
      const content = serializePipeline(pipeline);
      writeFileSync(yamlPath, content);
      const copy = prepareTrialCaseWorkspace(root, yamlPath, 'input-proof/input-proof.yaml', {
        id: 'input-copy',
        title: 'Input copy',
        objective: 'Exercise real workspace-root paths without any model invocation.',
        runs: 1,
        targetTaskIds: ['input.capture'],
        fixtures: [],
        expectations: [],
      });
      try {
        expect(existsSync(join(copy.workDir, '.tagma', 'input-proof', 'capture.js'))).toBe(true);
        expect(existsSync(join(copy.workDir, 'input-proof'))).toBe(false);
        let outputs: Record<string, unknown> | undefined;
        const outcome = await createTagma().runYaml(content, {
          cwd: copy.workDir,
          skipPluginLoading: true,
          onEvent(event: RunEventPayload) {
            if (event.type === 'task_update' && event.outputs) outputs = event.outputs;
          },
        });
        expect(outcome.kind).toBe('pipeline');
        if (outcome.kind !== 'pipeline') throw new Error('Expected actual command execution.');
        const state = outcome.result.states.get('input.capture')!;
        expect(existsSync(join(copy.workDir, 'escaped-probe'))).toBe(false);
        if (vector.expected === 'exact-input') {
          expect(outcome.result.success).toBe(true);
          expect(state.status).toBe('success');
          expect(outputs).toEqual({ payload: vector.payload });
        } else {
          expect(outcome.result.success).toBe(false);
          expect(state.status).toBe('failed');
          if (vector.expected === 'missing-cwd') {
            expect(state.result?.failureKind).toBe('spawn_error');
            expect(state.result?.stderr).toContain('Spawn working directory is unavailable');
            expect(outputs).toBeUndefined();
          } else {
            expect(state.result?.stderr).toContain('empty-string input rejected');
          }
        }
      } finally {
        rmSync(copy.rootDir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
