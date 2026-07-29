import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const editorRoot = join(import.meta.dir, '..');

describe('desktop sidecar build', () => {
  test('bundles and verifies the chat trial witness worker in the compiled executable', () => {
    const buildSource = readFileSync(
      join(editorRoot, 'scripts', 'build-desktop-sidecar.ts'),
      'utf-8',
    );
    const serverSource = readFileSync(
      join(editorRoot, 'server', 'chat-pipeline-trial-witness.ts'),
      'utf-8',
    );

    expect(buildSource).toContain(
      "join(packageDir, 'server', 'chat-pipeline-trial-witness-worker.ts')",
    );
    expect(buildSource).toContain('buildTrialWitnessWorkerSource');
    expect(buildSource).toContain(
      '__TAGMA_TRIAL_WITNESS_WORKER_SOURCE__: JSON.stringify(trialWitnessWorkerSource)',
    );
    expect(buildSource).toContain('verifyCompiledTrialWitnessWorker(outfile');
    expect(serverSource).toContain(
      "new Blob([embeddedSource], { type: 'text/javascript' })",
    );
    expect(serverSource).toContain(
      "new URL('./chat-pipeline-trial-witness-worker.js', import.meta.url)",
    );
  });
});
