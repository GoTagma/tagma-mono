import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PipelineConfig } from '@tagma/sdk';

import {
  resolveChatPipelineLiveSmokeBaseline,
  type ChatPipelineTrialReadiness,
} from '../server/chat-pipeline-trial-readiness';

function manualTask(
  id: string,
  deps: string[] = [],
): {
  id: string;
  name: string;
  command: { argv: string[] };
  trigger: { type: 'manual'; message: string };
  depends_on?: string[];
} {
  return {
    id,
    name: id,
    command: { argv: ['node', '-e', ''] },
    trigger: { type: 'manual', message: `Approve ${id}` },
    ...(deps.length > 0 ? { depends_on: deps } : {}),
  };
}

function plainTask(
  id: string,
  deps: string[] = [],
): {
  id: string;
  name: string;
  command: { argv: string[] };
  depends_on?: string[];
} {
  return {
    id,
    name: id,
    command: { argv: ['node', '-e', ''] },
    ...(deps.length > 0 ? { depends_on: deps } : {}),
  };
}

function contextTask(
  id: string,
  file: string,
  deps: string[] = [],
): {
  id: string;
  name: string;
  prompt: string;
  middlewares: Array<{ type: string; file: string }>;
  depends_on?: string[];
} {
  return {
    id,
    name: id,
    prompt: `Use the context for ${id}.`,
    middlewares: [{ type: 'static_context', file }],
    ...(deps.length > 0 ? { depends_on: deps } : {}),
  };
}

function commandWithInertContext(
  id: string,
  file: string,
): {
  id: string;
  name: string;
  command: { argv: string[] };
  middlewares: Array<{ type: string; file: string }>;
} {
  return {
    id,
    name: id,
    command: { argv: ['node', '-e', ''] },
    middlewares: [{ type: 'static_context', file }],
  };
}

type AnyTask =
  | ReturnType<typeof manualTask>
  | ReturnType<typeof plainTask>
  | ReturnType<typeof contextTask>
  | ReturnType<typeof commandWithInertContext>;

function pipeline(tasks: AnyTask[]): PipelineConfig {
  return {
    name: 'Live smoke baseline',
    tracks: [{ id: 'main', name: 'Main', tasks }],
  } as PipelineConfig;
}

const runnable: ChatPipelineTrialReadiness = { state: 'runnable' };
const workDir = join(tmpdir(), 'tagma-trial-baseline');

test('manual root tasks and their dependents are excluded from the live smoke', () => {
  const config = pipeline([
    manualTask('pick_input'),
    plainTask('compute_hash', ['pick_input']),
    plainTask('resolve_policy'),
    plainTask('verify', ['compute_hash', 'resolve_policy']),
  ]);
  const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir);
  expect(baseline.mode).toBe('targeted');
  expect(baseline.manualGatedTaskIds).toEqual(['main.pick_input']);
  if (baseline.mode !== 'targeted') throw new Error('expected targeted');
  expect(baseline.targetTaskIds).toEqual(['main.resolve_policy']);
});

test('the live smoke is skipped when every eligible task is manual-gated', () => {
  const config = pipeline([
    manualTask('pick_input'),
    plainTask('compute_hash', ['pick_input']),
    plainTask('verify', ['compute_hash']),
  ]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir).mode).toBe('skip');
});

test('mid-pipeline manual tasks also gate the live smoke', () => {
  const config = pipeline([
    plainTask('ingest'),
    manualTask('review'),
    plainTask('publish', ['review']),
    plainTask('archive', ['ingest']),
  ]);
  const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir);
  expect(baseline.mode).toBe('targeted');
  if (baseline.mode !== 'targeted') throw new Error('expected targeted');
  expect(baseline.targetTaskIds.sort()).toEqual(['main.archive', 'main.ingest']);
  expect(baseline.manualGatedTaskIds).toEqual(['main.review']);
});

test('a pipeline without manual tasks keeps the run-all baseline', () => {
  const config = pipeline([plainTask('ingest'), plainTask('verify', ['ingest'])]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: [],
    middlewareUnavailableTaskIds: [],
  });
});

test('command tasks ignore inert static_context configuration when selecting Live Smoke', () => {
  const config = pipeline([
    commandWithInertContext('archive', 'missing-but-inert.yaml'),
    plainTask('publish', ['archive']),
  ]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: [],
    middlewareUnavailableTaskIds: [],
  });
});

