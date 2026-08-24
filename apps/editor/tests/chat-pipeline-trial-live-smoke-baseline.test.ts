import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('manual root tasks remain eligible for a consented live smoke auto-grant', () => {
  const config = pipeline([
    manualTask('pick_input'),
    plainTask('compute_hash', ['pick_input']),
    plainTask('resolve_policy'),
    plainTask('verify', ['compute_hash', 'resolve_policy']),
  ]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: ['main.pick_input'],
    middlewareUnavailableTaskIds: [],
    cwdUnavailableTaskIds: [],
  });
});

test('a fully manual-gated pipeline keeps a runnable live smoke baseline', () => {
  const config = pipeline([
    manualTask('pick_input'),
    plainTask('compute_hash', ['pick_input']),
    plainTask('verify', ['compute_hash']),
  ]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: ['main.pick_input'],
    middlewareUnavailableTaskIds: [],
    cwdUnavailableTaskIds: [],
  });
});

test('mid-pipeline manual tasks remain eligible for a consented live smoke auto-grant', () => {
  const config = pipeline([
    plainTask('ingest'),
    manualTask('review'),
    plainTask('publish', ['review']),
    plainTask('archive', ['ingest']),
  ]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: ['main.review'],
    middlewareUnavailableTaskIds: [],
    cwdUnavailableTaskIds: [],
  });
});

test('a pipeline without manual tasks keeps the run-all baseline', () => {
  const config = pipeline([plainTask('ingest'), plainTask('verify', ['ingest'])]);
  expect(resolveChatPipelineLiveSmokeBaseline(config, runnable, workDir)).toEqual({
    mode: 'run-all',
    manualGatedTaskIds: [],
    middlewareUnavailableTaskIds: [],
    cwdUnavailableTaskIds: [],
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
    cwdUnavailableTaskIds: [],
  });
});

test('manual auto-grants preserve fixture-backed live smoke targeting', () => {
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
      cwdUnavailableTaskIds: [],
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
      targetPipelineIsNew: false,
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
        targetPipelineIsNew: false,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
      cwdUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('staged-only effective cwd tasks are excluded from a new-pipeline Live Smoke baseline', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-staged-cwd-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'new-pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'new-pipeline');
  try {
    mkdirSync(liveWorkDir, { recursive: true });
    mkdirSync(join(stagedPipelineDir, 'task-work'), { recursive: true });
    const config = {
      name: 'New pipeline staged cwd',
      tracks: [
        {
          id: 'track_cwd',
          name: 'Track cwd',
          cwd: '.tagma/new-pipeline',
          tasks: [plainTask('ask')],
        },
        {
          id: 'task_cwd',
          name: 'Task cwd',
          tasks: [{ ...plainTask('ask'), cwd: '.tagma/new-pipeline/task-work' }],
        },
        {
          id: 'workspace',
          name: 'Workspace',
          tasks: [plainTask('audit')],
        },
      ],
    } as PipelineConfig;

    const baseline = resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
      livePipelineDir,
      stagedPipelineDir,
      targetPipelineIsNew: true,
    });

    expect(baseline.mode).toBe('targeted');
    expect(baseline.cwdUnavailableTaskIds).toEqual(['task_cwd.ask', 'track_cwd.ask']);
    if (baseline.mode !== 'targeted') throw new Error('expected targeted');
    expect(baseline.targetTaskIds).toEqual(['workspace.audit']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an existing pipeline losing its cwd remains Live Smoke eligible for the runtime failure', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-existing-missing-cwd-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'pipeline');
  try {
    mkdirSync(livePipelineDir, { recursive: true });
    mkdirSync(join(stagedPipelineDir, 'task-work'), { recursive: true });
    const config = {
      name: 'Existing pipeline missing cwd',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ ...plainTask('run'), cwd: '.tagma/pipeline/task-work' }],
        },
      ],
    } as PipelineConfig;

    expect(
      resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
        livePipelineDir,
        stagedPipelineDir,
        targetPipelineIsNew: false,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
      cwdUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an arbitrary missing cwd without a staged directory mirror remains Live Smoke eligible', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-missing-cwd-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'pipeline');
  try {
    mkdirSync(liveWorkDir, { recursive: true });
    mkdirSync(stagedPipelineDir, { recursive: true });
    const config = {
      name: 'Missing cwd is a pipeline error',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ ...plainTask('run'), cwd: '.tagma/pipeline/missing-runtime-dir' }],
        },
      ],
    } as PipelineConfig;

    expect(
      resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
        livePipelineDir,
        stagedPipelineDir,
        targetPipelineIsNew: true,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
      cwdUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a live cwd with the wrong filesystem type is not reclassified as staged-only', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-file-cwd-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'pipeline');
  try {
    mkdirSync(livePipelineDir, { recursive: true });
    writeFileSync(join(livePipelineDir, 'task-work'), 'not a directory', 'utf-8');
    mkdirSync(join(stagedPipelineDir, 'task-work'), { recursive: true });
    const config = {
      name: 'Invalid live cwd type',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ ...plainTask('run'), cwd: '.tagma/pipeline/task-work' }],
        },
      ],
    } as PipelineConfig;

    expect(
      resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
        livePipelineDir,
        stagedPipelineDir,
        targetPipelineIsNew: true,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
      cwdUnavailableTaskIds: [],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a live cwd below a dangling symlink is not reclassified as staged-only', () => {
  const temp = mkdtempSync(join(tmpdir(), 'tagma-trial-baseline-dangling-cwd-'));
  const liveWorkDir = join(temp, 'live');
  const livePipelineDir = join(liveWorkDir, '.tagma', 'new-pipeline');
  const stagedPipelineDir = join(temp, 'stage', '.tagma', 'new-pipeline');
  try {
    mkdirSync(livePipelineDir, { recursive: true });
    symlinkSync(
      join(temp, 'missing-target'),
      join(livePipelineDir, 'task-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    mkdirSync(join(stagedPipelineDir, 'task-link', 'child'), { recursive: true });
    const config = {
      name: 'Dangling live cwd ancestor',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ ...plainTask('run'), cwd: '.tagma/new-pipeline/task-link/child' }],
        },
      ],
    } as PipelineConfig;

    expect(
      resolveChatPipelineLiveSmokeBaseline(config, runnable, liveWorkDir, {
        livePipelineDir,
        stagedPipelineDir,
        targetPipelineIsNew: true,
      }),
    ).toEqual({
      mode: 'run-all',
      manualGatedTaskIds: [],
      middlewareUnavailableTaskIds: [],
      cwdUnavailableTaskIds: [],
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
