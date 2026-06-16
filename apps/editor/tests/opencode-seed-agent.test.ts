import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTagmaCommandEvidenceAgent,
  buildTagmaContextPackagerAgent,
  buildTagmaGeneralDiscussionAgent,
  buildTagmaHistoryCompareAgent,
  buildTagmaPipelineAgent,
  buildTagmaPipelinePlannerAgent,
  buildTagmaPlacementTool,
  buildTagmaRuntimeGuardAgent,
  buildTagmaRouterAgent,
  buildTagmaTriggerStrategySkill,
  buildTagmaYamlContractSkill,
  seedOpencodeArtifacts,
} from '../server/opencode-seed';

test('tagma-router delegates history comparisons without read/edit powers', () => {
  const doc = buildTagmaRouterAgent();

  expect(doc).toContain('mode: primary');
  expect(doc).toContain('history_comparison');
  expect(doc).toContain('tagma-history-compare');
  expect(doc).toContain('stateless');
  expect(doc).toContain('<history-version-compare>');
  expect(doc).toContain('pipeline_work');
  expect(doc).toContain('general_discussion');
  expect(doc).toContain('tagma-pipeline');
  expect(doc).toContain('tagma-general-discussion');
  // create/edit are merged — the router must not know those agents anymore.
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
  expect(doc).toContain('Never forward raw full transcript excerpts');
  expect(doc).toContain('read: deny');
  expect(doc).toContain('edit: deny');
});

test('router prompt stays compact with the history comparison lane', () => {
  // Keep classification overhead bounded even after adding the history lane.
  expect(buildTagmaRouterAgent().length).toBeLessThan(3000);
});

test('tagma-pipeline agent stays compact and keeps schema detail out of the base prompt', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc.length).toBeLessThan(15_000);
  expect(doc).toContain('Keep context small');
  expect(doc).toContain('schema source of truth');
  expect(doc).toContain('YAML Contract Quick Reference');
  expect(doc).not.toContain('### 12. Typed task bindings');
  expect(doc).not.toContain('#### Port types and coercion');
});

