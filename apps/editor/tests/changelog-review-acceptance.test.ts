import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createTagma, type PipelineConfig } from '@tagma/sdk';
import { loadPipeline } from '@tagma/sdk/yaml';
import type { DriverPlugin } from '@tagma/types';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { WorkspaceState } from '../server/workspace-state';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
} from '../server/chat-yaml-staging';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
} from '../server/chat-pipeline-trial-plan';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const fixturePath = join(import.meta.dir, 'fixtures/changelog-review/pipeline.yaml');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Model behavior is deterministic here; command execution, port resolution,
// continuation/middleware composition and completion gates use the real runtime.
const modelProgram = `
const fs = require('node:fs');
const spec = JSON.parse(process.argv[1]);
const entries = JSON.parse(fs.readFileSync('input/change-entries.json', 'utf8'));
const outputEntries = entries.map(e => ({...e}));
if (spec.artifactFault === 'missing-entry') outputEntries.pop();
if (spec.artifactFault === 'unknown-entry') outputEntries.push({...entries[0], id:'unregistered-entry'});
if (spec.artifactFault === 'duplicate-entry') outputEntries.push({...entries[0]});
if (spec.artifactFault === 'wrong-area') outputEntries[0].area = 'incorrect-area';
if (spec.artifactFault === 'missing-performance') outputEntries.find(e => e.severity === 'perf').severity = 'feature';
const issue = 'Add the missing breaking-change callout for ' + entries.find(e => e.severity === 'breaking').id;
const render = (fixed) => '# Changelog\\n\\n## [Unreleased]\\n' + [...new Set(outputEntries.map(e => e.area))].map(area =>
  '\\n## ' + area + '\\n' + outputEntries.filter(e => e.area === area).map(e =>
    '- [' + e.id + '] ' + e.summary + '\\n' +
    (e.severity === 'breaking' && fixed ? '> Breaking change: ' + e.summary + '\\n' : '') +
    (e.severity === 'perf' ? '> Performance: ' + e.summary + '\\n' : '')
  ).join('')).join('');
let result;
if (spec.task === 'draft-changelog') {
  fs.mkdirSync('work', {recursive:true});
  fs.writeFileSync('work/draft-changelog.md', render(spec.approve));
  result = {draftComplete:true};
} else if (spec.task === 'critique-draft') {
  result = spec.approve ? {verdict:'approve',score:100,issues:[]} : {verdict:'revise', score:65, issues:[issue]};
} else if (spec.task === 'revise-changelog') {
  const fixed = !spec.ignoreFeedback && (spec.approve || (Array.isArray(spec.inputs.issues) && spec.inputs.issues.includes(issue)));
  fs.writeFileSync('work/draft-changelog.md', render(fixed));
  result = {revisionComplete:true, revisedPath:'work/draft-changelog.md'};
} else if (spec.task === 'final-summary') {
  result = {digest:fs.readFileSync('work/final/CHANGELOG.md','utf8')};
} else throw new Error('Unexpected prompt task: '+spec.task);
process.stdout.write(JSON.stringify(result));
`;

