import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan.js';
import {
  cleanupOwnedFixtureConstructionRoots,
  realEngineFixture,
} from './chat-retained-trial-contract.fixture.js';
// A separate Host-owned path never gives the ordinary raw-plan reader authority to accept stale bytes.
test('ordinary reader strictly rejects original committed raw plan for repaired shell YAML', async () => {
  let value: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
  const root = mkdtempSync(join(tmpdir(), 'tagma-strict-old-plan-'));
  try {
    value = await realEngineFixture('retained-repair');
    await value.engine.dispatch(value.dispatchInput());
    expect(value.repairedYaml).not.toBe('');
    expect(value.committedPlanBytes).not.toBe('');
    mkdirSync(join(root, 'alpha'));
    const target = join(root, 'alpha/alpha.yaml');
    writeFileSync(target, value.repairedYaml);
    writeFileSync(target.replace(/\.yaml$/, '.trial-plan.json'), value.committedPlanBytes);
    expect(
      readChatPipelineTrialPlan(
        target,
        'alpha/alpha.yaml',
        createHash('sha1').update(value.repairedYaml).digest('hex'),
        2,
      ),
    ).toMatchObject({
      status: 'required',
      request: { reason: 'stale', message: 'The trial plan targets an older YAML revision.' },
    });
  } finally {
    if (value) await value.dispose();
    cleanupOwnedFixtureConstructionRoots();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
