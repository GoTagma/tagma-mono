import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  drainBoundedCommandStream,
  runChatV2AgentCycle,
  type ChatV2AgentCycleDependencies,
} from '../scripts/chat-v2-agent-cycle.js';
import type {
  ChatV2AgentLoopScenario,
  IsolatedChatV2AgentLoopReport,
} from '../scripts/chat-v2-agent-loop.js';

const cleanup: string[] = [];

test('bounded command capture drains all bytes while retaining finite evidence', async () => {
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('abcdefghij'));
      controller.enqueue(new TextEncoder().encode('klmnopqrst'));
      controller.close();
      closed = true;
    },
  });

  const result = await drainBoundedCommandStream(stream, 12);

  expect(closed).toBeTrue();
  expect(result).toEqual({ text: 'abcdefghijkl', clipped: true, totalBytes: 20 });
});

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function artifactsRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'tagma-agent-cycle-test-'));
  cleanup.push(path);
  return path;
}

function scenarioReport(input: {
  scenario: ChatV2AgentLoopScenario;
  sidecarMode: 'source' | 'compiled';
  providerMode?: 'real' | 'fake';
  verdict?: 'passed' | 'failed';
  failureName?: string;
  failureMessage?: string;
}): IsolatedChatV2AgentLoopReport {
  const verdict = input.verdict ?? 'passed';
  return {
    schemaVersion: 1,
    runId: `${input.sidecarMode}-${input.scenario}`,
    scenario: input.scenario,
    sidecarMode: input.sidecarMode,
    verdict,
    startedAt: 1,
    completedAt: 2,
    operation:
      verdict === 'passed'
        ? {
            operationId: `operation-${input.scenario}`,
            terminalOutcome: 'completed_readonly',
            actionKinds: ['create', 'projection'],
            rendererEvidence: {
              terminalDetailFetched: true,
              hasResult: true,
              assistantMessageCount: 1,
              visibleContentBytes: 24,
              phaseHistory: ['classifying', 'executing_readonly', 'terminal'],
            },
          }
        : null,
    lastOperation:
      verdict === 'failed'
        ? {
            operationId: `operation-${input.scenario}`,
            generation: 1,
            version: 2,
            phase: 'awaiting_input',
            waitReason: 'provider_unavailable',
            terminalOutcome: null,
            actionKinds: ['create', 'projection'],
          }
        : null,
    failure:
      verdict === 'failed'
        ? {
            name: input.failureName ?? 'ProviderError',
            message: input.failureMessage ?? 'volatile detail 12345',
          }
        : null,
    provider: {
      mode: input.providerMode ?? 'real',
      provider: input.providerMode === 'fake' ? 'tagma-loop-provider' : 'opencode',
      model: input.providerMode === 'fake' ? 'loop-model' : 'deepseek-v4-flash-free',
      selection: input.providerMode === 'fake' ? 'deterministic-fake' : 'opencode-free',
    },
    diagnostics: {
      protocolVersion: 1,
      timelineCursor: 3,
      logCursor: 4,
      timelineTruncated: false,
      logsTruncated: false,
      hostEventCount: 2,
      opencodeSessionCount: 1,
    },
    artifactsDirectory: 'scenario-artifacts',
    reportPath: `scenario-${input.sidecarMode}-${input.scenario}.json`,
    diagnosticsPath: 'diagnostics.json',
  };
}

