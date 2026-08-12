import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildTagmaCommandEvidenceAgent,
  buildTagmaContextPackagerAgent,
  buildTagmaGeneralDiscussionAgent,
  buildTagmaHistoryCompareAgent,
  buildTagmaNativePrimitivesSkill,
  buildTagmaPipelineAgent,
  buildTagmaPipelineDiagnosisAgent,
  buildTagmaPipelinePlannerAgent,
  buildTagmaPipelineSectionBuilderAgent,
  buildTagmaPlacementTool,
  buildTagmaPythonToolsAgent,
  buildTagmaRuntimeGuardAgent,
  buildTagmaRouterAgent,
  buildTagmaTrialPlanTool,
  buildTagmaTriggerStrategySkill,
  buildTagmaYamlContractSkill,
  seedOpencodeArtifacts,
} from '../server/opencode-seed';
import {
  parseChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
} from '../server/chat-pipeline-trial-plan';

type GeneratedTrialPlanTool = {
  execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
};

function fakeSchemaNode(): Record<string, (...args: unknown[]) => unknown> {
  const node: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['describe', 'optional', 'int', 'min', 'max']) {
    node[method] = () => node;
  }
  return node;
}

const fakeSchema = new Proxy<Record<string, (...args: unknown[]) => unknown>>(
  {},
  {
    get: () => () => fakeSchemaNode(),
  },
);
const fakeTool = Object.assign((definition: unknown) => definition, { schema: fakeSchema });

mock.module('@opencode-ai/plugin', () => ({ tool: fakeTool }));

let generatedTrialPlanAttemptSequence = 0;

function issueGeneratedTrialPlanAttempt(
  pipelinePath: string,
  context: { directory: string },
): string {
  const attemptId = `host-generated-attempt-${++generatedTrialPlanAttemptSequence}`;
  const yamlPath = isAbsolute(pipelinePath)
    ? pipelinePath
    : join(context.directory, ...pipelinePath.replace(/\\/g, '/').split('/'));
  const stagedTagmaDir = isAbsolute(pipelinePath) ? dirname(dirname(yamlPath)) : context.directory;
  const normalizedStagedRoot = stagedTagmaDir.replace(/\\/g, '/').toLowerCase();

  // Invalid-target tests must still reach the tool's staging-root rejection without
  // creating host metadata outside the isolated chat stage.
  if (!normalizedStagedRoot.endsWith('/agent-workspace/.tagma')) {
    return attemptId;
  }

  const yamlHash = createHash('sha1').update(readFileSync(yamlPath, 'utf8')).digest('hex');
  writeFileSync(
    join(dirname(dirname(stagedTagmaDir)), 'stage.json'),
    JSON.stringify({
      trialPlanAttempt: {
        relativePath: relative(stagedTagmaDir, yamlPath).replace(/\\/g, '/'),
        yamlHash,
        attemptId,
      },
    }),
    'utf8',
  );
  return attemptId;
}

async function loadGeneratedTrialPlanTool(): Promise<{
  tool: GeneratedTrialPlanTool;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-generated-trial-tool-'));
  const path = join(dir, 'tagma_trial_plan.ts');
  writeFileSync(path, buildTagmaTrialPlanTool(), 'utf8');
  const loaded = (await import(`${pathToFileURL(path).href}?test=${Date.now()}`)) as {
    default: GeneratedTrialPlanTool;
  };
  return {
    tool: loaded.default,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTrialPlanStage(): {
  root: string;
  liveTagmaDir: string;
  agentTagmaDir: string;
  yamlPath: string;
  planPath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-tool-stage-'));
  const liveTagmaDir = join(root, '.tagma');
  const agentTagmaDir = join(
    liveTagmaDir,
    '.chat-staging',
    '12345678-1234-1234-1234-123456789abc',
    'agent-workspace',
    '.tagma',
  );
  const pipelineDir = join(agentTagmaDir, 'sample');
  mkdirSync(pipelineDir, { recursive: true });
  const yamlPath = join(pipelineDir, 'sample.yaml');
  writeFileSync(
    yamlPath,
    ['pipeline:', '  name: Sample', '  tracks:', '    - id: main', '      tasks: []', ''].join(
      '\n',
    ),
    'utf8',
  );
  return {
    root,
    liveTagmaDir,
    agentTagmaDir,
    yamlPath,
    planPath: join(pipelineDir, 'sample.trial-plan.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function completeTrialPlanToolArgs(pipelinePath: string): Record<string, unknown> {
  const caseId = 'all-file-boundaries';
  const coverageDimensions = [
    'multiple-inputs',
    'duplicate-input-names',
    'multiline-content',
    'inter-task-output-collision',
    'repeat-run-output-collision',
    'concurrent-run-output-collision',
    'repeat-run',
    'empty-content',
    'special-characters',
  ];
  return {
    pipeline_path: pipelinePath,
    summary: 'Exercise observable file-processing boundaries.',
    goals: ['Preserve every logical input and its complete content.'],
    coverage: coverageDimensions.map((dimension) =>
      dimension === 'concurrent-run-output-collision'
        ? {
            dimension,
            status: 'accepted-risk',
            caseIds: [],
            rationale: 'The sequential harness cannot exercise concurrent writers.',
          }
        : {
            dimension,
            status: 'covered',
            caseIds: [caseId],
            rationale: 'Covered by isolated fixtures and host assertions.',
          },
    ),
    findings: [],
    cases: [
      {
        id: caseId,
        title: 'All file boundaries',
        objective: 'Keep duplicate names distinct across repeated runs.',
        runs: 2,
        targetTaskIds: ['main.process', 'main.publish'],
        fixtures: [
          {
            path: 'inputs/a/report.txt',
            content: ['first', '', 'second [x] \\u4e2d\\u6587'].join('\n'),
          },
          {
            path: 'inputs/b/report.txt',
            content: ['other', '', 'later'].join('\n'),
          },
          { path: 'inputs/c/empty.txt', content: '' },
        ],
        expectations: [
          {
            type: 'directory-entry-count',
            path: 'outputs',
            suffix: '.txt',
            min: 3,
            max: 3,
          },
          {
            type: 'file-equals',
            path: 'outputs/a-report.txt',
            text: ['first', '', 'second [x] \\u4e2d\\u6587'].join('\n'),
          },
          {
            type: 'file-equals',
            path: 'outputs/b-report.txt',
            text: ['other', '', 'later'].join('\n'),
          },
          { type: 'file-equals', path: 'outputs/c-empty.txt', text: '' },
          { type: 'task-status', taskId: 'main.process', status: 'success' },
        ],
      },
    ],
  };
}

async function submitTrialPlanToolArgs(
  generated: GeneratedTrialPlanTool,
  args: Record<string, unknown>,
  context: { directory: string },
): Promise<string> {
  const pipelinePath = args.pipeline_path as string;
  const attemptId = issueGeneratedTrialPlanAttempt(pipelinePath, context);
  await generated.execute(
    {
      operation: 'begin',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      summary: args.summary,
      goals: args.goals,
    },
    context,
  );
  for (const testCase of args.cases as Array<Record<string, unknown>>) {
    await generated.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: pipelinePath,
        case: testCase,
      },
      context,
    );
  }
  await generated.execute(
    {
      operation: 'set-coverage',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      coverage: args.coverage,
    },
    context,
  );
  await generated.execute(
    {
      operation: 'set-findings',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      findings: args.findings ?? [],
    },
    context,
  );
  return generated.execute(
    {
      operation: 'commit',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
    },
    context,
  );
}

test('tagma-router delegates history comparisons without read/edit powers', () => {
  const doc = buildTagmaRouterAgent();

  expect(doc).toContain('mode: primary');
  expect(doc).toContain('history_comparison');
  expect(doc).toContain('tagma-history-compare');
  expect(doc).toContain('stateless');
  expect(doc).toContain('<history-version-compare>');
  expect(doc).toContain('pipeline_work');
  expect(doc).toContain('pipeline_diagnosis');
  expect(doc).toContain('general_discussion');
  expect(doc).toContain('tagma-pipeline');
  expect(doc).toContain('tagma-pipeline-diagnosis');
  expect(doc).toContain('tagma-general-discussion');
  // Create/edit are merged, so the router must not know those agents anymore.
  expect(doc).not.toContain('tagma-pipeline-create');
  expect(doc).not.toContain('tagma-pipeline-edit');
  expect(doc).not.toContain('create_pipeline');
  expect(doc).not.toContain('modify_pipeline');
  expect(doc).toContain('ROUTE_MISMATCH');
  expect(doc).toContain('at most 2 prior routed outcomes');
  expect(doc).toContain('<workspace-yaml-folders>');
  expect(doc).toContain('Do not include YAML schema guidance unless the question asks for it');
  expect(doc).toContain('general_direct_answer');
  expect(doc).toContain('answer directly before delegation');
  expect(doc).toContain('targeted_trial_planning');
  expect(doc).toContain('tagma-trial-planner');
  expect(doc).toContain('Host `<tagma-internal>` targeted Trial Plan');
  expect(doc).toContain('same staged path and YAML hash');
  expect(doc).toContain('resume the prior planner task');
  expect(doc).toContain('tagma_trial_plan: false');
  expect(doc).toContain('tagma_trial_plan: deny');
  expect(doc).toContain('Never forward raw full transcript excerpts');
  expect(doc).toContain('read: deny');
  expect(doc).toContain('edit: deny');
});

test('tagma-router separates concrete read-only diagnosis from authorized pipeline mutation', () => {
  const doc = buildTagmaRouterAgent();

  expect(doc).toContain(
    '`pipeline_work` -> `tagma-pipeline`: the user explicitly asks to create, change, edit, apply, implement, rename, extend, delete, or fix pipeline files',
  );
  expect(doc).toContain(
    '`pipeline_diagnosis` -> `tagma-pipeline-diagnosis`: inspect, debug, explain, or answer why/how questions about a concrete pipeline',
  );
  expect(doc).toContain('with no explicit request to change files');
  expect(doc).toContain('Debug, explain, review, and "how can I fix this?" do not authorize edits');
  expect(doc).toContain(
    'A conceptual question about Tagma product behavior with no concrete artifact to inspect is `general_discussion`',
  );
});

test('tagma-router preserves host reconciliation evidence for Copy and finalize diagnosis', () => {
  const doc = buildTagmaRouterAgent();

  expect(doc).toContain('<previous-chat-yaml-reconcile>');
  expect(doc).toContain('Copy or finalize/reconcile outcome');
  expect(doc).toContain('pass the complete block unchanged');
  expect(doc).toContain('pipeline_diagnosis');
});

test('tagma-pipeline-diagnosis is read-only but can inspect pipeline artifacts and compile logs', () => {
  const doc = buildTagmaPipelineDiagnosisAgent();

  expect(doc).toContain('name: tagma-pipeline-diagnosis');
  expect(doc).toContain('mode: subagent');
  expect(doc).toContain('hidden: true');
  expect(doc).toContain('read: allow');
  expect(doc).toContain('glob: allow');
  expect(doc).toContain('grep: allow');
  expect(doc).toContain('list: allow');
  expect(doc).toContain('edit: deny');
  expect(doc).toContain('bash: deny');
  expect(doc).toContain('webfetch: deny');
  expect(doc).toContain('websearch: deny');
  expect(doc).toContain('explore: "allow"');
  expect(doc).toContain('scout: "allow"');
  expect(doc).toContain('tagma-yaml-contract: "allow"');
  expect(doc).toContain('tagma-native-primitives: "allow"');
  expect(doc).toContain('YAML, manifest, layout, requirements, and `.compile.log`');
  expect(doc).toContain('<previous-chat-yaml-reconcile>');
  expect(doc).toContain('ROUTE_MISMATCH: pipeline_work');
  expect(doc).not.toContain('tagma_yaml_skeleton: allow');
  expect(doc).not.toContain('tagma_placement_plan: allow');
});

test('router prompt stays compact with the read-only diagnosis lane', () => {
  // Keep classification overhead bounded even after adding the diagnosis lane.
  expect(buildTagmaRouterAgent().length).toBeLessThan(4000);
});

test('router keeps one bounded implementation handoff before result synthesis', () => {
  const doc = buildTagmaRouterAgent();

  expect(doc).toContain('Never delegate preliminary inspection or workspace discovery');
  expect(doc).toContain('one specialist call owns both lookup and implementation');
  expect(doc).toContain('Do not add implementation choices that the user did not provide');
  expect(doc).toContain('Empty `<task_result>`');
  expect(doc).toContain('resume `task_id` once');
  expect(doc).toContain('if again empty, report no usable result and stop');
  expect(doc).toContain('`pipeline_work`: relay');
  expect(doc).toContain('authoring complete; host verification pending');
  expect(doc).toContain('compilation cannot mean built, ready, successful, or verified');
});

test('tagma-pipeline agent stays compact and keeps schema detail out of the base prompt', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc.length).toBeLessThan(18_000);
  expect(doc).toContain('Keep context small');
  expect(doc).toContain('schema source of truth');
  expect(doc).toContain('YAML Contract Quick Reference');
  expect(doc).toContain('## Final Result Contract');
  expect(doc).toContain('Your final response must be non-empty');
  expect(doc).not.toContain('### 12. Typed task bindings');
  expect(doc).not.toContain('#### Port types and coercion');
});