test('merged tagma-pipeline agent is a hidden subagent handling create + edit', () => {
  const pipeline = buildTagmaPipelineAgent('Windows');
  const general = buildTagmaGeneralDiscussionAgent();
  const history = buildTagmaHistoryCompareAgent();

  expect(pipeline).toContain('name: tagma-pipeline');
  expect(pipeline).toContain('mode: subagent');
  expect(pipeline).toContain('hidden: true');
  // No routed-specialization split anymore — one worker, two modes.
  expect(pipeline).not.toContain('Routed specialization');
  expect(pipeline).not.toContain('ROUTE_MISMATCH: modify_pipeline');
  expect(pipeline).not.toContain('ROUTE_MISMATCH: create_pipeline');

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
  expect(doc).toContain('For **create new**: write the manifest first');
  expect(doc).toContain('Bypass the manifest only when it is missing, unreadable, stale');
  expect(doc).toContain('compile.log');
  expect(doc).toContain('Never finish after a YAML write');
  expect(doc).toContain('success: true');
  expect(doc).toContain('Settings -> Secrets Manager');
  expect(doc).toContain('Never ask for or store secret values');
  expect(doc).toContain('never edit `.env`');
  expect(doc).toContain('never call secret-manager APIs');
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
  expect(doc).toContain('Never invent `npm test`');
  expect(doc).toContain('Strip a leading `.tagma/`');
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

test('tagma-pipeline agent exposes focused skills and read-only native subagents', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('task: true');
  expect(doc).toContain('skill: true');
  expect(doc).toContain('tagma_yaml_skeleton: true');
  expect(doc).toContain('tagma_yaml_skeleton: allow');
  expect(doc).toContain('tagma_placement_plan: true');
  expect(doc).toContain('tagma_placement_plan: allow');
  expect(doc).toContain('explore: "allow"');
  expect(doc).toContain('scout: "allow"');
  expect(doc).toContain('tagma-pipeline-planner: "allow"');
  expect(doc).toContain('tagma-command-evidence: "allow"');
  expect(doc).toContain('tagma-runtime-guard: "allow"');
  expect(doc).toContain('tagma-context-packager: "allow"');
  expect(doc).toContain('tagma-python-tools: "allow"');
  expect(doc).toContain('tagma-yaml-contract: "allow"');
  expect(doc).toContain('Load `tagma-yaml-contract` before any create');
  expect(doc).toContain('tagma-native-primitives: "allow"');
  expect(doc).toContain('tagma-trigger-strategy: "allow"');
  expect(doc).toContain('Native OpenCode Orchestration');
  expect(doc).toContain('Subagent Dispatch');
  expect(doc).toContain('Call `tagma-pipeline-planner`');
  expect(doc).toContain('Call `tagma-command-evidence`');
  expect(doc).toContain('Call `tagma-runtime-guard`');
  expect(doc).toContain('Call `tagma-context-packager`');
  expect(doc).toContain('Merge specialist findings into the smallest YAML/layout/requirements change');
  expect(doc).toContain('Do not delegate writes except');
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

test('tagma-pipeline agent runs a read-only review subagent before finishing YAML work', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('tagma-yaml-review: "allow"');
  expect(doc).toContain('## Review Agent Loop');
  expect(doc).toContain('After YAML/layout/requirements changes, call `tagma-yaml-review` once');
  expect(doc).toContain('Pass the review findings back into your own adjustment loop');
  expect(doc).toContain('Report unfixable issues plainly');
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

test('tagma-pipeline agent prefers host-native commands before Python glue', () => {
  const doc = buildTagmaPipelineAgent('Windows');

  expect(doc).toContain('The editor host OS is `Windows`');
  expect(doc).toContain('Use Python only when host-native commands would be bulky');
  expect(doc).toContain('stateless CLI');
  expect(doc).toContain('webhooks, warm processing, shared state');
  expect(doc).toContain('<python-agent>');
  expect(doc).toContain('tagma-python-tools');
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
  const generalAgent = join(agentsDir, 'tagma-general-discussion.md');
  const historyAgent = join(agentsDir, 'tagma-history-compare.md');
  const reviewAgent = join(agentsDir, 'tagma-yaml-review.md');
  const plannerAgent = join(agentsDir, 'tagma-pipeline-planner.md');
  const commandEvidenceAgent = join(agentsDir, 'tagma-command-evidence.md');
  const runtimeGuardAgent = join(agentsDir, 'tagma-runtime-guard.md');
  const contextPackagerAgent = join(agentsDir, 'tagma-context-packager.md');
  const pythonAgent = join(agentsDir, 'tagma-python-tools.md');
  const skeletonTool = join(dir, '.opencode', 'tools', 'tagma_yaml_skeleton.ts');
  const placementTool = join(dir, '.opencode', 'tools', 'tagma_placement_plan.ts');
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
  expect(existsSync(pythonAgent)).toBe(true);
  expect(readFileSync(pythonAgent, 'utf8')).toContain('name: tagma-python-tools');
  expect(readFileSync(pythonAgent, 'utf8')).toContain('hidden: true');
  expect(readFileSync(pythonAgent, 'utf8')).toContain('function-oriented Python helpers');
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
  expect(yamlContractDoc).toContain('## Companion `.layout.json` file');
  expect(yamlContractDoc).toContain('tagma_placement_plan');
  expect(yamlContractDoc).toContain('## Companion `.requirements.md` file');
  expect(yamlContractDoc).toContain('## YAML compilation feedback');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('## YAML contract');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('There is no `ports:` key');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('read the same-folder `.compile.log`');
  expect(readFileSync(nativeSkill, 'utf8')).toContain('## Command tasks');
  expect(readFileSync(resilienceSkill, 'utf8')).toContain('Bounded self-healing pattern');
  expect(readFileSync(triggerSkill, 'utf8')).toContain('name: tagma-trigger-strategy');
  expect(readFileSync(triggerSkill, 'utf8')).toContain('Trigger strategy');
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
  expect(seedOpencodeArtifacts(dir)).toBe(false);
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
  writeFileSync(join(singularDir, 'tagma-pipeline-planner.md'), 'stale', 'utf8');
  writeFileSync(join(singularDir, 'tagma-yaml.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-pipeline-create.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-pipeline-edit.md'), 'stale', 'utf8');
  writeFileSync(join(pluralDir, 'tagma-yaml.md'), 'stale', 'utf8');

  seedOpencodeArtifacts(dir);

  expect(existsSync(join(singularDir, 'tagma-router.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-pipeline-planner.md'))).toBe(false);
  expect(existsSync(join(singularDir, 'tagma-yaml.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-create.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-edit.md'))).toBe(false);
  expect(existsSync(join(pluralDir, 'tagma-yaml.md'))).toBe(false);
  // The real agents are written to the plural dir.
  expect(existsSync(join(pluralDir, 'tagma-router.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-pipeline.md'))).toBe(true);
  expect(existsSync(join(pluralDir, 'tagma-pipeline-planner.md'))).toBe(true);
});
