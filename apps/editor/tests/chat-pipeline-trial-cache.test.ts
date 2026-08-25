import { expect, test } from 'bun:test';

import {
  buildChatPipelineTrialLiveSmokeReadiness,
  CHAT_PIPELINE_TRIAL_CACHE_VERSION,
  isChatPipelineTrialLiveSmokeReadiness,
} from '../server/chat-pipeline-trial-cache';

test('builds a canonical complete Live Smoke readiness projection', () => {
  expect(CHAT_PIPELINE_TRIAL_CACHE_VERSION).toBe(24);
  expect(
    buildChatPipelineTrialLiveSmokeReadiness({
      targetPipelineIsNew: true,
      dataReadiness: {
        state: 'fixture-backed',
        baseline: { mode: 'targeted', targetTaskIds: ['main.ready'] },
        inputs: [
          {
            taskId: 'main.waiting',
            type: 'directory',
            path: 'input/articles',
            fixturePath: 'input/articles',
          },
          {
            taskId: 'main.waiting',
            type: 'directory',
            path: 'input/articles',
            fixturePath: 'input/articles',
          },
        ],
      },
      baseline: {
        mode: 'targeted',
        targetTaskIds: ['main.ready', 'main.audit'],
        manualGatedTaskIds: ['main.manual'],
        middlewareUnavailableTaskIds: ['main.context'],
        cwdUnavailableTaskIds: ['main.waiting'],
      },
    }),
  ).toEqual({
    targetPipelineIsNew: true,
    dataReadinessState: 'fixture-backed',
    dataUnavailableTaskIds: ['main.waiting'],
    mode: 'targeted',
    targetTaskIds: ['main.audit', 'main.ready'],
    manualGatedTaskIds: ['main.manual'],
    middlewareUnavailableTaskIds: ['main.context'],
    cwdUnavailableTaskIds: ['main.waiting'],
  });
});

test('accepts only canonical complete Live Smoke readiness records', () => {
  const valid = {
    targetPipelineIsNew: true,
    dataReadinessState: 'fixture-backed' as const,
    dataUnavailableTaskIds: ['main.input'],
    mode: 'targeted' as const,
    targetTaskIds: ['main.audit'],
    manualGatedTaskIds: ['main.manual'],
    middlewareUnavailableTaskIds: ['main.context'],
    cwdUnavailableTaskIds: ['main.cwd'],
  };
  expect(isChatPipelineTrialLiveSmokeReadiness(valid)).toBe(true);
  expect(
    isChatPipelineTrialLiveSmokeReadiness({
      ...valid,
      dataUnavailableTaskIds: ['main.z', 'main.a'],
    }),
  ).toBe(false);
  expect(
    isChatPipelineTrialLiveSmokeReadiness({
      ...valid,
      targetTaskIds: ['main.audit', 'main.audit'],
    }),
  ).toBe(false);
  expect(isChatPipelineTrialLiveSmokeReadiness({ ...valid, mode: 'skip', targetTaskIds: [] })).toBe(
    true,
  );
  expect(isChatPipelineTrialLiveSmokeReadiness({ ...valid, mode: 'skip' })).toBe(false);
  expect(
    isChatPipelineTrialLiveSmokeReadiness({
      ...valid,
      targetPipelineIsNew: false,
      cwdUnavailableTaskIds: ['main.cwd'],
    }),
  ).toBe(false);
  expect(
    isChatPipelineTrialLiveSmokeReadiness({
      ...valid,
      dataReadinessState: 'runnable',
      dataUnavailableTaskIds: ['main.input'],
    }),
  ).toBe(false);
  const { mode: _omittedMode, ...missingMode } = valid;
  expect(isChatPipelineTrialLiveSmokeReadiness(missingMode)).toBe(false);
  expect(isChatPipelineTrialLiveSmokeReadiness({ ...valid, unexpected: true })).toBe(false);
});