test('routine pipeline authoring stays in one worker model without nested task fanout', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('task: false');
  expect(doc).toContain('Author YAML, layout, requirements, and host-native helper files directly');
  expect(doc).toContain(
    'Do not call the task tool for planning, command evidence, safety, or review',
  );
  expect(doc).toContain('make the smallest safe, reversible implementation choice');
  expect(doc).not.toContain('## Subagent Dispatch');
  expect(doc).not.toContain('## Manifest Step Implementation Protocol');
  expect(doc).not.toContain('## Review Agent Loop');
});

test('merged tagma-pipeline agent is a hidden subagent handling create + edit', () => {
  const pipeline = buildTagmaPipelineAgent('Windows');
  const diagnosis = buildTagmaPipelineDiagnosisAgent();
  const general = buildTagmaGeneralDiscussionAgent();
  const history = buildTagmaHistoryCompareAgent();

  expect(pipeline).toContain('name: tagma-pipeline');
  expect(pipeline).toContain('mode: subagent');
  expect(pipeline).toContain('hidden: true');
  // No routed-specialization split anymore: one worker, two modes.
  expect(pipeline).not.toContain('Routed specialization');
  expect(pipeline).not.toContain('ROUTE_MISMATCH: modify_pipeline');
  expect(pipeline).not.toContain('ROUTE_MISMATCH: create_pipeline');

  expect(diagnosis).toContain('name: tagma-pipeline-diagnosis');
  expect(diagnosis).toContain('without changing files');

  expect(general).toContain('mode: subagent');
  expect(general).toContain('hidden: true');
  expect(general).toContain('without editing files');
  expect(general).toContain('ROUTE_MISMATCH: pipeline_work');
  expect(general).not.toContain('ROUTE_MISMATCH: create_pipeline');
  expect(general).not.toContain('ROUTE_MISMATCH: modify_pipeline');

  expect(history).toContain('name: tagma-history-compare');
  expect(history).toContain('mode: subagent');
  expect(history).toContain('hidden: true');
  expect(history).toContain('stateless');
  expect(history).toContain('ROUTE_MISMATCH: pipeline_work');
});

test('tagma-pipeline requires explicit mutation authorization before any write', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('## Mutation Authorization Gate');
  expect(doc).toContain('The latest user text must explicitly request a file change');
  expect(doc).toContain('Debug, inspect, explain, review, and why/how questions are read-only');
  expect(doc).toContain('do not write, create, rename, or delete anything');
  expect(doc).toContain('ROUTE_MISMATCH: pipeline_diagnosis');
  expect(doc).toContain(
    'include a concise read-only answer when the available evidence supports one',
  );
});

test('tagma-pipeline agent documents edit/create modes and mandatory compile loop', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('## Modes');
  expect(doc).toContain('Fill current manual-New draft');
  expect(doc).toContain('Edit current');
  expect(doc).toContain('Create new');
  expect(doc).toContain('## Manifest-Guided YAML Edits');
  expect(doc).toContain(
    'Read the same-folder `<stem>.manifest.json` before reading or editing YAML',
  );
  expect(doc).toContain('preserve every unselected section');
  expect(doc).toContain('For **create new**, write the manifest');
  expect(doc).toContain('Bypass the manifest only when it is missing, unreadable, stale');
  expect(doc).toContain('compile.log');
  expect(doc).toContain('Never finish after a YAML write');
  expect(doc).toContain('success: true');
  expect(doc).toContain('Settings -> Secrets Manager');
  expect(doc).toContain('Never ask for or store secret values');
  expect(doc).toContain('never edit `.env`');
  expect(doc).toContain('never call secret-manager APIs');
});