function dependencies(input?: {
  fail?: { mode: 'source' | 'compiled'; scenario: ChatV2AgentLoopScenario };
  failOnce?: boolean;
  failureMessages?: readonly string[];
  throwScenario?: boolean;
  cleanupFailure?: boolean;
  reportProviderMode?: 'real' | 'fake';
}): { dependencies: ChatV2AgentCycleDependencies; calls: string[] } {
  const calls: string[] = [];
  let failedOnce = false;
  let failureCount = 0;
  return {
    calls,
    dependencies: {
      buildCompiledSidecar: async () => {
        calls.push('build');
        return {
          executablePath: 'compiled-sidecar',
          sha256: 'a'.repeat(64),
          output: 'built',
        };
      },
      runScenario: async ({ scenario, sidecarExecutable, providerMode }) => {
        expect(providerMode).toBe('real');
        const mode = sidecarExecutable ? 'compiled' : 'source';
        calls.push(`${mode}:${scenario}`);
        if (input?.throwScenario) throw new Error('scenario transport crashed');
        const matchesFailure = input?.fail?.mode === mode && input.fail.scenario === scenario;
        const failed = matchesFailure && (!input?.failOnce || !failedOnce);
        if (failed) failedOnce = true;
        const failureMessage = input?.failureMessages?.[failureCount];
        if (failed) failureCount += 1;
        return scenarioReport({
          scenario,
          sidecarMode: mode,
          providerMode: input?.reportProviderMode,
          verdict: failed ? 'failed' : 'passed',
          ...(failureMessage ? { failureMessage } : {}),
        });
      },
      cleanupBuildDirectory: async () => {
        if (input?.cleanupFailure) throw new Error('build cleanup failed');
      },
    },
  };
}

test('agent cycle owns stable real-provider source runs, a fresh build, and stable compiled runs', async () => {
  const harness = dependencies();
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.verdict).toBe('passed');
  expect(report.nextAction).toBe('verified');
  expect(report.failure).toBeNull();
  expect(harness.calls).toEqual([
    'source:clarification',
    'source:discussion',
    'source:authoring-trial',
    'source:authoring-create-trial',
    'source:clarification',
    'source:discussion',
    'source:authoring-trial',
    'source:authoring-create-trial',
    'build',
    'compiled:clarification',
    'compiled:discussion',
    'compiled:authoring-trial',
    'compiled:authoring-create-trial',
    'compiled:clarification',
    'compiled:discussion',
    'compiled:authoring-trial',
    'compiled:authoring-create-trial',
  ]);
  expect(report.runs).toHaveLength(16);
  expect(report.build).toMatchObject({ verdict: 'passed', sha256: 'a'.repeat(64) });
});

test('agent cycle cannot report verified from a fake provider scenario', async () => {
  const harness = dependencies({ reportProviderMode: 'fake' });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['discussion'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.verdict).toBe('failed');
  expect(report.nextAction).toBe('repair_required');
  expect(report.failure).toMatchObject({
    phase: 'source_matrix',
    mode: 'source',
    scenario: 'discussion',
    name: 'RealProviderRequired',
  });
});

test('agent cycle stops before build and emits a stable source failure fingerprint', async () => {
  const first = dependencies({ fail: { mode: 'source', scenario: 'discussion' } });
  const second = dependencies({ fail: { mode: 'source', scenario: 'discussion' } });
  const options = {
    artifactsParentDirectory: artifactsRoot(),
    scenarios: ['clarification', 'discussion'] as const,
    stabilityRuns: 2,
  };
  const firstReport = await runChatV2AgentCycle(options, first.dependencies);
  const secondReport = await runChatV2AgentCycle(
    { ...options, artifactsParentDirectory: artifactsRoot() },
    second.dependencies,
  );

  expect(firstReport.verdict).toBe('failed');
  expect(firstReport.nextAction).toBe('repair_required');
  expect(firstReport.confirmation).toMatchObject({ verdict: 'confirmed' });
  expect(firstReport.failure).toMatchObject({
    phase: 'source_matrix',
    mode: 'source',
    scenario: 'discussion',
    name: 'ProviderError',
  });
  expect(firstReport.failure?.fingerprint).toBe(secondReport.failure?.fingerprint);
  expect(first).toBeDefined();
  expect(firstReport.build).toBeNull();
  expect(first.calls).toEqual(['source:clarification', 'source:discussion', 'source:discussion']);
});

