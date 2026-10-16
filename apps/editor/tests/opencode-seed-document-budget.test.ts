import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTagmaPipelineAgent,
  renderManagedOpencodeAgentDocument,
  seedOpencodeArtifacts,
} from '../server/opencode-seed';
import {
  DEFAULT_OPENCODE_AGENT_MAX_STEPS,
  MAX_OPENCODE_AGENT_MAX_STEPS,
} from '../shared/opencode-agent-step-limit';

test('final seeded pipeline guidance includes all managed policies in every host budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-emitted-agent-budget-'));
  try {
    seedOpencodeArtifacts(root, {
      agentMaxSteps: MAX_OPENCODE_AGENT_MAX_STEPS,
      pythonToolsEnabled: true,
    });
    const hostOs = process.platform === 'win32' ? 'windows' : process.platform;
    expect(readFileSync(join(root, '.opencode/agents/tagma-pipeline.md'), 'utf8')).toBe(
      renderManagedOpencodeAgentDocument(
        buildTagmaPipelineAgent(hostOs, { pythonToolsEnabled: true }),
        true,
        MAX_OPENCODE_AGENT_MAX_STEPS,
      ),
    );
    for (const os of ['windows', 'darwin', 'linux']) {
      for (const pythonToolsEnabled of [false, true]) {
        for (const steps of [DEFAULT_OPENCODE_AGENT_MAX_STEPS, MAX_OPENCODE_AGENT_MAX_STEPS]) {
          const emitted = renderManagedOpencodeAgentDocument(
            buildTagmaPipelineAgent(os, { pythonToolsEnabled }),
            true,
            steps,
          );
          expect(emitted).toContain('tools:\n  tagma_stage_remove: true');
          expect(emitted).toContain('permission:\n  tagma_stage_remove: allow');
          expect(emitted).toContain(`steps: ${steps}`);
          expect(emitted.length).toBeLessThan(22_000);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