test('tagma-pipeline agent cooperates with optional host trial-run repair before the logical turn ends', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain(
    'Host runs bounded Sandbox cases before release only after explicit opt-in in Editor Settings',
  );
  expect(doc).toContain('real-workspace Live Smoke Test only under separate consent');
  expect(doc).toContain('trial-run failure evidence');
  expect(doc).toContain('same authorized logical turn');
  expect(doc).toContain('Never remove or weaken a manual approval');
  expect(doc).toContain('Never claim either mode passed without host evidence');
  expect(doc).toContain('Relative trigger paths resolve from the real workspace root');
  expect(doc).toContain(
    'staged pipeline support file does not satisfy the optional Live Smoke baseline',
  );
  expect(doc).toContain('missing file or directory input is fixture-backed for host Trial');
  expect(doc).toContain('Host verification starts automatically after your response');
  expect(doc).toContain('Do not ask whether the user wants the host to verify or compile');
  expect(doc).toContain('authoring complete; host verification pending');
  expect(doc).toContain('distinguish missing or malformed artifacts from valid empty collections');
});

test('dedicated hidden tagma-trial-planner owns targeted Trial Plan authoring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-trial-planner-agent-'));
  try {
    seedOpencodeArtifacts(dir);
    const planner = readFileSync(
      join(dir, '.opencode', 'agents', 'tagma-trial-planner.md'),
      'utf8',
    );
    const pipeline = buildTagmaPipelineAgent('Windows');

    expect(planner).toContain('name: tagma-trial-planner');
    expect(planner).toContain('mode: subagent');
    expect(planner).toContain('hidden: true');
    expect(planner).toContain('read: true');
    expect(planner).toContain('glob: true');
    expect(planner).toContain('grep: true');
    expect(planner).toContain('list: true');
    expect(planner).toContain('edit: false');
    expect(planner).toContain('bash: false');
    expect(planner).toContain('task: false');
    expect(planner).toContain('tagma_yaml_skeleton: false');
    expect(planner).toContain('tagma_placement_plan: false');
    expect(planner).toContain('tagma_trial_plan: true');
    expect(planner).toContain('tagma_trial_plan: allow');
    expect(planner).toContain('then `commit` exactly once');
    expect(planner).toContain(
      'The begin operation requires a non-empty summary and a non-empty string-array goals',
    );
    expect(planner).toContain(
      'Every coverage entry must include `dimension`, `status`, `caseIds`, and `rationale`',
    );
    expect(planner).toContain(
      'status must be `covered`, `accepted-risk`, `blocked`, or `not-applicable`',
    );
    expect(planner).toContain(
      'Every finding must include `severity`, `repairScope`, `summary`, and `evidence`',
    );
    expect(planner).toContain('resubmit both fields when resuming a matching draft');
    expect(planner).toContain('Never submit the whole plan or multiple cases in one call');
    expect(planner).toContain(
      'configured finite commit budget for each exact staged path and YAML hash',
    );
    expect(planner).toContain('subsequent same-key request resumes this planner task');
    expect(planner).not.toContain('two-call budget');
    expect(planner).not.toContain('Never attempt a third same-key call');
    expect(planner).not.toContain('the one remaining attempt');
    expect(planner).toContain('## Trial Plan Contract And Edge Cases');
    expect(planner).toContain('duplicate input names');
    expect(planner).toContain('output collisions');
    expect(planner).toContain('fixed single-input surface is not-applicable');
    expect(planner).toContain('multi-paragraph');
    expect(planner).toContain('empty content');
    expect(planner).toContain('special characters');
    expect(planner).toContain('repeated runs');
    expect(planner).toContain('Identify every terminal task');
    expect(planner).toContain('full dependency closure');
    expect(planner).toContain('Sandbox Trial only after explicit opt-in');
    expect(planner).toContain(
      'temporary workspace copies, closed stdin, no TTY, and synthetic secrets',
    );
    expect(planner).toContain('app-level containment, not an OS permission sandbox');
    expect(planner).toContain('Live Smoke Test runs only under separate consent');
    expect(planner).toContain(
      'The host grants Trial-only execution to manual tasks in that explicit target closure',
    );
    expect(planner).toContain('blocking diagnostic-only finding');
    expect(planner).toContain(
      'Never use accepted-risk or a warning to turn an unexecuted terminal task into a passing Trial',
    );
    expect(planner).toContain('Use file-equals when exact text preservation matters');
    expect(planner).toContain('an empty expected string for empty-content cases');
    expect(planner).toContain('Every .json artifact checked');
    expect(planner).toContain('Text matches alone cannot prove valid JSON');
    expect(planner).toContain('serialized JSON value');
    expect(planner).toContain('must remain RFC 8259 JSON');
    expect(planner).toContain('Pass the exact staged YAML path');

    expect(pipeline).toContain('tagma_trial_plan: false');
    expect(pipeline).toContain('tagma_trial_plan: deny');
    expect(pipeline).toContain('Once final compile succeeds, call no more tools');
    expect(pipeline).toContain('Host enters a dedicated planning phase when Trial is enabled');
    expect(pipeline).not.toContain('tagma_trial_plan: true');
    expect(pipeline).not.toContain('tagma_trial_plan: allow');
    expect(pipeline).not.toContain(
      'Call `tagma_trial_plan` only after the final YAML compile succeeds',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tagma-pipeline agent treats explicit creation as higher priority than existing name matches', () => {
  const router = buildTagmaRouterAgent();
  const pipeline = buildTagmaPipelineAgent('Windows');

  expect(router).toContain('preserve `<requested-action kind="create-new-pipeline">`');
  expect(router).toContain('do not rewrite a create/new pipeline request into an edit target');
  expect(router).toContain('<requested-action kind="fill-manual-new-pipeline">');

  expect(pipeline).toContain('fill the manual New draft at `<current-file>`');
  expect(pipeline).toContain(
    'edit `<current-file>` in place even if the user used create/new wording',
  );
  expect(pipeline).toContain('Creation intent has priority over existing pipeline matches');
  expect(pipeline).toContain(
    'Existing `<workspace-yaml-folders>` entries are collision context, not edit targets',
  );
  expect(pipeline).toContain('If the desired stem already exists, choose a fresh unused stem');
  expect(pipeline).toContain(
    'Do not patch, rename, or overwrite a listed existing YAML while satisfying a create-new request',
  );
  expect(pipeline).toContain('call `tagma_yaml_skeleton`');
  expect(pipeline).toContain('write the returned YAML text');
});

test('tagma-pipeline applies Chat AI defaults only while creating a new pipeline', () => {
  const doc = buildTagmaPipelineAgent('Windows');
  const router = buildTagmaRouterAgent();

  expect(doc).toContain('## New-Pipeline Prompt Defaults');
  expect(doc).toContain('<requested-action kind="create-new-pipeline">');
  expect(doc).toContain('<requested-action kind="fill-manual-new-pipeline">');
  expect(doc).toContain('An explicit user CLI/driver choice wins');
  expect(doc).toContain('Otherwise use the built-in `opencode` driver');
  expect(doc).toContain('An explicit user provider/model choice wins');
  expect(doc).toContain('persist `model: <provider-id>/<model-id>`');
  expect(doc).toContain('Never copy the OpenCode Chat model to a non-`opencode` driver');
  expect(doc).toContain('Do not apply these defaults while editing an existing pipeline');
  expect(router).toContain(
    'preserve `<opencode-chat-model provider-id="..." model-id="..." />` unchanged',
  );
});

test('tagma-pipeline agent keeps manifest-first flow while enforcing section isolation', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('Create new (manifest-first)');
  expect(doc).toContain('tagma_yaml_skeleton');
  expect(doc).not.toContain('POST /api/create-from-manifest');
  expect(doc).toContain('## Section Isolation Protocol');
  expect(doc).toContain('Treat each manifest section as the editing unit');
  expect(doc).toContain('Before changing YAML, name the affected section ids');
  expect(doc).toContain('Do not reorder, reformat, rename, or optimize unselected sections');
  expect(doc).toContain('For local implementation edits, patch only the selected task or track');
  expect(doc).toContain(
    'Topology changes may touch only the selected section ids and their explicit dependents',
  );
  expect(doc).not.toContain('tagma_read_block');
  expect(doc).not.toContain('tagma_upsert_block');
  expect(doc).not.toContain('tagma_create_skeleton');
  expect(doc).not.toContain('tagma_delete_block');
});

