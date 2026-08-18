import { expect, test } from 'bun:test';

import {
  applyTrialWorkspaceMutationEvent,
  type TrialWorkspaceMutationEventState,
} from '../server/chat-pipeline-trial-run';

const MAX_EVENTS = 10_000;
const MAX_CHANGE_PATHS = 32;

function freshState(): TrialWorkspaceMutationEventState {
  return { healthy: true, reason: null, eventRevision: 0, revision: 0, recentChanges: [] };
}

test('ignored runtime churn never consumes the bounded event capacity', () => {
  let state = freshState();
  for (let index = 0; index < MAX_EVENTS + 1_000; index += 1) {
    state = applyTrialWorkspaceMutationEvent(
      state,
      `.tagma/.opencode-runtime/session-${index}.json`,
    );
  }
  expect(state.healthy).toBe(true);
  expect(state.reason).toBeNull();
  expect(state.revision).toBe(0);
  expect(state.eventRevision).toBe(MAX_EVENTS + 1_000);

  // A tracked event after the ignored flood is still observed normally.
  state = applyTrialWorkspaceMutationEvent(state, 'src/report.md');
  expect(state.healthy).toBe(true);
  expect(state.revision).toBe(1);
  expect(state.recentChanges.map((item) => item.path)).toEqual(['src/report.md']);
});

test('ignored noise does not consume capacity ahead of tracked events', () => {
  let state = freshState();
  for (let index = 0; index < MAX_EVENTS - 1; index += 1) {
    state = applyTrialWorkspaceMutationEvent(state, `.tagma/logs/run-${index}/pipeline.log`);
  }
  state = applyTrialWorkspaceMutationEvent(state, 'src/a.txt');
  state = applyTrialWorkspaceMutationEvent(state, 'src/b.txt');
  expect(state.healthy).toBe(true);
  expect(state.revision).toBe(2);
  expect(state.recentChanges.map((item) => item.path)).toEqual(['src/a.txt', 'src/b.txt']);
});

test('tracked events still exhaust the bounded capacity and fail the monitor', () => {
  let state = freshState();
  for (let index = 0; index < MAX_EVENTS + 5; index += 1) {
    state = applyTrialWorkspaceMutationEvent(state, `src/file-${index}.txt`);
  }
  expect(state.healthy).toBe(false);
  expect(state.reason).toBe('Workspace mutation monitor exceeded its bounded event capacity.');
  expect(state.revision).toBe(MAX_EVENTS);
});

test('an unknown path fails the monitor and the first failure reason wins', () => {
  const state = applyTrialWorkspaceMutationEvent(freshState(), null);
  expect(state.healthy).toBe(false);
  expect(state.reason).toBe('Workspace mutation monitor reported an unknown path.');

  const later = applyTrialWorkspaceMutationEvent(state, 'src/file.txt');
  expect(later).toEqual(state);
});

test('recent change paths stay bounded while revision keeps counting', () => {
  let state = freshState();
  for (let index = 0; index < 50; index += 1) {
    state = applyTrialWorkspaceMutationEvent(state, `src/file-${index}.txt`);
  }
  expect(state.healthy).toBe(true);
  expect(state.revision).toBe(50);
  expect(state.recentChanges).toHaveLength(MAX_CHANGE_PATHS);
  expect(state.recentChanges[0]!.path).toBe(`src/file-${50 - MAX_CHANGE_PATHS}.txt`);
  expect(state.recentChanges[MAX_CHANGE_PATHS - 1]!.path).toBe('src/file-49.txt');
});

test('ignored path classification covers the trial-owned runtime directories', () => {
  let state = freshState();
  for (const path of [
    '.git/objects/ab/cdef',
    '.tagma/.chat-staging/x/.trial-cases/case-a/workspace/input/f.txt',
    '.tagma/.opencode/plugins/x',
    '.tagma/.usage/usage.jsonl',
    '.tagma/logs/run_x/pipeline.log',
    '.tagma/node_modules/pkg/index.js',
  ]) {
    state = applyTrialWorkspaceMutationEvent(state, path);
  }
  expect(state.healthy).toBe(true);
  expect(state.revision).toBe(0);
});