async function setup(
  ignoreFeedback = false,
  options: { approve?: boolean; artifactFault?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-review-acceptance-'));
  roots.push(root);
  const config: PipelineConfig = await loadPipeline(readFileSync(fixturePath, 'utf8'), root);
  const pipelineRoot = resolve(root, config.tracks[0]!.cwd!);
  mkdirSync(pipelineRoot, { recursive: true });
  const received: Array<{ task: string; inputs: unknown; prompt: string }> = [];
  const driver: DriverPlugin = {
    name: 'opencode',
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    trial: {
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'native',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    },
    async buildCommand(task, _track, context) {
      received.push({ task: task.id, inputs: context.inputs, prompt: task.prompt ?? '' });
      return {
        cwd: context.workDir,
        args: [
          process.execPath,
          '-e',
          modelProgram,
          JSON.stringify({
            task: task.id,
            inputs: context.inputs,
            ignoreFeedback,
            ...options,
          }),
        ],
      };
    },
    parseResult(stdout) {
      return { normalizedOutput: stdout };
    },
  };
  const tagma = createTagma();
  tagma.registry.registerPlugin('drivers', 'opencode', driver, { replace: true });
  return { root, config, pipelineRoot, received, tagma, driver };
}

test.skipIf(process.platform !== 'win32')(
  'Host Sandbox verifies an unseeded creation path and source-grounded final content',
  async () => {
    const { root, config, pipelineRoot, driver } = await setup();
    const sourcePath = join(pipelineRoot, `${basename(pipelineRoot)}.yaml`);
    writeFileSync(sourcePath, readFileSync(fixturePath));
    writeFileSync(
      join(root, '.tagma/editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialLiveSmokeTestEnabled: false,
      }),
    );
    const ws = new WorkspaceState(root);
    ws.workDir = root;
    ws.yamlPath = sourcePath;
    ws.config = config;
    const builtins = createTagma({ registry: ws.registry });
    builtins.registry.registerPlugin('drivers', 'opencode', driver, { replace: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
    const fakeBin = join(root, 'test-bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'opencode.cmd'), '@echo off\r\n');
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ''}`;
    try {
      expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
      const namespace = dirname(entry.relativePath).replace(/\\/g, '/');
      const input = `${namespace}/input/change-entries.json`;
      const output = `${namespace}/work/final/CHANGELOG.md`;
      writeFileSync(
        entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
        JSON.stringify({
          version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
          yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
          summary:
            'Create the input from an empty case workspace and apply concrete review feedback.',
          goals: [
            'Exercise first-run creation and reject a release missing a required source-derived correction.',
          ],
          coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
            dimension,
            status: 'not-applicable',
            caseIds: [],
            rationale:
              'This case guards source creation and concrete content; repeat and negative gates have separate runtime regression coverage.',
          })),
          findings: [],
          cases: [
            {
              id: 'clean-first-run',
              title: 'Generate and verify the complete changelog from scratch',
              objective:
                'No input fixture exists; the pipeline must create the source and apply the review before publication.',
              targetTaskIds: ['reporting.final-summary'],
              runs: 1,
              fixtures: [],
              expectations: [
                { type: 'task-status', taskId: 'reporting.final-summary', status: 'success' },
                {
                  type: 'json-pointer-equals',
                  path: input,
                  pointer: '/0/id',
                  expectedJson: '"c-104"',
                },
                {
                  type: 'json-pointer-equals',
                  path: input,
                  pointer: '/3/severity',
                  expectedJson: '"breaking"',
                },
                ...['c-104', 'c-107', 'c-112', 'c-115'].map((id) => ({
                  type: 'file-contains',
                  path: output,
                  text: `[${id}]`,
                })),
                { type: 'file-contains', path: output, text: '> Breaking change' },
                { type: 'file-contains', path: output, text: '> Performance' },
              ],
            },
          ],
        }),
      );
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: 'clean_review_content',
      });
      expect(result.success, result.summary).toBe(true);
      expect(
        result.tasks.find((item) => item.taskId === 'bootstrap-data.seed-samples')?.stdout,
      ).toContain('seeded input/change-entries.json');
      expect(result.tasks.find((item) => item.taskId === 'reporting.final-summary')?.status).toBe(
        'success',
      );
      expect(existsSync(join(pipelineRoot, 'input/change-entries.json'))).toBe(false);
      expect(existsSync(join(pipelineRoot, 'work/final/CHANGELOG.md'))).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      discardChatYamlStage(ws, stage.id);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
    }
  },
  45_000,
);

test.skipIf(process.platform !== 'win32')(
  'clean first run and repeat pass concrete review feedback into the revision',
  async () => {
    const { root, config, pipelineRoot, received, tagma } = await setup();
    const source = join(pipelineRoot, 'input/change-entries.json');
    expect(existsSync(source)).toBe(false);
    for (let run = 0; run < 2; run += 1) {
      const result = await tagma.run(config, { cwd: root, defaultTaskTimeoutMs: 15_000 });
      expect(
        result.success,
        JSON.stringify(
          [...result.states]
            .filter(([, state]) => state.status === 'failed')
            .map(([id, state]) => ({ id, result: state.result })),
        ),
      ).toBe(true);
      const revision = received.filter((item) => item.task === 'revise-changelog').at(-1)!;
      expect(revision.inputs).toMatchObject({
        verdict: 'revise',
        issues: [expect.stringContaining('missing breaking-change callout')],
      });
      expect(revision.prompt).toContain('missing breaking-change callout');
      expect(JSON.parse(readFileSync(source, 'utf8'))).toHaveLength(4);
      expect(readFileSync(join(pipelineRoot, 'work/final/CHANGELOG.md'), 'utf8')).toContain(
        '> Breaking change',
      );
    }
  },
  30_000,
);

test.skipIf(process.platform !== 'win32')(
  'empty approval feedback and a structurally varied input remain valid',
  async () => {
    const { root, config, pipelineRoot, received, tagma } = await setup(false, { approve: true });
    mkdirSync(join(pipelineRoot, 'input'), { recursive: true });
    writeFileSync(
      join(pipelineRoot, 'input/change-entries.json'),
      JSON.stringify([
        {
          id: 'release.A-1',
          area: 'CLI',
          severity: 'breaking',
          summary: 'Require a new CLI option',
        },
        {
          id: 'release.B-2',
          area: 'Storage',
          severity: 'perf',
          summary: 'Reduce cache lookup time',
        },
        {
          id: 'release.C-3',
          area: 'Docs',
          severity: 'feature',
          summary: 'Add installation examples',
        },
        { id: 'release.D-4', area: 'CLI', severity: 'fix', summary: 'Preserve quoted arguments' },
      ]),
    );
    const result = await tagma.run(config, { cwd: root, defaultTaskTimeoutMs: 15_000 });
    expect(result.success).toBe(true);
    expect(received.find((item) => item.task === 'revise-changelog')?.inputs).toMatchObject({
      verdict: 'approve',
      issues: [],
    });
  },
  30_000,
);

for (const [fault, message] of [
  ['missing-entry', 'missing source entry'],
  ['unknown-entry', 'unknown source id'],
  ['duplicate-entry', 'duplicate changelog entry'],
  ['wrong-area', 'wrong area'],
  ['missing-performance', 'missing performance callout'],
] as const) {
  test.skipIf(process.platform !== 'win32')(
    `source-grounded publication gate rejects ${fault}`,
    async () => {
      const { root, config, pipelineRoot, tagma } = await setup(false, { artifactFault: fault });
      const result = await tagma.run(config, { cwd: root, defaultTaskTimeoutMs: 15_000 });
      const verification = result.states.get('release.verify-release');
      expect(verification?.status).toBe('failed');
      expect(verification?.result?.stdout).toContain(`validation-error: ${message}`);
      expect(result.states.get('release.publish-release')?.status).toBe('skipped');
      expect(existsSync(join(pipelineRoot, 'work/final/CHANGELOG.md'))).toBe(false);
    },
    30_000,
  );
}

test.skipIf(process.platform !== 'win32')(
  'publishing fails when a revision ignores a concrete review issue',
  async () => {
    const { root, config, pipelineRoot, tagma } = await setup(true);
    const result = await tagma.run(config, { cwd: root, defaultTaskTimeoutMs: 15_000 });
    expect(result.success).toBe(false);
    expect(result.states.get('release.verify-release')?.status).toBe('failed');
    expect(result.states.get('release.verify-release')?.result?.stdout).toContain(
      'validation-error: missing breaking-change callout',
    );
    expect(result.states.get('release.publish-release')?.status).toBe('skipped');
    expect(existsSync(join(pipelineRoot, 'work/final/CHANGELOG.md'))).toBe(false);
  },
  30_000,
);

for (const [name, data, failedTask] of [
  [
    'invalid-count',
    [{ id: 'one', area: 'api', severity: 'breaking', summary: 'One entry' }],
    'validate-samples',
  ],
  ['empty-input', [], 'seed-samples'],
] as const) {
  test.skipIf(process.platform !== 'win32')(
    `preserves the ${name} negative gate`,
    async () => {
      const { root, config, pipelineRoot, received, tagma } = await setup();
      mkdirSync(join(pipelineRoot, 'input'), { recursive: true });
      writeFileSync(join(pipelineRoot, 'input/change-entries.json'), JSON.stringify(data));
      const result = await tagma.run(config, { cwd: root, defaultTaskTimeoutMs: 15_000 });
      expect(result.success).toBe(false);
      expect(result.states.get('bootstrap-data.' + failedTask)?.status).toBe('failed');
      expect(received).toEqual([]);
      expect(existsSync(join(pipelineRoot, 'work/final/CHANGELOG.md'))).toBe(false);
    },
    30_000,
  );
}