test('tagma-pipeline agent honors protected current pipeline context', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('<pipeline-availability>');
  expect(doc).toContain('<workspace-yaml-folders>');
  expect(doc).toContain('concrete `<yaml>`, and same-folder `<manifest>`');
  expect(doc).toContain("edit that entry's `<yaml>` file even if it is not `<current-file>`");
  expect(doc).toContain('Never call `read` with only `{ "limit": ... }`');
  expect(doc).toContain('read({ "filePath": "pipeline-9giapbf6.yaml" })');
  expect(doc).toContain('resolve the target `<pipeline>` entry from the user');
  expect(doc).toContain('protected="true"');
  expect(doc).toContain('active run');
  expect(doc).toContain('current pipeline is running');
  expect(doc).toContain('Do not edit `<current-file>`');
  expect(doc).toContain('create a new pipeline');
  expect(doc).toContain('edit a different existing pipeline');
  expect(doc).toContain('unrestricted');
});

test('tagma-pipeline agent allows workspace reads while restricting writes to .tagma', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('Read / Write Boundary');
  expect(doc).toContain('You may read under the workspace root');
  expect(doc).toContain('only paths that resolve inside `<workspace>/.tagma/`');
  expect(doc).toContain('Never guess unrelated project scripts');
  expect(doc).toContain('Strip a leading `.tagma/`');
});

test('tagma-pipeline agent treats chat staging as the only writable pipeline root', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('it is the authoritative write boundary');
  expect(doc).toContain('only under its `<agent-root>`');
  expect(doc).toContain('live pipeline folders outside `<agent-root>` are read-only');
  expect(doc).toContain('Never translate them back');
  expect(doc).toContain('your cwd is exactly `<agent-root>`');
  expect(doc).toContain('paths are already relative to it');
});

test('tagma-pipeline agent allows external file and directory trigger watch paths', () => {
  const pipelineDoc = buildTagmaPipelineAgent('Windows');
  const triggerSkill = buildTagmaTriggerStrategySkill();
  const contractSkill = buildTagmaYamlContractSkill();

  expect(pipelineDoc).toContain('file/directory trigger watch paths may be absolute');
  expect(pipelineDoc).toContain('authoring the reference is allowed');
  expect(pipelineDoc).toContain('without reading or writing that external path');
  expect(triggerSkill).toContain('file/directory trigger watch paths may be absolute');
  expect(contractSkill).toContain('file/directory trigger watch paths may be absolute');
});

test('tagma-yaml-contract requires one direct producer for each unresolved binding', () => {
  const contractSkill = buildTagmaYamlContractSkill();

  expect(contractSkill).toContain(
    'Every required input without a `value` or `default` must resolve from exactly one direct dependency.',
  );
  expect(contractSkill).toContain('A transitive ancestor does not count.');
  expect(contractSkill).toContain(
    'Ambiguity blocks even when the input is optional or declares a `default`.',
  );
  expect(contractSkill).toContain(
    'A required task-specific `from` without a `default` must name an output that dependency can produce.',
  );
});

test('tagma-pipeline agent exposes direct tools and focused skills without advisor fanout', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('task: false');
  expect(doc).toContain('skill: true');
  expect(doc).toContain('webfetch: true');
  expect(doc).toContain('webfetch: allow');
  expect(doc).toContain('websearch: allow');
  expect(doc).toContain('tagma_yaml_skeleton: true');
  expect(doc).toContain('tagma_yaml_skeleton: allow');
  expect(doc).toContain('tagma_placement_plan: true');
  expect(doc).toContain('tagma_placement_plan: allow');
  expect(doc).toContain('tagma-python-tools: "deny"');
  expect(doc).toContain('tagma-yaml-contract: "allow"');
  expect(doc).toContain('do not front-load the full schema for a routine create');
  expect(doc).toContain('tagma-native-primitives: "allow"');
  expect(doc).toContain('tagma-trigger-strategy: "allow"');
  expect(doc).toContain('## Single-Worker Authoring');
  expect(doc).not.toContain('tagma-pipeline-planner: "allow"');
  expect(doc).not.toContain('tagma-command-evidence: "allow"');
  expect(doc).not.toContain('tagma-runtime-guard: "allow"');
  expect(doc).not.toContain('tagma-context-packager: "allow"');
  expect(doc).not.toContain('tagma-yaml-review: "allow"');
  expect(doc).not.toContain('tagma-pipeline-section-builder: "allow"');
});

test('specialized Tagma advisor subagents are hidden, read-only, and task-focused', () => {
  const planner = buildTagmaPipelinePlannerAgent();
  const commands = buildTagmaCommandEvidenceAgent();
  const runtime = buildTagmaRuntimeGuardAgent();
  const context = buildTagmaContextPackagerAgent();

  for (const doc of [planner, commands, runtime, context]) {
    expect(doc).toContain('mode: subagent');
    expect(doc).toContain('hidden: true');
    expect(doc).toContain('read: allow');
    expect(doc).toContain('glob: allow');
    expect(doc).toContain('grep: allow');
    expect(doc).toContain('list: allow');
    expect(doc).toContain('edit: deny');
    expect(doc).toContain('bash: deny');
    expect(doc).toContain('task:');
    expect(doc).toContain('"*": "deny"');
    expect(doc).toContain('Return advice only');
  }

  expect(planner).toContain('name: tagma-pipeline-planner');
  expect(planner).toContain('task graph');
  expect(planner).toContain('track/persona boundaries');
  expect(planner).toContain('parallel workstreams');

  expect(commands).toContain('name: tagma-command-evidence');
  expect(commands).toContain('package scripts');
  expect(commands).toContain('Never invent commands');
  expect(commands).toContain('grounded_command');

  expect(runtime).toContain('name: tagma-runtime-guard');
  expect(runtime).toContain('triggers');
  expect(runtime).toContain('secrets');
  expect(runtime).toContain('destructive');
  expect(runtime).toContain('manual approval');

  expect(context).toContain('name: tagma-context-packager');
  expect(context).toContain('static_context');
  expect(context).toContain('large logs');
  expect(context).toContain('compact handoff');
  expect(context).toContain('memory');
});

test('tagma-pipeline agent self-reviews once without another model turn', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('## Self-Review');
  expect(doc).toContain('Fix actionable findings directly; do not delegate review');
  expect(doc).not.toContain('tagma-yaml-review: "allow"');
  expect(doc).not.toContain('## Review Agent Loop');
});

test('tagma-pipeline agent authors manifest sections directly', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('fill all selected sections yourself');
  expect(doc).toContain('patch only selected sections plus forced dependents');
  expect(doc).not.toContain('tagma-pipeline-section-builder: "allow"');
  expect(doc).not.toContain('## Manifest Step Implementation Protocol');
});

test('tagma-pipeline-section-builder is a write-capable bounded implementer, not a reviewer', () => {
  const doc = buildTagmaPipelineSectionBuilderAgent('Windows');

  expect(doc).toContain('name: tagma-pipeline-section-builder');
  expect(doc).toContain('mode: subagent');
  expect(doc).toContain('hidden: true');
  expect(doc).toContain('edit: allow');
  expect(doc).toContain('bash: deny');
  expect(doc).toContain('"*": "deny"');
  expect(doc).toContain('Implement exactly one manifest section');
  expect(doc).toContain('Do not review or approve your own work');
  expect(doc).toContain('STEP_RESULT');
});

test('tagma-pipeline agent delegates mechanical layout to the placement tool', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('## Layout');
  expect(doc).toContain('Do not hand-calculate positions');
  expect(doc).toContain('call `tagma_placement_plan`');
  expect(doc).not.toContain('Rules of thumb for a good initial layout');
  expect(doc).not.toContain('Worked example');
});

test('placement tool is generated as an OpenCode custom tool module', () => {
  const doc = buildTagmaPlacementTool();

  expect(doc).toContain('import { tool } from "@opencode-ai/plugin"');
  expect(doc).toContain('export default tool');
  expect(doc).toContain('tracks: tool.schema');
  expect(doc).toContain('computePlacement(args)');
});