test('manual gating intersects with fixture-backed targeting', () => {
  const config = pipeline([
    manualTask('pick_input'),
    plainTask('normalize', ['pick_input']),
    plainTask('policy'),
    plainTask('verify', ['normalize', 'policy']),
  ]);
  const fixtureBacked: ChatPipelineTrialReadiness = {
    state: 'fixture-backed',
    inputs: [],
    baseline: { mode: 'targeted', targetTaskIds: ['main.policy'] },
  };
  const baseline = resolveChatPipelineLiveSmokeBaseline(config, fixtureBacked, workDir);
  expect(baseline.mode).toBe('targeted');
  if (baseline.mode !== 'targeted') throw new Error('expected targeted');
  expect(baseline.targetTaskIds).toEqual(['main.policy']);
});

test('fixture-backed skip stays skipped when manual tasks are also present', () => {
  const config = pipeline([manualTask('pick_input'), plainTask('policy')]);
  const fixtureBacked: ChatPipelineTrialReadiness = {
    state: 'fixture-backed',
    inputs: [],
    baseline: { mode: 'skip' },
  };
  expect(resolveChatPipelineLiveSmokeBaseline(config, fixtureBacked, workDir).mode).toBe('skip');
});

test('blocked readiness never runs a live smoke', () => {
  const config = pipeline([plainTask('ingest')]);
  const blocked: ChatPipelineTrialReadiness = {
    state: 'blocked',
    blockers: [{ kind: 'binary', name: 'missing-tool' }],
  };
  expect(resolveChatPipelineLiveSmokeBaseline(config, blocked, workDir).mode).toBe('skip');
});

test('tasks whose static_context source is missing in the real workspace are excluded', () => {
  const config = pipeline([
    contextTask('resolve_policy', '.tagma/pipeline/trusted-sources.yaml'),
    plainTask('verify', ['resolve_policy']),
    plainTask('audit'),
  ]);
  const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir);
  expect(baseline.mode).toBe('targeted');
  expect(baseline.middlewareUnavailableTaskIds).toEqual(['main.resolve_policy']);
  if (baseline.mode !== 'targeted') throw new Error('expected targeted');
  expect(baseline.targetTaskIds).toEqual(['main.audit']);
});

test('a present static_context source does not gate the live smoke', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-present-'));
  try {
    writeFileSync(join(temp, 'allowlist.yaml'), 'version: 1\n');
    const config = pipeline([
      contextTask('resolve_policy', 'allowlist.yaml'),
      plainTask('verify', ['resolve_policy']),
    ]);
    const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, temp);
    expect(baseline).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a staged static_context edit excludes the stale real-workspace branch', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-staged-edit-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'pipeline');
  try {
    mkdirSync(livePipelineDir, { recursive: true });
    mkdirSync(stagedPipelineDir, { recursive: true });
    writeFileSync(join(livePipelineDir, 'allowlist.yaml'), 'version: old\n');
    writeFileSync(join(stagedPipelineDir, 'allowlist.yaml'), 'version: staged\n');
    const config = pipeline([
      contextTask('resolve_policy', '.tagma/pipeline/allowlist.yaml'),
      plainTask('verify', ['resolve_policy']),
      plainTask('audit'),
    ]);

    const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
      livePipelineDir,
      stagedPipelineDir,
    });

    expect(baseline.mode).toBe('targeted');
    expect(baseline.middlewareUnavailableTaskIds).toEqual(['main.resolve_policy']);
    if (baseline.mode !== 'targeted') throw new Error('expected targeted');
    expect(baseline.targetTaskIds).toEqual(['main.audit']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('byte-identical staged and live static_context sources remain Live Smoke ready', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-staged-same-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'pipeline');
  try {
    mkdirSync(livePipelineDir, { recursive: true });
    mkdirSync(stagedPipelineDir, { recursive: true });
    writeFileSync(join(livePipelineDir, 'allowlist.yaml'), 'version: same\n');
    writeFileSync(join(stagedPipelineDir, 'allowlist.yaml'), 'version: same\n');
    const config = pipeline([
      contextTask('resolve_policy', '.tagma/pipeline/allowlist.yaml'),
      plainTask('verify', ['resolve_policy']),
    ]);

    expect(
      resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
        livePipelineDir,
        stagedPipelineDir,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a task-level cwd resolves the middleware source relative to that cwd', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-cwd-'));
  try {
    mkdirSync(join(temp, 'policy'));
    writeFileSync(join(temp, 'policy', 'allowlist.yaml'), 'version: 1\n');
    const config = {
      name: 'Live smoke baseline cwd',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'resolve_policy',
              name: 'Resolve',
              cwd: 'policy',
              command: { argv: ['node', '-e', ''] },
              middlewares: [{ type: 'static_context', file: 'allowlist.yaml' }],
            },
          ],
        },
      ],
    } as PipelineConfig;
    const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, temp);
    expect(baseline.mode).toBe('run-all');
    expect(baseline.middlewareUnavailableTaskIds).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