test('agent cycle reports a compiled-only regression after rebuilding current source', async () => {
  const harness = dependencies({ fail: { mode: 'compiled', scenario: 'clarification' } });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['clarification'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.verdict).toBe('failed');
  expect(report.nextAction).toBe('repair_required');
  expect(report.failure).toMatchObject({
    phase: 'compiled_matrix',
    mode: 'compiled',
    scenario: 'clarification',
  });
  expect(report.build?.verdict).toBe('passed');
  expect(report.confirmation).toMatchObject({ verdict: 'confirmed' });
  expect(harness.calls).toEqual([
    'source:clarification',
    'source:clarification',
    'build',
    'compiled:clarification',
    'compiled:clarification',
  ]);
});

test('agent cycle classifies a thrown first source scenario at the owning phase', async () => {
  const harness = dependencies({ throwScenario: true });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['clarification'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.failure).toMatchObject({
    phase: 'source_matrix',
    mode: 'source',
    scenario: 'clarification',
    stabilityRun: 1,
    name: 'Error',
  });
  expect(report.build).toBeNull();
  expect(report.confirmation).toMatchObject({ verdict: 'confirmed' });
});

test('agent cycle separates a non-reproduced failure from a repairable defect', async () => {
  const harness = dependencies({
    fail: { mode: 'source', scenario: 'discussion' },
    failOnce: true,
  });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['clarification', 'discussion'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.verdict).toBe('failed');
  expect(report.nextAction).toBe('investigate_instability');
  expect(report.confirmation).toMatchObject({
    verdict: 'not_reproduced',
    mode: 'source',
    scenario: 'discussion',
  });
  expect(report.runs.at(-1)).toMatchObject({
    purpose: 'confirmation',
    verdict: 'passed',
  });
  expect(report.build).toBeNull();
});

test('agent cycle does not confirm two different provider mechanisms with the same Error name', async () => {
  const harness = dependencies({
    fail: { mode: 'source', scenario: 'discussion' },
    failureMessages: ['provider failure code alpha 12345', 'provider failure code beta 67890'],
  });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['discussion'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.nextAction).toBe('investigate_instability');
  expect(report.confirmation).toMatchObject({ verdict: 'divergent' });
  expect(report.confirmation?.initialFingerprint).not.toBe(
    report.confirmation?.confirmationFingerprint,
  );
});

test('agent cycle cannot verify while its compiled build runtime remains live', async () => {
  const harness = dependencies({ cleanupFailure: true });
  const report = await runChatV2AgentCycle(
    {
      artifactsParentDirectory: artifactsRoot(),
      scenarios: ['clarification'],
      stabilityRuns: 2,
    },
    harness.dependencies,
  );

  expect(report.verdict).toBe('failed');
  expect(report.cleanup).toEqual({ verdict: 'failed', message: 'build cleanup failed' });
  expect(report.failure).toMatchObject({
    phase: 'cleanup',
    mode: null,
    name: 'Error',
  });
});

test('agent cycle rejects a stability count that cannot prove repetition', async () => {
  const harness = dependencies();
  await expect(
    runChatV2AgentCycle(
      {
        artifactsParentDirectory: artifactsRoot(),
        scenarios: ['clarification'],
        stabilityRuns: 1,
      },
      harness.dependencies,
    ),
  ).rejects.toThrow('stabilityRuns must be an integer from 2 to 5');
  expect(harness.calls).toEqual([]);
});

test('agent cycle excludes the protocol-only authoring-permission harness scenario', async () => {
  const harness = dependencies();
  await expect(
    runChatV2AgentCycle(
      {
        artifactsParentDirectory: artifactsRoot(),
        scenarios: ['authoring-permission'],
        stabilityRuns: 2,
      },
      harness.dependencies,
    ),
  ).rejects.toThrow('Agent cycle scenarios must be unique supported scenario ids');
  expect(harness.calls).toEqual([]);
});