test('trial-plan tool binds structured edge cases to the final YAML hash', () => {
  const doc = buildTagmaTrialPlanTool();

  expect(doc).toContain('createHash, randomUUID');
  expect(doc).toContain('export default tool');
  expect(doc).toContain('operation: tool.schema.enum(DRAFT_OPERATIONS)');
  expect(doc).toContain('pipeline_path: tool.schema');
  expect(doc).toContain('reset: tool.schema');
  expect(doc).toContain('case: caseSchema.optional()');
  expect(doc).toContain('Exact staged Target YAML path');
  expect(doc).toContain('duplicate-input-names');
  expect(doc).toContain('multiline-content');
  expect(doc).toContain('inter-task-output-collision');
  expect(doc).toContain('repeat-run-output-collision');
  expect(doc).toContain('concurrent-run-output-collision');
  expect(doc).toContain('accepted-risk');
  expect(doc).toContain('repeat-run');
  expect(doc).toContain('.trial-plan.json');
  expect(doc).toContain('yamlHash');
  expect(doc).toContain('tool.schema.discriminatedUnion("type"');
  expect(doc).toContain('type: tool.schema.literal("file-contains")');
  expect(doc).toContain('type: tool.schema.literal("json-valid")');
  expect(doc).toContain('type: tool.schema.literal("json-pointer-equals")');
  expect(doc).toContain('type: tool.schema.literal("task-status")');
  expect(doc).toContain('dimension: tool.schema.enum(REQUIRED_COVERAGE)');
  expect(doc).toContain('severity: tool.schema.enum(FINDING_SEVERITIES)');
  expect(doc).toContain('assertValidPlan(plan)');
  expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(doc)).not.toThrow();
});

test('trial-plan tool assembles a large plan in bounded draft calls before one commit', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const plan = completeTrialPlanToolArgs('sample/sample.yaml');
    const template = (plan.cases as Array<Record<string, unknown>>)[0]!;
    const cases = Array.from({ length: 7 }, (_, index) => ({
      ...template,
      id: `file-boundaries-${index + 1}`,
      title: `File boundaries ${index + 1}`,
    }));
    const coverage = (plan.coverage as Array<Record<string, unknown>>).map((entry) => ({
      ...entry,
      caseIds: entry.status === 'covered' ? ['file-boundaries-1'] : (entry.caseIds as string[]),
    }));
    const attemptId = issueGeneratedTrialPlanAttempt('sample/sample.yaml', {
      directory: stage.agentTagmaDir,
    });

    await generated.tool.execute(
      {
        operation: 'begin',
        attempt_id: attemptId,
        pipeline_path: 'sample/sample.yaml',
        summary: plan.summary,
        goals: plan.goals,
      },
      { directory: stage.agentTagmaDir },
    );
    for (const testCase of cases.slice(0, 3)) {
      await generated.tool.execute(
        {
          operation: 'upsert-case',
          attempt_id: attemptId,
          pipeline_path: 'sample/sample.yaml',
          case: testCase,
        },
        { directory: stage.agentTagmaDir },
      );
    }
    const interruptedCall = JSON.stringify({
      operation: 'upsert-case',
      attempt_id: attemptId,
      pipeline_path: 'sample/sample.yaml',
      case: cases[3],
    });
    expect(() => JSON.parse(interruptedCall.slice(0, interruptedCall.lastIndexOf('"')))).toThrow(
      'JSON Parse error: Unterminated string',
    );
    expect(existsSync(stage.planPath)).toBe(false);
    expect(readChatPipelineTrialPlanToolTelemetry(stage.yamlPath)).toMatchObject({
      toolAttemptCount: 0,
      successfulWriteCount: 0,
    });
    const resumedDraft = JSON.parse(
      await generated.tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: 'sample/sample.yaml',
          summary: plan.summary,
          goals: plan.goals,
        },
        { directory: stage.agentTagmaDir },
      ),
    ) as { cases: number };
    expect(resumedDraft.cases).toBe(3);

    for (const testCase of cases.slice(3)) {
      await generated.tool.execute(
        {
          operation: 'upsert-case',
          attempt_id: attemptId,
          pipeline_path: 'sample/sample.yaml',
          case: testCase,
        },
        { directory: stage.agentTagmaDir },
      );
    }
    await generated.tool.execute(
      {
        operation: 'set-coverage',
        attempt_id: attemptId,
        pipeline_path: 'sample/sample.yaml',
        coverage,
      },
      { directory: stage.agentTagmaDir },
    );
    await generated.tool.execute(
      {
        operation: 'set-findings',
        attempt_id: attemptId,
        pipeline_path: 'sample/sample.yaml',
        findings: plan.findings,
      },
      { directory: stage.agentTagmaDir },
    );

    expect(existsSync(stage.planPath)).toBe(false);
    expect(readChatPipelineTrialPlanToolTelemetry(stage.yamlPath)).toMatchObject({
      toolAttemptCount: 0,
      successfulWriteCount: 0,
    });

    const result = JSON.parse(
      await generated.tool.execute(
        { operation: 'commit', attempt_id: attemptId, pipeline_path: 'sample/sample.yaml' },
        { directory: stage.agentTagmaDir },
      ),
    ) as { path: string; yamlHash: string };

    expect(result.path).toBe('sample/sample.trial-plan.json');
    expect(
      parseChatPipelineTrialPlan(JSON.parse(readFileSync(stage.planPath, 'utf8'))).cases,
    ).toHaveLength(7);
    expect(readChatPipelineTrialPlanToolTelemetry(stage.yamlPath)).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
    });
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan begin resumes the same revision unless reset is explicit', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const plan = completeTrialPlanToolArgs('sample/sample.yaml');
    const context = { directory: stage.agentTagmaDir };
    const attemptId = issueGeneratedTrialPlanAttempt('sample/sample.yaml', context);
    const beginArgs = {
      operation: 'begin',
      attempt_id: attemptId,
      pipeline_path: 'sample/sample.yaml',
      summary: plan.summary,
      goals: plan.goals,
    };
    await generated.tool.execute(beginArgs, context);
    await generated.tool.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: 'sample/sample.yaml',
        case: (plan.cases as Array<Record<string, unknown>>)[0],
      },
      context,
    );

    expect(JSON.parse(await generated.tool.execute(beginArgs, context))).toMatchObject({
      operation: 'begin',
      cases: 1,
    });
    expect(
      JSON.parse(await generated.tool.execute({ ...beginArgs, reset: true }, context)),
    ).toMatchObject({ operation: 'begin', cases: 0 });
    expect(existsSync(stage.planPath)).toBe(false);
    expect(readChatPipelineTrialPlanToolTelemetry(stage.yamlPath)).toMatchObject({
      toolAttemptCount: 0,
      successfulWriteCount: 0,
    });
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool rejects host-invalid plans before writing any file', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const args = completeTrialPlanToolArgs('sample/sample.yaml');
    const firstExpectation = (args.cases as Array<{ expectations: Array<{ type: string }> }>)[0]!
      .expectations[0]!;
    firstExpectation.type = 'text_contains';

    await expect(
      submitTrialPlanToolArgs(generated.tool, args, { directory: stage.agentTagmaDir }),
    ).rejects.toThrow('expectations[0].type is unsupported');
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool rejects text-only checks for JSON artifacts', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const args = completeTrialPlanToolArgs('sample/sample.yaml');
    (
      args.cases as Array<{
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!.expectations.push({
      type: 'file-contains',
      path: 'outputs/result.json',
      text: 'expected marker',
    });

    await expect(
      submitTrialPlanToolArgs(generated.tool, args, { directory: stage.agentTagmaDir }),
    ).rejects.toThrow(
      'JSON artifact outputs/result.json requires a json-valid or json-pointer-equals expectation',
    );
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool rejects checks against staged YAML and companion files', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const args = completeTrialPlanToolArgs('sample/sample.yaml');
    (
      args.cases as Array<{
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!.expectations.push({
      type: 'file-contains',
      path: 'sample/sample.compile.log',
      text: 'success: true',
    });

    await expect(
      submitTrialPlanToolArgs(generated.tool, args, { directory: stage.agentTagmaDir }),
    ).rejects.toThrow('must target case fixtures or outputs, not staged pipeline artifacts');
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool requires every case to include non-empty target task ids before writing', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const missingTargetsArgs = completeTrialPlanToolArgs('sample/sample.yaml');
    delete (missingTargetsArgs.cases as Array<Record<string, unknown>>)[0]!.targetTaskIds;
    await expect(
      submitTrialPlanToolArgs(generated.tool, missingTargetsArgs, {
        directory: stage.agentTagmaDir,
      }),
    ).rejects.toThrow('targetTaskIds is required');
    expect(existsSync(stage.planPath)).toBe(false);

    const emptyTargetsArgs = completeTrialPlanToolArgs('sample/sample.yaml');
    (emptyTargetsArgs.cases as Array<{ targetTaskIds: string[] }>)[0]!.targetTaskIds = [];
    await expect(
      submitTrialPlanToolArgs(generated.tool, emptyTargetsArgs, {
        directory: stage.agentTagmaDir,
      }),
    ).rejects.toThrow('cases[0].targetTaskIds must contain at least one qualified track.task id.');
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool rejects semantic coverage gaps and unsupported findings before writing', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const outputCollisionArgs = completeTrialPlanToolArgs('sample/sample.yaml');
    const outputCollisionCase = (
      outputCollisionArgs.cases as Array<{
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!;
    outputCollisionCase.expectations = [
      {
        type: 'file-equals',
        path: 'outputs/single.txt',
        text: 'one',
      },
      {
        type: 'task-status',
        taskId: 'main.process',
        status: 'success',
      },
    ];
    await expect(
      submitTrialPlanToolArgs(generated.tool, outputCollisionArgs, {
        directory: stage.agentTagmaDir,
      }),
    ).rejects.toThrow(
      'coverage marks inter-task-output-collision covered without concrete linked-case evidence',
    );
    expect(existsSync(stage.planPath)).toBe(false);

    const emptyContentArgs = completeTrialPlanToolArgs('sample/sample.yaml');
    const emptyContentCase = (
      emptyContentArgs.cases as Array<{
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!;
    const emptyExpectation = emptyContentCase.expectations.find(
      (item) => item.type === 'file-equals' && item.path === 'outputs/c-empty.txt',
    );
    expect(emptyExpectation).toBeDefined();
    emptyExpectation!.text = 'unexpected content';
    await expect(
      submitTrialPlanToolArgs(generated.tool, emptyContentArgs, {
        directory: stage.agentTagmaDir,
      }),
    ).rejects.toThrow('coverage marks empty-content covered without concrete linked-case evidence');
    expect(existsSync(stage.planPath)).toBe(false);

    writeFileSync(
      stage.yamlPath,
      readFileSync(stage.yamlPath, 'utf8') + '# next semantic validation revision\n',
      'utf8',
    );

    const unsupportedFindingArgs = completeTrialPlanToolArgs('sample/sample.yaml');
    unsupportedFindingArgs.findings = [
      {
        severity: 'info',
        repairScope: 'diagnostic-only',
        summary: 'Informational only',
        evidence: 'The host contract does not support informational findings.',
      },
    ];
    await expect(
      submitTrialPlanToolArgs(generated.tool, unsupportedFindingArgs, {
        directory: stage.agentTagmaDir,
      }),
    ).rejects.toThrow('findings[0].severity is invalid');
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan coverage setter reports every unsupported covered dimension before commit', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const args = completeTrialPlanToolArgs('sample/sample.yaml');
    const testCase = (
      args.cases as Array<{
        fixtures: Array<{ path: string; content: string }>;
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!;
    testCase.fixtures.find((fixture) => fixture.path === 'inputs/c/empty.txt')!.content =
      'not empty';
    testCase.expectations = [
      { type: 'file-equals', path: 'outputs/c-empty.txt', text: '' },
      { type: 'task-status', taskId: 'main.process', status: 'success' },
    ];
    const interTaskCoverage = (args.coverage as Array<Record<string, unknown>>).find(
      (entry) => entry.dimension === 'inter-task-output-collision',
    )!;
    interTaskCoverage.status = 'accepted-risk';
    interTaskCoverage.caseIds = [];
    interTaskCoverage.rationale = 'Not part of this semantic rejection fixture.';

    await expect(
      submitTrialPlanToolArgs(generated.tool, args, { directory: stage.agentTagmaDir }),
    ).rejects.toThrow(
      /repeat-run-output-collision covered without concrete linked-case evidence[\s\S]*empty-content covered without concrete linked-case evidence/,
    );
    expect(readChatPipelineTrialPlanToolTelemetry(stage.yamlPath)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
    expect(existsSync(stage.planPath)).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool writes plans that the authoritative host parser accepts', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    const result = JSON.parse(
      await submitTrialPlanToolArgs(
        generated.tool,
        completeTrialPlanToolArgs('sample/sample.yaml'),
        {
          directory: stage.agentTagmaDir,
        },
      ),
    ) as { path: string; yamlHash: string };

    expect(result.path).toBe('sample/sample.trial-plan.json');
    const parsed = parseChatPipelineTrialPlan(JSON.parse(readFileSync(stage.planPath, 'utf8')));
    expect(parsed.yamlHash).toBe(result.yamlHash);
    expect(parsed.cases[0]).toMatchObject({
      id: 'all-file-boundaries',
      runs: 2,
      targetTaskIds: ['main.process', 'main.publish'],
    });
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool uses an exact staged target and refuses live .tagma writes', async () => {
  const generated = await loadGeneratedTrialPlanTool();
  const stage = makeTrialPlanStage();
  try {
    await submitTrialPlanToolArgs(generated.tool, completeTrialPlanToolArgs(stage.yamlPath), {
      directory: stage.liveTagmaDir,
    });
    expect(existsSync(stage.planPath)).toBe(true);

    rmSync(stage.planPath);
    await expect(
      submitTrialPlanToolArgs(generated.tool, completeTrialPlanToolArgs('sample/sample.yaml'), {
        directory: stage.liveTagmaDir,
      }),
    ).rejects.toThrow('host-owned chat staging');
    expect(existsSync(join(stage.liveTagmaDir, 'sample', 'sample.trial-plan.json'))).toBe(false);
  } finally {
    stage.cleanup();
    generated.cleanup();
  }
});

test('trial-plan tool resolves paths from the host-provided workspace root', () => {
  const doc = buildTagmaTrialPlanTool();

  expect(doc).toContain('async execute(args, context)');
  expect(doc).toContain('resolvePipelineTarget(args.pipeline_path, context.directory)');
  expect(doc).toContain('assertStagedAgentRoot');
  expect(doc).toContain('path: relative(input.root, planPath)');
  expect(doc).not.toContain('process.cwd()');
});

test('tagma-trial-planner instructs host trial-plan failure handling for live .tagma safety', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-trial-planner-safety-'));
  try {
    seedOpencodeArtifacts(dir);
    const doc = readFileSync(join(dir, '.opencode', 'agents', 'tagma-trial-planner.md'), 'utf8');

    expect(doc).toContain('If a pre-commit `tagma_trial_plan` operation fails');
    expect(doc).toContain('Pass the exact staged YAML path');
    expect(doc).toContain('let `commit` validate the complete plan before writing');
    expect(doc).toContain('relative to the isolated case project root');
    expect(doc).toContain('never assert staged YAML or its companion artifacts');
    expect(doc).toContain('Never copy YAML or trial plans between staging and live `.tagma`');
    expect(doc).toContain('do not use symlinks, junctions, copies, or writes to live `.tagma`');
    expect(doc).toContain('briefly report the host/tool error and end the physical turn');
    expect(doc).toContain('Every finding must set `repairScope`');
    expect(doc).toContain(
      'Every coverage entry must include `dimension`, `status`, `caseIds`, and `rationale`',
    );
    expect(doc).toContain(
      'Every finding must include `severity`, `repairScope`, `summary`, and `evidence`',
    );
    expect(doc).toContain(
      'Pre-commit operations validate their proposed section and immediately decidable links',
    );
    expect(doc).toContain('Blocked coverage is diagnostic-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tagma-pipeline agent prefers host-native commands before Python glue', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('The editor host OS is `Windows`');
  expect(doc).toContain('Use Python only when host-native commands would be bulky');
  expect(doc).toContain('enabled="false"');
  expect(doc).toContain('Enable Python AI Agent in Editor Settings');
  expect(doc).toContain('<python-agent enabled="true">');
  expect(doc).toContain('Prefer a host-native implementation');
  expect(doc).toContain('host-native helper files directly');
  expect(doc).toContain('tagma-python-tools');
});

test('Windows pipeline authoring uses PowerShell unless CMD is explicit argv', () => {
  const documents = [buildTagmaPipelineAgent('Windows'), buildTagmaNativePrimitivesSkill()];

  for (const doc of documents) {
    expect(doc).toContain('run under Windows PowerShell by default');
    expect(doc).toContain('`2>$null`');
    expect(doc).toContain('`dir /s /b /a-d`');
    expect(doc).toContain('`2>nul`');
    expect(doc).toContain('`%VAR%`');
    expect(doc).toContain('`cmd.exe`');
    expect(doc).toContain('`argv`');
  }

  expect(buildTagmaPipelineAgent('Windows')).not.toContain('Prefer PowerShell/cmd');
});

test('tagma-pipeline agent grants python tools only when workspace settings enable them', () => {
  expect(buildTagmaPipelineAgent('Windows')).toContain('task: false');
  expect(buildTagmaPipelineAgent('Windows')).toContain('tagma-python-tools: "deny"');
  expect(buildTagmaPipelineAgent('Windows', { pythonToolsEnabled: true })).toContain('task: true');
  expect(buildTagmaPipelineAgent('Windows', { pythonToolsEnabled: true })).toContain(
    'tagma-python-tools: "allow"',
  );
});

test('tagma-python-tools refuses to run without configured Python handoff', () => {
  const doc = buildTagmaPythonToolsAgent('Windows');

  expect(doc).toContain('## Preflight hard stop');
  expect(doc).toContain('<python-agent enabled="true">');
  expect(doc).toContain('<interpreter>');
  expect(doc).toContain('<venv>');
  expect(doc).toContain('PYTHON_HELPER_BLOCKED');
  expect(doc).toContain('Do not fall back to `python`, `python3`, `py`, or PATH probing');
});

test('tagma-pipeline agent codifies track design as agent identity vs layout lane', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('agent identity envelopes');
  expect(doc).toContain('Command-only tracks are layout/cwd/on_failure lanes');
  expect(doc).toContain('continue_from` is prompt-to-prompt');
  expect(doc).toContain('Do not split merely to express parallelism');
});

test('tagma-pipeline agent forbids inconsistent prompt personas and inert command-track AI fields', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('Split tracks when driver, model, agent_profile, permissions');
  expect(doc).toContain('Do not set inert AI fields');
  expect(doc).toContain('Do not put AI-only fields');
});

test('seedOpencodeArtifacts writes only the plural agents dir and focused skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-opencode-seed-'));

  expect(seedOpencodeArtifacts(dir)).toBe(true);

  const nativeSkill = join(dir, '.opencode', 'skills', 'tagma-native-primitives', 'SKILL.md');
  const resilienceSkill = join(
    dir,
    '.opencode',
    'skills',
    'tagma-execution-resilience',
    'SKILL.md',
  );
  const triggerSkill = join(dir, '.opencode', 'skills', 'tagma-trigger-strategy', 'SKILL.md');
  const yamlContractSkill = join(dir, '.opencode', 'skills', 'tagma-yaml-contract', 'SKILL.md');
  const safetySkill = join(dir, '.opencode', 'skills', 'tagma-human-safety', 'SKILL.md');
  const planSkill = join(dir, '.opencode', 'skills', 'tagma-plan-delegate', 'SKILL.md');
  const localToolsSkill = join(dir, '.opencode', 'skills', 'tagma-local-tools', 'SKILL.md');
  const planSkillDoc = readFileSync(planSkill, 'utf8');

  const agentsDir = join(dir, '.opencode', 'agents');
  const routerAgent = join(agentsDir, 'tagma-router.md');
  const pipelineAgent = join(agentsDir, 'tagma-pipeline.md');
  const diagnosisAgent = join(agentsDir, 'tagma-pipeline-diagnosis.md');
  const generalAgent = join(agentsDir, 'tagma-general-discussion.md');
  const historyAgent = join(agentsDir, 'tagma-history-compare.md');
  const reviewAgent = join(agentsDir, 'tagma-yaml-review.md');
  const plannerAgent = join(agentsDir, 'tagma-pipeline-planner.md');
  const commandEvidenceAgent = join(agentsDir, 'tagma-command-evidence.md');
  const runtimeGuardAgent = join(agentsDir, 'tagma-runtime-guard.md');
  const contextPackagerAgent = join(agentsDir, 'tagma-context-packager.md');
  const sectionBuilderAgent = join(agentsDir, 'tagma-pipeline-section-builder.md');
  const trialPlannerAgent = join(agentsDir, 'tagma-trial-planner.md');
  const pythonAgent = join(agentsDir, 'tagma-python-tools.md');
  const managedAgents = [
    routerAgent,
    pipelineAgent,
    diagnosisAgent,
    generalAgent,
    historyAgent,
    reviewAgent,
    plannerAgent,
    commandEvidenceAgent,
    runtimeGuardAgent,
    contextPackagerAgent,
    sectionBuilderAgent,
    trialPlannerAgent,
    pythonAgent,
  ];
  const skeletonTool = join(dir, '.opencode', 'tools', 'tagma_yaml_skeleton.ts');
  const placementTool = join(dir, '.opencode', 'tools', 'tagma_placement_plan.ts');
  const trialPlanTool = join(dir, '.opencode', 'tools', 'tagma_trial_plan.ts');
  const blockToolNames = [
    'tagma_read_block.ts',
    'tagma_upsert_block.ts',
    'tagma_create_skeleton.ts',
    'tagma_delete_block.ts',
  ];

  expect(existsSync(routerAgent)).toBe(true);
  expect(readFileSync(routerAgent, 'utf8')).toContain('mode: primary');
  expect(readFileSync(routerAgent, 'utf8')).toContain('tagma-pipeline');
  expect(existsSync(pipelineAgent)).toBe(true);
  expect(readFileSync(pipelineAgent, 'utf8')).toContain('name: tagma-pipeline');
  expect(existsSync(diagnosisAgent)).toBe(true);
  expect(readFileSync(diagnosisAgent, 'utf8')).toContain('name: tagma-pipeline-diagnosis');
  expect(readFileSync(diagnosisAgent, 'utf8')).toContain('edit: deny');
  expect(existsSync(generalAgent)).toBe(true);
  expect(existsSync(historyAgent)).toBe(true);
  expect(readFileSync(historyAgent, 'utf8')).toContain('stateless');
  expect(existsSync(reviewAgent)).toBe(true);
  expect(readFileSync(reviewAgent, 'utf8')).toContain('name: tagma-yaml-review');
  expect(readFileSync(reviewAgent, 'utf8')).toContain('mode: subagent');
  expect(readFileSync(reviewAgent, 'utf8')).toContain('hidden: true');
  expect(readFileSync(reviewAgent, 'utf8')).toContain('edit: deny');
  expect(readFileSync(reviewAgent, 'utf8')).toContain('Return findings, not fixes');
  expect(existsSync(plannerAgent)).toBe(true);
  expect(readFileSync(plannerAgent, 'utf8')).toContain('name: tagma-pipeline-planner');
  expect(readFileSync(plannerAgent, 'utf8')).toContain('track/persona boundaries');
  expect(existsSync(commandEvidenceAgent)).toBe(true);
  expect(readFileSync(commandEvidenceAgent, 'utf8')).toContain('name: tagma-command-evidence');
  expect(readFileSync(commandEvidenceAgent, 'utf8')).toContain('grounded_command');
  expect(existsSync(runtimeGuardAgent)).toBe(true);
  expect(readFileSync(runtimeGuardAgent, 'utf8')).toContain('name: tagma-runtime-guard');
  expect(readFileSync(runtimeGuardAgent, 'utf8')).toContain('manual approval');
  expect(existsSync(contextPackagerAgent)).toBe(true);
  expect(readFileSync(contextPackagerAgent, 'utf8')).toContain('name: tagma-context-packager');
  expect(readFileSync(contextPackagerAgent, 'utf8')).toContain('compact handoff');
  expect(existsSync(sectionBuilderAgent)).toBe(true);
  expect(readFileSync(sectionBuilderAgent, 'utf8')).toContain(
    'name: tagma-pipeline-section-builder',
  );
  expect(readFileSync(sectionBuilderAgent, 'utf8')).toContain(
    'Implement exactly one manifest section',
  );
  expect(existsSync(trialPlannerAgent)).toBe(true);
  expect(readFileSync(trialPlannerAgent, 'utf8')).toContain('name: tagma-trial-planner');
  expect(readFileSync(trialPlannerAgent, 'utf8')).toContain('tagma_trial_plan: allow');
  expect(existsSync(pythonAgent)).toBe(true);
  expect(readFileSync(pythonAgent, 'utf8')).toContain('name: tagma-python-tools');
  expect(readFileSync(pythonAgent, 'utf8')).toContain('hidden: true');
  expect(readFileSync(pythonAgent, 'utf8')).toContain('function-oriented Python helpers');
  expect(readFileSync(pythonAgent, 'utf8')).toContain('PYTHON_HELPER_BLOCKED');
  expect(readFileSync(pipelineAgent, 'utf8')).toContain('tagma-python-tools: "deny"');
  expect(existsSync(skeletonTool)).toBe(true);
  expect(readFileSync(skeletonTool, 'utf8')).toContain(
    'Generate a Tagma YAML skeleton from a pipeline manifest',
  );
  expect(readFileSync(skeletonTool, 'utf8')).toContain('export default tool');

  // No singular `.opencode/agent/` dir, and no renamed-away agents anywhere.
  expect(existsSync(join(dir, '.opencode', 'agent'))).toBe(false);
  expect(existsSync(join(agentsDir, 'tagma-yaml.md'))).toBe(false);
  expect(existsSync(join(agentsDir, 'tagma-pipeline-create.md'))).toBe(false);
  expect(existsSync(join(agentsDir, 'tagma-pipeline-edit.md'))).toBe(false);

  expect(existsSync(placementTool)).toBe(true);
  expect(readFileSync(placementTool, 'utf8')).toContain(
    'import { tool } from "@opencode-ai/plugin"',
  );
  expect(readFileSync(placementTool, 'utf8')).toContain(
    'Compute deterministic Tagma .layout.json positions',
  );
  expect(existsSync(trialPlanTool)).toBe(true);
  expect(readFileSync(trialPlanTool, 'utf8')).toContain(
    'Build a targeted trial plan in bounded draft operations',
  );
  const contextWindowPlugin = join(dir, '.opencode', 'plugins', 'tagma-chat-context-window.ts');
  expect(existsSync(contextWindowPlugin)).toBe(true);
  const contextWindowPluginDoc = readFileSync(contextWindowPlugin, 'utf8');
  expect(contextWindowPluginDoc).toContain('experimental.chat.messages.transform');
  expect(contextWindowPluginDoc).toContain('tagma-chat-context-window');
  // A content change must invalidate the readiness marker so a stale marker
  // from a previous process cannot report readiness for a newer plugin.
  expect(existsSync(join(dir, '.opencode', '.tagma-chat-context-window-ready.json'))).toBe(false);
  for (const toolName of blockToolNames) {
    expect(existsSync(join(dir, '.opencode', 'tools', toolName))).toBe(false);
  }
  expect(readFileSync(nativeSkill, 'utf8')).toContain('name: tagma-native-primitives');
  expect(existsSync(yamlContractSkill)).toBe(true);
  const yamlContractDoc = readFileSync(yamlContractSkill, 'utf8');
  expect(yamlContractDoc.length).toBeGreaterThan(30_000);
  expect(yamlContractDoc).toContain('name: tagma-yaml-contract');
  expect(yamlContractDoc).toContain('### 12. Typed task bindings');
  expect(yamlContractDoc).toContain('`directory` - waits for a directory path');
  expect(yamlContractDoc).toContain('Omit it to inherit workspace Execution Settings');
  expect(yamlContractDoc).toContain('`timeout?` (default `2h`)');
  expect(yamlContractDoc).toContain('Each command has a hard\n2-hour timeout');
  expect(yamlContractDoc).toContain('## Companion `.layout.json` file');
  expect(yamlContractDoc).toContain('tagma_placement_plan');
  expect(yamlContractDoc).toContain('## Companion `.requirements.md` file');
  expect(yamlContractDoc).toContain('## YAML compilation feedback');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('## YAML contract');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('There is no `ports:` key');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('read the same-folder `.compile.log`');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('## Command tasks');
  expect(readFileSync(resilienceSkill, 'utf8')).toContain('Bounded self-healing pattern');
  expect(readFileSync(resilienceSkill, 'utf8')).toContain('workspace Execution Settings');
  expect(readFileSync(triggerSkill, 'utf8')).toContain('name: tagma-trigger-strategy');
  expect(readFileSync(triggerSkill, 'utf8')).toContain('Trigger strategy');
  expect(readFileSync(triggerSkill, 'utf8')).toContain('workspace task timeout by default');
  expect(readFileSync(safetySkill, 'utf8')).toContain('Best-effort rollback pattern');
  expect(planSkillDoc).toContain('Decide track boundaries by agent identity, not by parallelism');
  expect(planSkillDoc).toContain('command-only track');
  expect(planSkillDoc).toContain('Design decision interview');
  expect(planSkillDoc).toContain('Ask exactly one question at a time');
  expect(planSkillDoc).toContain('include your recommended answer');
  expect(planSkillDoc).toContain('use explore or direct read-only inspection');
  expect(readFileSync(localToolsSkill, 'utf8')).toContain(
    'Use Python for new per-pipeline helpers',
  );
  expect(readFileSync(localToolsSkill, 'utf8')).toContain(
    'Prefer CLI-style helpers for stateless, idempotent work',
  );
  for (const agentPath of managedAgents) {
    expect(readFileSync(agentPath, 'utf8')).toContain('steps: 25');
  }
  expect(seedOpencodeArtifacts(dir)).toBe(false);

  // Existing workspaces receive the global default on their next bootstrap
  // instead of retaining a stale per-agent limit forever.
  writeFileSync(
    routerAgent,
    readFileSync(routerAgent, 'utf8').replace('steps: 25', 'steps: 2'),
    'utf8',
  );
  expect(seedOpencodeArtifacts(dir)).toBe(true);
  expect(readFileSync(routerAgent, 'utf8')).toContain('steps: 25');
});

test('seedOpencodeArtifacts applies repeated global step-limit changes to every managed agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-opencode-step-limit-'));
  const agentsDir = join(dir, '.opencode', 'agents');
  const filenames = [
    'tagma-router.md',
    'tagma-pipeline.md',
    'tagma-pipeline-diagnosis.md',
    'tagma-general-discussion.md',
    'tagma-history-compare.md',
    'tagma-yaml-review.md',
    'tagma-pipeline-planner.md',
    'tagma-command-evidence.md',
    'tagma-runtime-guard.md',
    'tagma-context-packager.md',
    'tagma-pipeline-section-builder.md',
    'tagma-trial-planner.md',
    'tagma-python-tools.md',
  ];

  expect(seedOpencodeArtifacts(dir, { agentMaxSteps: 40 })).toBe(true);
  for (const filename of filenames) {
    expect(readFileSync(join(agentsDir, filename), 'utf8')).toContain('steps: 40');
  }

  expect(seedOpencodeArtifacts(dir, { agentMaxSteps: 12 })).toBe(true);
  for (const filename of filenames) {
    expect(readFileSync(join(agentsDir, filename), 'utf8')).toContain('steps: 12');
  }
  expect(seedOpencodeArtifacts(dir, { agentMaxSteps: 12 })).toBe(false);
});

test('seedOpencodeArtifacts rewrites the pipeline agent when Python tools are enabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-opencode-python-seed-'));
  const pipelineAgent = join(dir, '.opencode', 'agents', 'tagma-pipeline.md');

  expect(seedOpencodeArtifacts(dir)).toBe(true);
  expect(readFileSync(pipelineAgent, 'utf8')).toContain('tagma-python-tools: "deny"');
  expect(seedOpencodeArtifacts(dir, { pythonToolsEnabled: true })).toBe(true);
  expect(readFileSync(pipelineAgent, 'utf8')).toContain('tagma-python-tools: "allow"');
  expect(seedOpencodeArtifacts(dir, { pythonToolsEnabled: true })).toBe(false);
});

test('seedOpencodeArtifacts prunes stale agents left by an older editor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-opencode-prune-'));

  // Simulate a workspace seeded by the pre-merge editor: singular dir copies
  // plus the renamed-away create/edit/yaml agents in the plural dir.
  const singularDir = join(dir, '.opencode', 'agent');
  const pluralDir = join(dir, '.opencode', 'agents');
  mkdirSync(singularDir, { recursive: true });
  mkdirSync(pluralDir, { recursive: true });
  writeFileSync(join(singularDir, 'tagma-router.md'), 'stale', 'utf8');
  writeFileSync(join(singularDir, 'tagma-pipeline-diagnosis.md'), 'stale', 'utf8');
  writeFileSync(join(singularDir, 'tagma-pipeline-planner.md'), 'stale', 'utf8');
  writeFileSync(join(singularDir, 'tagma-trial-planner.md'), 'stale', 'utf8');
  writeFileSync(join(singularDir, 'tagma-yaml.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-pipeline-create.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-pipeline-edit.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-yaml.md'), 'stale', 'utf8');

  seedOpencodeArtifacts(dir);

  expect(existsSync(join(singularDir, 'tagma-router.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-pipeline-diagnosis.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-pipeline-planner.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-trial-planner.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-yaml.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-create.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-edit.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-yaml.md'))).toBe(false);
  // The real agents are written to the plural dir.
  expect(existsSync(join(pluralDir, 'tagma-router.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-pipeline.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-diagnosis.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-planner.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-trial-planner.md'))).toBe(true);
});
