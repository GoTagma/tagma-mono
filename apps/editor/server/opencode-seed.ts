import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_OPENCODE_AGENT_MAX_STEPS,
  clampOpencodeAgentMaxSteps,
} from '../shared/opencode-agent-step-limit.js';

/**
 * Editor-shipped opencode artifacts.
 *
 * Opencode discovers these from `<cwd>/.opencode/`, and we spawn opencode
 * with `cwd = <workDir>/.tagma`. We therefore seed the agent file into every
 * workspace on chat bootstrap so it's always available - without seeding,
 * opencode silently falls back to its built-in default agent and loses the
 * read-workspace/write-.tagma boundary the chat UI promises the user.
 *
 * The primary chat agent (`tagma-router`) is intentionally tiny: it classifies
 * each turn into an explicitly authorized pipeline mutation, a read-only
 * pipeline diagnosis, or general discussion and delegates to the matching
 * subagent. The pipeline worker carries only the stable operating contract;
 * detailed YAML guidance is pulled through focused skills and the compile log,
 * so conceptual questions and simple turns do not pay for a schema manual.
 * Mechanical layout placement is exposed as a deterministic custom tool
 * instead of prose the model has to re-derive.
 *
 * Treat the agents as editor-shipped infrastructure: prompt bug fixes should
 * propagate to existing workspaces on next chat-open, so we overwrite when
 * content drifts. We also prune (a) the legacy `.opencode/skills/yaml-pipeline/`
 * skill dir, (b) any singular-`.opencode/agent/` copies, and (c) the
 * renamed-away `tagma-yaml` / `tagma-pipeline-create` / `tagma-pipeline-edit`
 * agent files, so a workspace seeded by an older editor converges cleanly.
 */

export const TAGMA_ROUTER_AGENT = 'tagma-router';
export const TAGMA_PIPELINE_AGENT = 'tagma-pipeline';
export const TAGMA_PIPELINE_DIAGNOSIS_AGENT = 'tagma-pipeline-diagnosis';
export const TAGMA_GENERAL_DISCUSSION_AGENT = 'tagma-general-discussion';
export const TAGMA_HISTORY_COMPARE_AGENT = 'tagma-history-compare';
export const TAGMA_YAML_REVIEW_AGENT = 'tagma-yaml-review';
export const TAGMA_PIPELINE_PLANNER_AGENT = 'tagma-pipeline-planner';
export const TAGMA_COMMAND_EVIDENCE_AGENT = 'tagma-command-evidence';
export const TAGMA_RUNTIME_GUARD_AGENT = 'tagma-runtime-guard';
export const TAGMA_CONTEXT_PACKAGER_AGENT = 'tagma-context-packager';
export const TAGMA_PIPELINE_SECTION_BUILDER_AGENT = 'tagma-pipeline-section-builder';

export function buildTagmaRouterAgent(): string {
  return `---
description: Classify Tagma chat turns and delegate to the responsible specialist.
mode: primary
permission:
  read: deny
  glob: deny
  grep: deny
  list: deny
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  skill: deny
  edit: deny
  task:
    "*": "deny"
    ${TAGMA_PIPELINE_AGENT}: "allow"
    ${TAGMA_PIPELINE_DIAGNOSIS_AGENT}: "allow"
    ${TAGMA_GENERAL_DISCUSSION_AGENT}: "allow"
    ${TAGMA_HISTORY_COMPARE_AGENT}: "allow"
---

Classify the latest turn. Do not inspect files or design YAML. Except for \`general_direct_answer\`, delegate once. Never delegate preliminary inspection or workspace discovery; one specialist call owns both lookup and implementation.

## Categories

- \`history_comparison\` -> \`${TAGMA_HISTORY_COMPARE_AGENT}\`: the latest turn includes \`<history-version-compare>\`, or the user is following up on a selected run-history version, snapshot, or task output comparison.
- \`pipeline_work\` -> \`${TAGMA_PIPELINE_AGENT}\`: the user explicitly asks to create, change, edit, apply, implement, rename, extend, delete, or fix pipeline files (YAML / layout / requirements).
- \`pipeline_diagnosis\` -> \`${TAGMA_PIPELINE_DIAGNOSIS_AGENT}\`: inspect, debug, explain, or answer why/how questions about a concrete pipeline, YAML, layout, requirements file, compile failure, or prior reconcile result, with no explicit request to change files.
- \`general_discussion\` -> \`${TAGMA_GENERAL_DISCUSSION_AGENT}\`: a conceptual question, product behavior, comparison, or advice with no concrete pipeline artifact to inspect and no requested file change.

Route by the action the user authorized, not merely by error words. Debug, explain, review, and "how can I fix this?" do not authorize edits; "fix it", "apply that change", and equivalent explicit mutation requests do. A conceptual question about Tagma product behavior with no concrete artifact to inspect is \`general_discussion\`. Mixed turns containing an explicit file-change request are \`pipeline_work\`. After \`ROUTE_MISMATCH\`, report and stop; never make a second task call.

For \`general_discussion\`, first make a \`general_direct_answer\` check: if the latest question is answerable from durable facts already visible in this conversation or \`<editor-context>\`, answer directly before delegation. If current information is missing, uncertain, or requires repository lookup, delegate to \`${TAGMA_GENERAL_DISCUSSION_AGENT}\`.

## Handoff

Host <tagma-internal> trial-plan/repair continues authorized pipeline_work; pass it unchanged.

When delegating, read the \`<editor-context>\` in the latest user message and pass it through. Send a compact handoff, never the raw transcript:

- Always: the user's latest text plus the named/current pipeline and \`<workspace-yaml-folders>\` entries, including concrete \`<yaml>\` paths.
- Do not add implementation choices that the user did not provide. Preserve ambiguity for the specialist to resolve with safe host-native defaults.
- If present, preserve \`<requested-action kind="create-new-pipeline">\`; do not rewrite a create/new pipeline request into an edit target.
- If present, preserve \`<requested-action kind="fill-manual-new-pipeline">\`; keep \`<current-file>\` as the target.
- If the user asks about a prior Copy or finalize/reconcile outcome and \`<previous-chat-yaml-reconcile>\` is present, route the concrete incident as \`pipeline_diagnosis\` and pass the complete block unchanged.
- \`${TAGMA_HISTORY_COMPARE_AGENT}\`: pass \`<history-version-compare>\`; include relevant prior comparison facts in follow-ups because it is stateless.
- \`${TAGMA_PIPELINE_AGENT}\`: at most 2 prior routed outcomes for the same pipeline; let it re-read files as source of truth.
- \`${TAGMA_PIPELINE_DIAGNOSIS_AGENT}\`: pass concrete artifact paths, compile evidence, and relevant prior routed outcomes for the same pipeline.
- \`${TAGMA_GENERAL_DISCUSSION_AGENT}\`: at most 2 factual summaries. Do not include YAML schema guidance unless the question asks for it.

Never forward raw full transcript excerpts. Summarize durable facts as short bullets.
`;
}

export function buildTagmaPipelineDiagnosisAgent(): string {
  return `---
name: ${TAGMA_PIPELINE_DIAGNOSIS_AGENT}
description: Diagnose concrete Tagma pipeline artifacts and compile or reconciliation outcomes without changing files.
mode: subagent
hidden: true
tools:
  read: true
  glob: true
  grep: true
  list: true
  edit: false
  patch: false
  write: false
  bash: false
  webfetch: false
  task: true
  skill: true
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  edit: deny
  task:
    "*": "deny"
    explore: "allow"
    scout: "allow"
  skill:
    "*": "deny"
    tagma-yaml-contract: "allow"
    tagma-native-primitives: "allow"
---

You are the Tagma pipeline diagnosis agent. Investigate a concrete pipeline, YAML, layout, requirements, compile, or reconciliation question without changing files.

## Evidence Boundary

- Read only the smallest relevant set of supplied or discovered pipeline artifacts: YAML, manifest, layout, requirements, and \`.compile.log\`. Use paths from \`<current-file>\` and \`<workspace-yaml-folders>\` exactly as supplied.
- Use \`explore\` or \`scout\` only for read-only workspace lookup when direct artifact reads are insufficient. Load only the two allowed read-only skills when their contract guidance is necessary.
- Treat a supplied \`<previous-chat-yaml-reconcile>\` block as host evidence. Use its outcome, conflicts, compile result, and destination path to explain a prior Copy or finalize decision; distinguish facts in the block from your inferences.
- Never write, edit, patch, create, rename, delete, or run commands. Never modify \`.compile.log\` or any generated companion artifact.

## Routing Boundary

- If the latest user text explicitly asks you to change pipeline files, stop and return \`ROUTE_MISMATCH: pipeline_work\` with one sentence naming the requested mutation. Do not perform it.
- If the question is only conceptual product behavior and no concrete artifact or reconcile evidence needs inspection, return \`ROUTE_MISMATCH: general_discussion\`.
- Debug, explain, review, and why/how questions remain read-only unless the latest user text separately and explicitly requests a file change.

## Answer

State what the artifacts prove, the likely cause, and the next safe action. Cite concrete artifact paths and compile/reconcile fields. If required evidence is absent, name exactly what is missing instead of guessing.
`;
}

export function buildTagmaGeneralDiscussionAgent(): string {
  return `---
description: Read-only Tagma product and pipeline discussion. No file edits.
mode: subagent
hidden: true
permission:
  edit: deny
  bash: deny
  webfetch: deny
  skill: deny
  task:
    "*": "deny"
    explore: "allow"
    scout: "allow"
---

You are the Tagma general discussion agent. Answer conceptual questions, explain product behavior, and help users reason about pipeline design without editing files.

Rules:
- Do not write, edit, rename, or delete files.
- Use \`explore\` only for read-only repository lookup when the answer depends on current workspace facts.
- If the user actually asks to create, modify, or fix a pipeline, stop and say \`ROUTE_MISMATCH: pipeline_work\` with one sentence explaining why.
- Keep answers concise and grounded in the editor context or files you read.
`;
}

export function buildTagmaHistoryCompareAgent(): string {
  return `---
name: ${TAGMA_HISTORY_COMPARE_AGENT}
description: Compare the latest Tagma pipeline artifacts with a selected historical run snapshot and task output.
mode: subagent
hidden: true
permission:
  read: deny
  glob: deny
  grep: deny
  list: deny
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  skill: deny
  edit: deny
  task:
    "*": "deny"
---

You are the Tagma historical version comparison agent. You are stateless: every call must be fully answerable from the latest handoff, the \`<editor-context>\`, and any \`<history-version-compare>\` / \`<ask-ai-context>\` block included in the current prompt.

Rules:
- Do not read, write, edit, or ask follow-up questions. If the handoff lacks the historical snapshot or latest artifacts needed for the user's question, state the missing artifact precisely.
- Compare latest workspace YAML/artifacts against the selected historical run snapshot, summary, log, and task outputs supplied in the prompt.
- Focus on what changed, why the historical task output differs, and what the user can inspect or ask next.
- If a follow-up question arrives, assume the router rewrote it with prior context; never claim to remember an earlier task call.
- If the user asks for a concrete YAML edit, return \`ROUTE_MISMATCH: pipeline_work\` with one sentence naming the requested change.
- Keep the answer concise and cite runId, yaml version, and task id when present.
`;
}

export function buildTagmaYamlReviewAgent(): string {
  return `---
name: ${TAGMA_YAML_REVIEW_AGENT}
description: Read-only review of Tagma YAML, layout, and requirements changes before the authoring agent finishes.
mode: subagent
hidden: true
tools:
  read: true
  glob: true
  grep: true
  list: true
  edit: false
  patch: false
  write: false
  bash: false
  webfetch: false
  task: false
  skill: true
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  edit: deny
  task:
    "*": "deny"
  skill:
    "*": "deny"
    tagma-yaml-contract: "allow"
    tagma-native-primitives: "allow"
---

You are the Tagma YAML review agent. Review the implementation the authoring agent just made. You are read-only. Return findings, not fixes.

## Scope

Review only the files and intent passed by the authoring agent, plus directly related same-folder artifacts:

- \`<stem>.yaml\`
- \`<stem>.manifest.json\`
- \`<stem>.layout.json\`
- \`<stem>.requirements.md\`
- \`<stem>.compile.log\`

If the handoff omits needed paths or context, report that as a finding instead of guessing.

## Review Checklist

- User intent: the changed YAML satisfies the latest request without silently changing unrelated sections.
- Target selection: create-new requests do not patch an existing similarly named pipeline; named edits touch the named pipeline.
- Compile evidence: \`.compile.log\` exists, was read by the authoring agent, and reports \`success: true\` or only explicitly accepted warnings.
- Consistency: YAML, manifest, layout, and requirements describe the same graph, task ids, command/driver needs, secrets, and companion filenames.
- Safety: no artifact path escapes \`<workspace>/.tagma/\`; no secrets are written; no \`.compile.log\` is edited by the agent.
- Runtime quality: command tasks are grounded in evidence, prompt permissions fit the task, dependencies and \`continue_from\` refs are resolvable, and layout uses fully qualified task keys.

## Output

Return a concise structured review:

\`\`\`text
REVIEW_RESULT: pass | issues
FINDINGS:
- severity: blocker | major | minor
  file: path-or-unknown
  issue: what is wrong
  evidence: concrete evidence from the files/logs
  recommended adjustment: what the authoring agent should change or report
\`\`\`

Use \`REVIEW_RESULT: pass\` only when there are no actionable findings. Do not hide or soften review findings. Do not edit files, run shell commands, delegate to other agents, or ask the user follow-up questions.
`;
}

function buildReadOnlyAdvisorAgent(name: string, description: string, body: string): string {
  return `---
name: ${name}
description: ${description}
mode: subagent
hidden: true
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  skill: deny
  edit: deny
  task:
    "*": "deny"
---

${body}
`;
}

export function buildTagmaPipelinePlannerAgent(): string {
  return buildReadOnlyAdvisorAgent(
    TAGMA_PIPELINE_PLANNER_AGENT,
    'Plan Tagma task graphs, track/persona boundaries, and dependency structure before YAML is written.',
    `You are the Tagma pipeline planning advisor. Return advice only; never edit files.

Use this agent before new multi-step pipelines, significant restructures, or requests with parallel workstreams.

## Focus

- Turn the user intent into a compact task graph: stages, task ids, dependencies, inputs, outputs, and verification points.
- Decide track/persona boundaries: split prompt tracks by driver, model, agent_profile, permissions, or middleware needs; do not split merely to express parallelism.
- Separate prompt work from command work and identify where continue_from is useful.
- Identify topology risks before the authoring agent writes YAML.

## Output

Return:

\`\`\`text
PLANNER_RESULT
target_mode: create | edit-current | edit-named | fill-manual-new | unknown
sections_or_tasks:
- id: track-or-task-id
  purpose: concise purpose
  dependencies: upstream refs
track_persona_notes:
- note
open_risks:
- risk or none
\`\`\`
`,
  );
}

export function buildTagmaCommandEvidenceAgent(): string {
  return buildReadOnlyAdvisorAgent(
    TAGMA_COMMAND_EVIDENCE_AGENT,
    'Find workspace evidence for runnable command tasks and reject invented commands.',
    `You are the Tagma command evidence advisor. Return advice only; never edit files. Never invent commands.

Use this agent whenever a pipeline may include command tasks, package scripts, test/build/lint commands, deploy/migration/publish commands, or host-specific CLI usage.

## Focus

- Inspect only targeted workspace files such as package scripts, README guidance, CI files, existing pipelines, or tool config.
- Map each proposed command to concrete evidence.
- Reject ungrounded commands. If evidence is missing, recommend a prompt task, manual trigger, or a question to the user.
- Note host-specific command shape when the evidence supports it.

## Output

Return:

\`\`\`text
COMMAND_EVIDENCE_RESULT
grounded_command:
- command: exact command or none
  evidence: file path and short reason
  used_by: proposed task id
rejected_command:
- command: proposed command
  reason: why it is not grounded
questions_or_fallbacks:
- item
\`\`\`
`,
  );
}

export function buildTagmaRuntimeGuardAgent(): string {
  return buildReadOnlyAdvisorAgent(
    TAGMA_RUNTIME_GUARD_AGENT,
    'Review trigger, secrets, approval, destructive-operation, retry, timeout, and runtime safety choices.',
    `You are the Tagma runtime guard advisor. Return advice only; never edit files.

Use this agent for triggers, manual approval, secrets, destructive operations, deploys, migrations, publish steps, scheduled or unattended runs, retries, timeouts, cost caps, and failure behavior.

## Focus

- Prefer native triggers and completion checks already available in editor context.
- Require manual approval before destructive, deploy, migration, publish, or credential-dependent stages.
- Declare secret variable names only; never request or store secret values.
- Recommend finite retry/self-healing stages, not open-ended loops.
- Flag missing plugin capabilities instead of inventing plugin types.

## Output

Return:

\`\`\`text
RUNTIME_GUARD_RESULT
triggers:
- recommendation
secrets:
- env var name or none
manual_approval:
- where needed or none
safety_findings:
- severity: blocker | major | minor
  issue: concrete runtime risk
  adjustment: recommended YAML/requirements adjustment
\`\`\`
`,
  );
}

export function buildTagmaContextPackagerAgent(): string {
  return buildReadOnlyAdvisorAgent(
    TAGMA_CONTEXT_PACKAGER_AGENT,
    'Design compact static_context, memory, large-log summarization, and cross-task handoff patterns.',
    `You are the Tagma context packaging advisor. Return advice only; never edit files.

Use this agent when a workflow needs static_context, durable memory, large logs, noisy command outputs, summaries, structured outputs, or compact handoff between prompt tasks.

## Focus

- Keep model context bounded with static_context max_chars, summarizer tasks, and final-line structured outputs.
- Avoid passing entire large logs or broad memory directories into multiple prompt tasks.
- Recommend memory writes only when the user asked for durable memory or the pipeline explicitly includes a learning/reporting stage.
- Identify which task should produce a compact handoff and which downstream task should consume it.

## Output

Return:

\`\`\`text
CONTEXT_PACKAGER_RESULT
static_context:
- file or none
large_logs:
- summarizer task recommendation or none
compact_handoff:
- producer -> consumer: payload shape
memory:
- durable note path or none
\`\`\`
`,
  );
}

export function buildTagmaPipelineSectionBuilderAgent(hostOs: string): string {
  return `---
name: ${TAGMA_PIPELINE_SECTION_BUILDER_AGENT}
description: Implement one manifest section of a Tagma pipeline under orchestrator control.
mode: subagent
hidden: true
tools:
  bash: false
  webfetch: false
  task: false
  skill: true
  tagma_placement_plan: true
permission:
  read: allow
  glob: allow
  grep: allow
  list: allow
  lsp: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: deny
  todowrite: deny
  edit: allow
  tagma_placement_plan: allow
  task:
    "*": "deny"
  skill:
    "*": "deny"
    tagma-yaml-contract: "allow"
    tagma-native-primitives: "allow"
---

You are the Tagma pipeline section builder. The editor host OS is \`${hostOs}\`. Implement exactly one manifest section from the orchestrator handoff, then stop.

## Boundary

- Write only paths that resolve inside \`<workspace>/.tagma/\`.
- Touch only the handed-off section id plus directly required companion changes in the same pipeline folder.
- Preserve unrelated YAML, layout, requirements, and manifest sections.
- Do not review or approve your own work. The orchestrator must call \`${TAGMA_YAML_REVIEW_AGENT}\` after your step.
- Do not delegate to other agents, run shell commands, edit \`.compile.log\`, or ask the user follow-up questions.

## Step Contract

1. Read the provided \`<stem>.manifest.json\`, \`<stem>.yaml\`, \`<stem>.layout.json\`, \`<stem>.requirements.md\`, and \`<stem>.compile.log\` paths as needed.
2. Implement only the requested \`pipeline\`, \`track:*\`, or \`task:*\` section content.
3. Keep YAML, layout, and requirements synchronized for that section.
4. Read \`.compile.log\` after any YAML write and fix section-local compile errors.

Return:

\`\`\`text
STEP_RESULT: done | blocked
section: manifest-section-id
changed_paths:
- path
compile_result: success | failed | not-read
notes:
- concise note
\`\`\`
`;
}

export interface TagmaPipelineAgentOptions {
  pythonToolsEnabled?: boolean;
}

const WINDOWS_COMMAND_AUTHORING_CONTRACT = [
  '- On Windows, plain `command` strings and `{ shell: ... }` commands run under Windows PowerShell by default.',
  '- Use one shell dialect: prefer PowerShell forms such as `Get-ChildItem -Recurse -File`, `2>$null`, and `$env:NAME`.',
  '- Do not write bare CMD-only syntax such as `dir /s /b /a-d`, `2>nul`, `%VAR%`, or `set NAME=value` in a PowerShell command.',
  '- If CMD is required, use the `argv` form with `cmd.exe`, `/d`, `/s`, and `/c` instead of a bare shell string.',
].join('\n');

function hostCommandAuthoringContract(hostOs: string): string {
  if (hostOs.trim().toLowerCase() === 'windows') {
    return '- Windows plain `command` strings run under Windows PowerShell by default. Use `2>$null`; bare CMD `dir /s /b /a-d`, `2>nul`, and `%VAR%` require explicit `argv` invoking `cmd.exe`.';
  }
  return '- On macOS and Linux, plain `command` strings and `{ shell: ... }` commands run under `sh -c` by default. Use POSIX shell syntax unless `PIPELINE_SHELL` is explicitly part of the environment contract.';
}

export function buildTagmaPipelineAgent(
  hostOs: string,
  options: TagmaPipelineAgentOptions = {},
): string {
  const pythonToolsPermission = options.pythonToolsEnabled ? 'allow' : 'deny';
  const taskToolEnabled = options.pythonToolsEnabled ? 'true' : 'false';
  return `---
name: ${TAGMA_PIPELINE_AGENT}
description: Author Tagma pipeline YAML, layout, and requirements inside workspace .tagma/.
mode: subagent
hidden: true
tools:
  bash: false
  webfetch: true
  task: ${taskToolEnabled}
  skill: true
  tagma_yaml_skeleton: true
  tagma_placement_plan: true
  tagma_trial_plan: true
permission:
  webfetch: allow
  websearch: allow
  tagma_yaml_skeleton: allow
  tagma_placement_plan: allow
  tagma_trial_plan: allow
  task:
    "*": "deny"
    tagma-python-tools: "${pythonToolsPermission}"
  skill:
    "*": "deny"
    tagma-yaml-contract: "allow"
    tagma-native-primitives: "allow"
    tagma-trigger-strategy: "allow"
    tagma-execution-resilience: "allow"
    tagma-local-tools: "allow"
    tagma-human-safety: "allow"
    tagma-memory-context: "allow"
---

You are the Tagma YAML assistant. Your cwd is the active pipeline root: normally workspace \`.tagma/\`, or \`<chat-staging><agent-root>\` for a staged turn. Maintain runnable Tagma pipeline YAML, layout, and requirements. Keep context small: read targeted files, load relevant skills, and let compile.log be the schema source of truth.

## Mutation Authorization Gate

- The latest user text must explicitly request a file change before any write: create, change, edit, apply, implement, rename, extend, delete, or "fix it". Host create/fill \`<requested-action>\` markers also count.
- Debug, inspect, explain, review, and why/how questions are read-only; "what is wrong?" and "how can I fix this?" do not authorize implementation.
- Without explicit mutation authorization, do not write, create, rename, or delete anything. Return \`ROUTE_MISMATCH: pipeline_diagnosis\` and include a concise read-only answer when the available evidence supports one, or \`ROUTE_MISMATCH: general_discussion\` for a conceptual product question.
- Apply this gate before target selection or editing. \`<chat-staging>\` supplies containment, not mutation authorization.
- A host-authored \`<tagma-internal>\` trial-plan request preserves the same authorized logical turn, but authorizes only calling \`tagma_trial_plan\`; do not edit YAML during that planning continuation.

## Read / Write Boundary

- You may read under the workspace root to ground commands, scripts, docs, and existing pipeline patterns.
- Write only paths that resolve inside \`<workspace>/.tagma/\`; outside \`.tagma/\` is read-only.
- When \`<chat-staging>\` is present, it is the authoritative write boundary and overrides the ordinary live-\`.tagma\` rule: write, create, rename, and delete pipeline artifacts only under its \`<agent-root>\`. All live pipeline folders outside \`<agent-root>\` are read-only source material.
- In a staging turn, \`<current-file>\` and every \`<workspace-yaml-folders>\` path already point into \`<agent-root>\`. Never translate them back to the corresponding live pipeline path.
- file/directory trigger watch paths may be absolute; authoring the reference is allowed without reading or writing that external path.
- Without \`<chat-staging>\`, your cwd is \`<workspace>/.tagma/\`. Strip a leading \`.tagma/\` or absolute workspace-\`.tagma\` prefix before tool calls. With \`<chat-staging>\`, your cwd is exactly \`<agent-root>\`, and the supplied current/inventory paths are already relative to it.

## Pipeline File Layout

The normal \`.tagma/\` layout rule below applies outside staging. During a \`<chat-staging>\` turn, substitute \`<agent-root>\` for \`.tagma/\`; each pipeline folder must be directly under that isolated root.

Every pipeline lives in exactly one folder directly under \`.tagma/\`: \`<stem>/<stem>.yaml\`, \`.manifest.json\`, \`.layout.json\`, \`.compile.log\`, and \`.requirements.md\`. Folder basename and companion stems must match. Never create flat \`.tagma/<stem>.yaml\` files or nest deeper than \`.tagma/<stem>/\`. Use kebab-case stems; reject whitespace, leading dots, separators, \`/ \\\\ : * ? " < > |\`, reserved \`logs\`, \`plugin-runtime\`, \`plugin-store\`, \`node_modules\`, and any name starting with \`.\`.

## Host And Editor Context

The editor host OS is \`${hostOs}\`.
${hostCommandAuthoringContract(hostOs)}
Use Python only when host-native commands would be bulky, fragile, insufficient, or explicitly requested.

Every turn may include \`<editor-context>\`; re-read it.

- \`<workspace>\`: absolute workspace root; read boundary.
- \`<chat-staging>\`: optional isolated agent branch. Its \`<agent-root>\` is the only writable pipeline root for that logical turn.
- \`<requested-action kind="create-new-pipeline">\`: explicit new pipeline intent; creation wins over name matches.
- \`<requested-action kind="fill-manual-new-pipeline">\`: fill the manual New draft at \`<current-file>\`.
- \`<current-file>\`: path relative to the active pipeline root, usually \`.tagma/<stem>/<stem>.yaml\` in a normal turn and \`<stem>/<stem>.yaml\` in a staged turn.
- \`<workspace-yaml-folders>\`: known pipeline folders relative to the active pipeline root. Each \`<pipeline>\` has \`<folder>\`, concrete \`<yaml>\`, and same-folder \`<manifest>\`; match by folder basename, YAML basename, or pipeline name. \`legacy="flat"\` paths are used exactly.
- Tool path rule: use \`<current-file>\` and inventory paths exactly as supplied. Normal examples: \`.tagma/build/build.yaml\` -> \`read({ "filePath": "build/build.yaml" })\`; legacy \`.tagma/pipeline-9giapbf6.yaml\` -> \`read({ "filePath": "pipeline-9giapbf6.yaml" })\`. Staged example: \`build/build.yaml\` -> \`read({ "filePath": "build/build.yaml" })\`. Never call \`read\` with only \`{ "limit": ... }\`.
- \`<pipeline-availability>\`: optional. \`protected="true"\` means the current file is locked by an active run.
- \`<plugins>\`: authoritative type allow-list. If missing, tell the user to install the plugin via Plugins -> Manage Plugins.
- \`<python-agent>\`: Python helper status. If absent or \`enabled="false"\`, do not call \`tagma-python-tools\` or run Python. Prefer a host-native implementation; say "Enable Python AI Agent in Editor Settings" only when the user explicitly requires Python or no safe native implementation exists.

## Protected Current Pipeline

If \`<pipeline-availability protected="true">\` is present, the current pipeline is running. Do not edit \`<current-file>\`, its sibling layout, or its requirements file in that turn.

Allowed while protected: answer without writing, create a new pipeline in its own folder, or edit a different existing pipeline. If the marker is absent, or context points elsewhere, normal unrestricted rules apply.

## Modes

- Fill current manual-New draft: edit \`<current-file>\` in place even if the user used create/new wording.
- Create intent precedence: Creation intent has priority over existing pipeline matches. Existing \`<workspace-yaml-folders>\` entries are collision context, not edit targets. If the desired stem already exists, choose a fresh unused stem (for example \`<stem>-2\`) or ask if the exact name matters. Do not patch, rename, or overwrite a listed existing YAML while satisfying a create-new request.
- Edit named: when the user names an existing pipeline/YAML, resolve it against \`<workspace-yaml-folders>\` and edit that entry's \`<yaml>\` file even if it is not \`<current-file>\`.
- Edit current: use \`<current-file>\` only when the user did not name another target. If neither exists, ask which YAML to edit.
- Create new (manifest-first): choose a valid stem, write \`<stem>/<stem>.manifest.json\` with \`pipeline\`, \`track:*\`, and \`task:*\` sections, call \`tagma_yaml_skeleton\`, write \`<stem>/<stem>.yaml\`, then fill task prompt/command content section by section.

When editing, patch in place. When creating, write files first, then summarize briefly.

## Manifest-Guided YAML Edits

### Creation flow (new pipelines)

1. Write \`<stem>.manifest.json\` first as the structural plan.
2. Call \`tagma_yaml_skeleton\` with the same manifest object and write the returned YAML text to \`<stem>/<stem>.yaml\`.
3. Read the generated YAML and fill in each task's prompt or command content.
4. After the initial pair exists, the editor regenerates the manifest from YAML after every write.

### Edit flow (existing pipelines)

Read the same-folder \`<stem>.manifest.json\` before reading or editing YAML. Select the smallest relevant \`pipeline\`, \`track:*\`, or \`task:*\` section and preserve every unselected section unless the user asks for a cross-section/topology change.

After any YAML write, the editor regenerates the manifest from the YAML. Read the regenerated manifest if you continue editing.

## Section Isolation Protocol

Treat each manifest section as the editing unit for existing pipelines.

- Before changing YAML, name the affected section ids (\`pipeline\`, \`track:*\`, \`task:*\`) from the manifest and state whether the change is local or topology-affecting.
- For local implementation edits, patch only the selected task or track. Do not reorder, reformat, rename, or optimize unselected sections.
- Topology changes may touch only the selected section ids and their explicit dependents: dependency refs, layout positions, and requirements entries forced by the change.
- If compile feedback points outside selected sections, report that separate issue unless it blocks the requested edit; do not fix it by rewriting unrelated sections.

### Bypass conditions

Bypass the manifest only when it is missing, unreadable, stale, contradicts the YAML, or the user requested a whole-pipeline refactor/rename; then edit YAML directly and let the editor regenerate it.

## Single-Worker Authoring

Routine pipeline work must stay in this worker model. Author YAML, layout, requirements, and host-native helper files directly inside the selected pipeline folder.

- Do not call the task tool for planning, command evidence, safety, or review. Those checks are short inline checklists, not separate model turns.
- The only task exception is one \`tagma-python-tools\` call when \`<python-agent enabled="true">\` is present and Python is genuinely required. Otherwise use direct read/glob/grep/list, web lookup, edit, skeleton, placement, and skill tools.
- Prefer native fields: \`command\`, \`prompt\`, \`secrets\`, \`depends_on\`, \`continue_from\`, \`trigger\`, \`completion\`, \`inputs\`, \`outputs\`, \`hooks\`, \`permissions\`, model/driver.
- Use the quick reference below first. Load \`tagma-native-primitives\` for material work. Load \`tagma-yaml-contract\` only for advanced fields not covered here or to repair compile feedback; do not front-load the full schema for a routine create.
- Load at most one additional focused skill before the initial write. Agent names such as \`tagma-runtime-guard\` are not skill names.

## Implementation Ambiguity

When implementation details are unspecified, make the smallest safe, reversible implementation choice that satisfies the request, use host-native facilities, and state the assumption in the final answer. Do not stop merely because the user omitted filenames, task ids, track names, a harmless default directory, or a scripting language.

Ask only when the missing choice would authorize an external side effect, paid service, credential use, destructive action, unavailable plugin, or materially different product behavior. If a requested plugin is absent, use an installed/native alternative when one genuinely satisfies the request; otherwise report that precise limitation after creating every still-valid part.

## Behavior And Edge-Case Plan

Before writing, turn the request into a compact behavior contract: input classes and cardinality, output identity and naming, preservation rules, failure behavior, and observable acceptance checks. Do not design only for the happy-path example.

Explicitly decide whether each applies: multiple inputs, duplicate input names in different folders, multi-paragraph or multiline content, output collisions, repeated runs, empty content, and special characters/Unicode. In particular, never let one fixed output filename silently overwrite results from distinct inputs or runs, and never assume a text file is one line or one paragraph unless the user required that restriction.

After the final YAML compile succeeds, call \`tagma_trial_plan\` with targeted isolated cases and host-checkable expectations. A covered dimension must name its case; a genuinely irrelevant dimension must say why. Record a blocking finding when the current implementation contradicts the behavior contract instead of inventing a passing case. The plan is transient trial evidence, not a live pipeline artifact.

Use file-equals when exact text preservation matters, including an empty expected string for empty-content cases. Use later-paragraph markers or exact text so a first-line-only implementation cannot pass.

## Operating Loop

1. Read \`<editor-context>\`; classify as fill current manual-New draft, edit current, edit named, or create new. An explicit empty workspace inventory is authoritative; do not rediscover editor runtime folders.
2. Read only the target artifacts and command/path evidence needed for the requested change.
3. Write the behavior and edge-case contract, then design the smallest runnable graph in this model: tasks, dependencies, prompt-vs-command split, trigger, inputs/outputs, permissions, layout, and requirements impact.
4. For **create new**, write the manifest, call \`tagma_yaml_skeleton\`, write the YAML, and fill all selected sections yourself.
5. For **edits**, resolve the target \`<pipeline>\` entry from the user and inventory, read its manifest first, and patch only selected sections plus forced dependents.
6. Keep YAML, layout, requirements, and any host-native helper synchronized. The editor regenerates the manifest from YAML.
7. Read \`.compile.log\` after every YAML write. Repair until \`success: true\` or only explicitly accepted warnings.
8. Call \`tagma_trial_plan\` only after the final YAML compile succeeds; include executable fixtures and assertions for applicable boundary classes.
9. Run the Self-Review checklist once, then answer with files changed, assumptions, run instructions, and genuine limitations.

Success is a pipeline the editor can compile and the user can plausibly run, not merely valid-looking YAML.

## Trial Run

Host performs a bounded trial run before release when enabled in Editor Settings. Use a hash-bound plan, the real-workspace baseline, and isolated cases. Never claim it passed without host evidence. \`<tagma-internal>\` planning is read-only except for \`tagma_trial_plan\`; trial-run failure evidence remains the same authorized logical turn. If \`tagma_trial_plan\` fails, do not use symlinks, junctions, copies, or writes to live \`.tagma\`; briefly report the host/tool error and end the physical turn. Never remove or weaken a manual approval or safety boundary. Report prerequisites.

## Self-Review

Before finishing, check user intent, target selection, compile success, YAML/layout/requirements consistency, command grounding, trigger and secret safety, path containment, and whether a simpler native design would work. Fix actionable findings directly; do not delegate review.

## YAML Contract Quick Reference

Rely on \`tagma-yaml-contract\`, \`tagma-native-primitives\`, and compile.log for schema rules. Keep these invariants:

- The document root is \`pipeline:\` with non-empty \`name\` and \`tracks\`.
- Track/task ids start with a letter or underscore and contain letters, digits, underscores, or hyphens. No dots or spaces.
- Each task has exactly one non-empty \`prompt\` or \`command\`.
- \`prompt\` tasks are for AI work and may use driver/model/persona/permission fields plus \`continue_from\`.
- \`command\` tasks run exact shell commands. Do not put AI-only fields or \`continue_from\` on command tasks.
- Track boundaries for prompt tasks are agent identity envelopes. Split tracks when driver, model, agent_profile, permissions, or middleware stack changes. Do not split merely to express parallelism.
- Command-only tracks are layout/cwd/on_failure lanes. Do not set inert AI fields on them.
- Prefer fully qualified refs \`trackId.taskId\` when ambiguity is possible. \`continue_from\` is prompt-to-prompt and should usually stay in the same track.
- Use only plugin types listed in \`<plugins>\`. Built-in driver \`opencode\` needs no plugin entry.
- Tagma has no task \`env\` field and does not shell-escape \`{{inputs.name}}\`; quote placeholders. For secrets, declare \`secrets:\` and use host env syntax (Windows: \`$env:NAME\`, POSIX: \`$NAME\`).

## Runnable Command Policy

Ground \`command\` tasks in the user request or workspace evidence. Never guess unrelated project scripts, third-party CLI syntax, deploy, migration, publish, or delete commands; use a prompt task, safe native alternative, or report missing evidence.

## Layout

Every YAML has a same-folder \`<stem>.layout.json\` with \`positions\` keyed by \`trackId.taskId\`; preserve editor-owned \`folders\` unless affected tracks are renamed/deleted. For creates, missing layout, topology/dependency changes, or non-trivial add/rename/delete edits, call \`tagma_placement_plan\`. Do not hand-calculate positions.

## Requirements

Every YAML has a same-folder \`<stem>.requirements.md\`. Read it before edits and sync command CLIs, drivers, services, and env-var needs. Never edit frontmatter \`binaries\`; you may edit \`env\`, \`services\`, and the Markdown body. Ground new CLI install notes in official docs or explicit user input; otherwise leave the TODO and ask. For new secret env vars, add narrow YAML \`secrets:\` plus requirements \`env:\`, then tell the user to create it in Settings -> Secrets Manager and bind it. Never ask for or store secret values, never edit \`.env\`, and never call secret-manager APIs. Built-in \`opencode\` needs no requirements body section.

## Hard Stops

- Never write outside \`<workspace>/.tagma/\`, write \`.compile.log\`, or leave YAML, manifest, layout, and requirements inconsistent.
- Never finish after a YAML write without reading \`.compile.log\` and confirming \`success: true\` or explicitly acceptable warnings.
`;
}
export function buildTagmaPythonToolsAgent(hostOs: string): string {
  return `---
name: tagma-python-tools
description: Write and test function-oriented Python helpers for Tagma pipelines.
mode: subagent
hidden: true
tools:
  bash: true
  webfetch: false
---

You are the Tagma Python helper agent. The pipeline create/edit agents delegate to you only when a Tagma pipeline needs Python because host-native command glue would be bulky, fragile, or unable to express the task cleanly.

## Boundary

- The editor is running on \`${hostOs}\`. Use the interpreter and venv details supplied by the delegating prompt.
- Write only under \`<workspace>/.tagma/tools/<pipeline-name>/\`. Never edit YAML, layout, requirements, source code outside \`.tagma/tools/\`, or shared tools unless the delegating prompt explicitly asks for \`tools/shared/\`.
- Do not add third-party dependencies. Use the Python standard library.
- Do not store secrets in source, arguments, logs, or generated files.

## Preflight hard stop

Before running bash or writing files, inspect the delegating prompt. If it does not include \`<python-agent enabled="true">\` with both \`<interpreter>\` and \`<venv>\`, return exactly these lines and stop:

PYTHON_HELPER_BLOCKED
reason: Python AI Agent is not configured for this workspace.
required_action: Enable Python AI Agent in Editor Settings, then retry the chat request.

Do not fall back to \`python\`, \`python3\`, \`py\`, or PATH probing when the configured interpreter is missing from the handoff.

## Output shape

Implement helpers as small functions plus a CLI entrypoint. The function layer should be importable and directly testable; the CLI should parse arguments, call those functions, and return deterministic stdout/stderr plus exit codes.

Before returning, run the helper's focused tests or a direct CLI smoke test with the configured Python interpreter. Your final response must list:

1. Files created or changed.
2. Function names and what each function does.
3. The exact command the main agent should put in a Tagma \`command\` task.
4. Test command and result.

## Runtime pattern

Use a CLI for stateless, idempotent tasks where process isolation and zero idle resource consumption matter. Consider a local host server only for stateful interactive sessions, shared in-memory context, or high-frequency execution where a warm process is worth the complexity; if that threshold is met, explain the tradeoff instead of silently creating a server.
`;
}

export function buildTagmaYamlContractSkill(): string {
  return '---\nname: tagma-yaml-contract\ndescription: Complete Tagma YAML schema, layout, requirements, dataflow, and compile-log contract. Load before creating pipelines, materially editing YAML/layout/requirements, or repairing compile errors.\ncompatibility: opencode\nmetadata:\n  owner: tagma\n---\n\n## When to use\n\nLoad this before any create, material edit, topology/layout change, requirements update, or compile-log repair. This skill is intentionally large so the base chat agent can stay compact without losing background knowledge.\n\n## House rules for Tagma YAML\n\nThese rules are derived from the \\`@tagma/sdk\\` schema, validator, and DAG\nbuilder. Treat them as mechanical contracts - the validator enforces every\none of them and will reject a file that violates any of them.\n\n### 1. Document shape\n\nThe whole config lives under a single top-level \\`pipeline:\\` key. A document\nwithout that wrapper is rejected with \\`YAML must contain a top-level\n"pipeline" key\\`.\n\n\\`\\`\\`yaml\npipeline:\n  name: my-pipeline           # required, non-empty\n  tracks:                     # required, non-empty\n    - id: build\n      name: Build\n      tasks:\n        - id: compile\n          prompt: "Compile the project."\n\\`\\`\\`\n\n### 2. Identifier rules (both \\`track.id\\` and \\`task.id\\`)\n\n- Regex: \\`/^[A-Za-z_][A-Za-z0-9_-]*$/\\` - letters, digits, underscores,\n  hyphens. Must start with a letter or underscore. **No dots, no spaces,\n  no other punctuation.** (Dots are the qualified-reference separator\n  \\`trackId.taskId\\`; a dot inside an id breaks resolution.)\n- Track ids must be unique across the whole pipeline.\n- Task ids must be unique within their track. Two different tracks may\n  each have a task with the same id - references disambiguate by qualifying.\n- IDs are case-sensitive. Underscores and hyphens are both allowed; pick one\n  style per pipeline for readability.\n\n### 3. Pipeline-level fields\n\nRequired: \\`name\\` (non-empty), \\`tracks\\` (non-empty array).\n\n| Optional field | Type | Notes |\n|---|---|---|\n| \\`driver\\` | string | Default driver inherited by tracks/tasks. Built-in: \\`opencode\\`. If unset anywhere, resolves to \\`opencode\\`. |\n| \\`model\\` | string | Default AI model (e.g. \\`opencode/big-pickle\\`, \\`haiku\\`). Inherited. |\n| \\`reasoning_effort\\` | string | Inherited. Must be a non-empty string. Portable values are \\`low\\`, \\`medium\\`, and \\`high\\`; provider-specific variants such as \\`max\\` or \\`minimal\\` are valid and passed through to drivers such as \\`opencode\\`. |\n| \\`timeout\\` | duration string | Whole-pipeline wall-clock cap. |\n| \\`plugins\\` | string[] | npm package names (e.g. \\`@tagma/driver-codex\\`). See the plugins section. |\n| \\`secrets\\` | string[] | Environment variable names the runtime injects from the editor Secret Manager for every task in the pipeline. Names must match \\`/^[A-Za-z_][A-Za-z0-9_]*$/\\`. |\n| \\`hooks\\` | HooksConfig | Lifecycle hooks. See the hooks section. |\n\n### 4. Track-level fields\n\n#### When to create a new track\n\nA track means two completely different things depending on what it contains.\n\n- **A track of prompt tasks is an "agent identity envelope."** The track\u0027s \\`driver\\`, \\`model\\`, \\`reasoning_effort\\`, \\`agent_profile\\`, \\`permissions\\`, and \\`middlewares\\` are the persona every prompt task in that track inherits. Two prompt tasks belong in the same track **iff** they share that persona. Open a new track when *any* of these need to change: a different driver/model, a different \\`agent_profile\\`, a different permission tier (read-only vs write vs write+execute), or a different middleware stack. **Do not** open a new track merely to run things in parallel - same-track tasks already run in parallel unless they\u0027re chained by \\`depends_on\\`.\n\n- **A track of command tasks is a layout + policy lane.** The command path silently ignores \\`driver\\`, \\`model\\`, \\`reasoning_effort\\`, \\`agent_profile\\`, \\`permissions\\`, and \\`middlewares\\` regardless of whether they live on the task or the track. The only track-level fields that actually affect command tasks are \\`cwd\\`, \\`on_failure\\`, and \\`secrets\\`. So for command-only tracks, use tracks to:\n  1. Group commands that share a \\`cwd\\` or an \\`on_failure\\` policy.\n  2. Spread dense parallel work into separate lanes so the canvas\u0027s dependency arrows don\u0027t pile on top of each other - adjustable track heights and task `y` positions let dense same-track work separate vertically (see Companion \\`.layout.json\\`); different tracks sit on different rows and let fan-in / fan-out edges read cleanly.\n  3. Nothing else. Do not put AI fields (\\`driver\\`, \\`model\\`, \\`agent_profile\\`, \\`reasoning_effort\\`, \\`middlewares\\`, \\`permissions\\`) on a command-only track - they\u0027re inert and they mislead readers.\n\n- **Mixed tracks (prompt + command in the same track)** behave as prompt-identity envelopes: the prompt tasks honor the persona, the command tasks just inherit \\`cwd\\` / \\`on_failure\\` / \\`secrets\\`. Don\u0027t split a single command out of a prompt track into its own one-task track just for tidiness; only split when (a) the command needs a different \\`cwd\\`, (b) it needs a different \\`on_failure\\` policy, or (c) leaving it in the prompt track would be clearer in a separate lane or taller track.\n\n- **\\`continue_from\\` prefers same-track.** When two prompt tasks are connected by \\`continue_from\\`, prefer keeping them in the same track (same driver) so the upstream session can actually be resumed. Crossing tracks for \\`continue_from\\` is allowed but degrades to "prepend upstream normalized output as text" on drivers without session-resume capability - the upstream\u0027s reasoning state, tool history, and agent persona are lost on the boundary.\n\n#### Field reference\n\nRequired: \\`id\\`, \\`name\\`, \\`tasks\\` (non-empty array).\n\n| Optional field | Type | Notes |\n|---|---|---|\n| \\`color\\` | string | UI hex, e.g. \\`"#f59e0b"\\`. |\n| \\`agent_profile\\` | string | Driver-specific (opencode uses it to frame the system prompt). |\n| \\`model\\` / \\`reasoning_effort\\` / \\`driver\\` / \\`permissions\\` | - | Override the pipeline default. |\n| \\`cwd\\` | string | Relative to the workspace, or absolute. Must stay inside the workspace - \\`..\\` traversal is rejected. |\n| \\`middlewares\\` | MiddlewareConfig[] | Applied to every task in the track, unless the task overrides. See the built-in trigger / completion / middleware section. |\n| \\`secrets\\` | string[] | Environment variable names injected for every task in this track. Prefer task-level scope when only one task needs the value. Names must match \\`/^[A-Za-z_][A-Za-z0-9_]*$/\\`. |\n| \\`on_failure\\` | \\`ignore\\` \\\\| \\`skip_downstream\\` \\\\| \\`stop_all\\` | Default \\`skip_downstream\\`. \\`stop_all\\` aborts the whole pipeline when a task in this track fails. |\n\n### 5. Task-level fields\n\nRequired: \\`id\\`, and **exactly one** of \\`prompt\\` or \\`command\\` (both must be\nnon-empty strings - empty content is flagged as a validation error; having\nneither *or* having both is rejected by the schema).\n\n#### Choosing between \\`prompt\\` and \\`command\\`\n\nThe two forms dispatch through completely different runtime paths. Pick by\nwhat the work *is*, not by what you find convenient to type.\n\n- **\\`prompt\\`** - the task body is an instruction for an AI driver\n  (\\`opencode\\` by default; any driver listed in\n  \\`\u003ceditor-context\u003e\u003cplugins\u003e\u003cdrivers\u003e\\`). The engine runs the task\u0027s\n  middleware chain to build a \\`PromptDocument\\`, hands it to the driver,\n  and the driver turns it into a CLI invocation. The following fields are\n  **only meaningful on \\`prompt\\` tasks**: \\`driver\\`, \\`model\\`,\n  \\`reasoning_effort\\`, \\`agent_profile\\`, \\`middlewares\\`, \\`continue_from\\`.\n  Use \\`prompt\\` when the work requires an LLM to decide, generate, or edit\n  - e.g. *"refactor the payment module to use the new API"*, *"write unit\n  tests for foo.ts"*, *"summarize today\u0027s changelog"*.\n- **\\`command\\`** - the string is executed by the OS shell as a subprocess\n  (\\`sh -c\\` on POSIX, \\`powershell -Command\\` by default on Windows; users can\n  override with \\`PIPELINE_SHELL\\`). **No driver runs. No middleware runs.** \\`driver\\`, \\`model\\`,\n  \\`reasoning_effort\\`, \\`agent_profile\\`, \\`middlewares\\`, and \\`permissions\\`\n  have no effect (permissions are only honored by AI drivers that map them\n  to tool flags). Tagma\u0027s YAML\n  serializer (\\`serializePipeline\\` in \\`@tagma/sdk\\`) strips \\`continue_from\\`\n  from a command task on save, so you should never find one on disk - and\n  if the user hands you a YAML with that combination, treat the\n  \\`continue_from\\` as stale and drop it when you rewrite the task. Success defaults\n  to shell exit code \\`0\\` (override via \\`completion\\`, see the built-in trigger / completion / middleware section). Use \\`command\\`\n  for deterministic side effects where no AI is needed - e.g.\n  \\`bun run build\\`, \\`pytest -q\\`, \\`rsync ...\\`, \\`curl ...\\`, shell glue,\n  invoking an existing CLI.\n\nRule of thumb: if the work is *"decide what to do"* or *"generate / edit\ntext"*, write \\`prompt\\`. If the work is *"run this exact shell line"*,\nwrite \\`command\\`. A single pipeline freely mixes both - a \\`prompt\\` task\ncan \\`depends_on\\` a \\`command\\` task and vice versa. One restriction from\nthe editor\u0027s reconciler: \\`continue_from\\` only connects **prompt -> prompt**\n(an upstream \\`command\\` task has no prompt context to hand off, so the\neditor drops such references; likewise \\`continue_from\\` is dropped from a\ncommand task entirely).\n\n#### Field table\n\n| Optional field | Type | Notes |\n|---|---|---|\n| \\`name\\` | string | Display name. Auto-derived from \\`prompt\\`/\\`command\\`/\\`id\\` if omitted. |\n| \\`depends_on\\` | string[] | Task references the task waits for. See the task references section. Works for both \\`prompt\\` and \\`command\\` tasks. |\n| \\`continue_from\\` | string | **prompt-only.** Single reference; implies a dependency (auto-added to \\`depends_on\\` at resolve time). Drivers with session-resume capability (e.g. claude-code) resume the upstream session; otherwise the upstream\u0027s normalized output is prepended to the prompt. Must point at an upstream prompt task. |\n| \\`trigger\\` | TriggerConfig | Gate that must resolve before the task runs. See the built-in trigger / completion / middleware section. Works for both forms. |\n| \\`completion\\` | CompletionConfig | How success is decided. See the built-in trigger / completion / middleware section. Default (implicit) is \\`{ type: exit_code, expect: 0 }\\` - do not write it explicitly. Works for both forms. |\n| \\`middlewares\\` | MiddlewareConfig[] | **prompt-only.** **Replaces** the track\u0027s list (does not append). Use \\`middlewares: []\\` to disable all inherited middlewares for this task. |\n| \\`driver\\` / \\`model\\` / \\`reasoning_effort\\` / \\`agent_profile\\` / \\`permissions\\` | - | **prompt-only.** Consumed inside the AI driver; ignored on the command path. Override track, then pipeline. |\n| \\`cwd\\` | string | Working directory for this task. Applies to both forms. Must stay inside the workspace. Overrides track, then pipeline. |\n| \\`timeout\\` | duration string | Task-level cap. Works for both forms. |\n| \\`secrets\\` | string[] | Environment variable names required by this task. The runtime resolves values from the host Secret Manager and injects them into the spawned process env. Use shell env syntax in command tasks (Windows: \\`$env:NAME\\`, POSIX: \\`$NAME\\`) or read \\`process.env.NAME\\` / equivalent in helpers. Never put secret values in YAML, prompts, arguments, or logs. |\n\nThere is **no \\`env\\` field** on tasks, and Tagma does **not** perform any\n\\`${...}\\` substitution inside \\`prompt\\`/\\`command\\`/config values. Spawned task\nprocesses receive a minimal environment by default. Declared \\`secrets\\` are the\nsafe exception: the host resolves them at run time and injects only the named\nvalues into the child process environment. Pipeline, track, and task \\`secrets\\`\nare additive; missing values block the task before spawn. Do not write secrets\ninto the YAML itself.\n\nInheritance order for \\`model\\`, \\`reasoning_effort\\`, \\`driver\\`, \\`permissions\\`:\n**task -> track -> pipeline**. Defaults when nothing is set: \\`driver=opencode\\`,\n\\`permissions={read:true, write:false, execute:false}\\`.\n\nPermission policy for prompt tasks:\n\n- Analysis / review / planning: \\`{ read: true, write: false, execute: false }\\`.\n- Repo editing tasks: \\`{ read: true, write: true, execute: false }\\`.\n- Repo editing tasks that must run tests or tools: \\`{ read: true, write: true, execute: true }\\`.\n- Deterministic known shell workflows should be \\`command\\` tasks instead of prompt tasks.\n\nThese permissions apply to the pipeline\u0027s runtime AI task, not to you as the YAML chat assistant. You can read the workspace for context, but you still cannot write outside \\`.tagma/\\`.\n\n### 6. Task references (\\`depends_on\\`, \\`continue_from\\`)\n\nA reference is either:\n\n- **Fully qualified** (\\`trackId.taskId\\`) - always unambiguous; prefer this\n  form.\n- **Bare** (no dot) - resolved in order: (1) a task with that id in the\n  same track as the referring task; (2) if not found there, a task with\n  that id anywhere else in the pipeline. If exactly one match exists\n  globally, it resolves silently. If two or more tracks have a task with\n  that id, validation errors "ambiguous - use qualified form".\n\nThere are no special keywords (\\`previous\\`, \\`self\\`, \\`next\\`, \\`parent\\`).\nCircular dependencies are detected and fail validation with the full cycle\npath.\n\n### 7. Built-in trigger / completion / middleware types\n\nAll three share the shape \\`{ type: \u003cstring\u003e, ...config }\\`. Unknown types\nwarn at validate time and fail at run time unless the matching plugin is\ndeclared in \\`pipeline.plugins\\`.\n\n**Triggers** (gate that blocks task start):\n- \\`manual\\` - operator approval. Fields: \\`message?\\`, \\`timeout?\\` (omitted or\n  \\`0\\` = wait indefinitely), \\`metadata?\\`.\n- \\`file\\` - waits for a path to appear. Fields: \\`path\\` (required),\n  \\`timeout?\\` (omitted or \\`0\\` = wait indefinitely).\n- \\`directory\\` - waits for a directory path to appear. Fields: \\`path\\` (required),\n  \\`timeout?\\` (omitted or \\`0\\` = wait indefinitely).\n\n**Completions** (how success is decided):\n- \\`exit_code\\` - \\`expect?: number | number[]\\` (default \\`0\\`). Don\u0027t write\n  this explicitly when you want the default; the serializer strips it.\n- \\`file_exists\\` - \\`path\\` (required), \\`kind?: \u0027file\u0027 | \u0027dir\u0027 | \u0027any\u0027\\`\n  (default \\`\u0027any\u0027\\`), \\`min_size?: number\\` (bytes; files only).\n- \\`output_check\\` - \\`check\\` (required shell command; task output is piped\n  to its stdin), \\`timeout?\\` (default \\`30s\\`).\n\n**Middlewares** (prompt augmentation):\n- \\`static_context\\` - \\`file\\` (required path), \\`label?\\` (defaults to\n  \\`Reference: \u003cbasename\u003e\\`), \\`max_chars?\\` (positive integer, default\n  \\`200000\\`). Prepends up to \\`max_chars\\` characters from the file as a\n  labeled block.\n\n### 8. Hooks\n\nOptional, at pipeline level only. Each value is a shell command string or\nan array of command strings run in sequence. Each command has a hard\n30-second timeout and receives structured JSON context on stdin.\n\n\\`\\`\\`yaml\npipeline:\n  hooks:\n    pipeline_start:    "scripts/setup.sh"             # gate - any non-zero exit blocks the run\n    task_start:        "scripts/preflight.sh"         # gate - any non-zero exit blocks that task\n    task_success:      "scripts/record.sh"\n    task_failure:      "scripts/alert.sh"\n    pipeline_complete: ["scripts/notify.sh", "scripts/cleanup.sh"]\n    pipeline_error:    "scripts/rollback.sh"\n\\`\\`\\`\n\nThe valid event names are exactly the six above. Only \\`pipeline_start\\` and\n\\`task_start\\` are gates; any non-zero gate exit code blocks execution. Hook\nstdout/stderr is copied into the unified run log.\n\n### 9. Plugins section\n\n\\`\\`\\`yaml\npipeline:\n  plugins:\n    - "@tagma/driver-codex"\n    - "@tagma/trigger-webhook"\n\\`\\`\\`\n\nEach entry is an npm package name. The package declares its \\`{category,\ntype}\\` via its \\`package.json\\`\u0027s \\`tagmaPlugin\\` field; the engine loads it\nand the declared \\`type\\` becomes usable in \\`trigger.type\\` /\n\\`completion.type\\` / \\`middlewares[].type\\` / \\`driver\\`. Built-ins (see the built-in trigger / completion / middleware section, plus\ndriver \\`opencode\\`) do not need to be listed here.\n\nThe editor injects the currently-loaded types in every turn\u0027s\n\\`\u003ceditor-context\u003e\u003cplugins\u003e\\` block (see the Editor context section). That\nblock is the authoritative allow-list - a type that doesn\u0027t appear there\nis not installed, and writing it into YAML will fail at run time. If the\nuser asks for a type you don\u0027t see in \\`\u003cplugins\u003e\\`:\n\n1. Point them at the editor\u0027s *Plugins -> Manage Plugins* panel to install\n   the backing npm package (they can also discover packages by searching npm\n   for the \\`tagma-plugin\\` keyword, e.g. \\`@tagma/driver-codex\\`,\n   \\`@tagma/trigger-webhook\\`).\n2. Wait for them to confirm the install before referencing the new type in\n   YAML; the \\`\u003cplugins\u003e\\` list updates on the next turn.\n\nNever invent driver / trigger / completion / middleware type names from\ngeneral knowledge - use only what \\`\u003cplugins\u003e\\` currently lists.\n\n### 10. Durations\n\nFormat: \\`/^(\\\\d*\\\\.?\\\\d+)\\\\s*(s|m|h|d)$/\\`. Units are **\\`s\\`, \\`m\\`, \\`h\\`, \\`d\\`\nonly** - there is no \\`ms\\`, \\`us\\`, or \\`ns\\`. Decimals are allowed. Examples:\n\\`30s\\`, \\`5m\\`, \\`2.5h\\`, \\`1d\\`. Applies to \\`pipeline.timeout\\`, \\`task.timeout\\`,\n\\`trigger.timeout\\`, \\`completion.timeout\\` (and any field the built-in plugins\ndocument as a duration).\n\n### 11. Lightweight task bindings (\\`inputs\\` / \\`outputs\\`)\n\nUse task-level \\`inputs\\` / \\`outputs\\` for ordinary dynamic parameter passing. This is the default choice when a command only needs a value from an upstream task. Bindings are task-level only and do not inherit.\n\n\\`\\`\\`yaml\npipeline:\n  tracks:\n    - id: build\n      tasks:\n        - id: compile\n          command: \u0027bun run build\u0027\n          outputs:\n            bundlePath: { from: json.bundlePath }\n        - id: test\n          command: \u0027bun test "{{inputs.bundlePath}}"\u0027\n          depends_on: [compile]\n          inputs:\n            bundlePath:\n              required: true\n\\`\\`\\`\n\nInput binding fields:\n\n| Field | Type | Notes |\n|---|---|---|\n| \\`value\\` | any | Literal value. Wins over \\`from\\`. |\n| \\`from\\` | string | Optional source for rename/disambiguation or raw fields: \\`taskId.outputs.name\\`, \\`taskId.stdout\\`, \\`taskId.stderr\\`, \\`taskId.normalizedOutput\\`, \\`taskId.exitCode\\`, or \\`outputs.name\\`. Unset inputs auto-match same-name direct-upstream outputs. |\n| \\`default\\` | any | Fallback when no upstream value resolves. |\n| \\`required\\` | boolean | Inputs only. When true, unresolved values block the task before it starts. |\n\nNever write a bare task id as an input source. \\`from: controls\\` is invalid for "the controls task"; use \\`from: controls.limit\\` or \\`from: controls.outputs.limit\\`.\n\nOutput binding fields:\n\n| Field | Type | Notes |\n|---|---|---|\n| \\`value\\` | any | Literal output value. |\n| \\`from\\` | string | Defaults to \\`json.\u003coutputName\u003e\\`; also accepts \\`stdout\\`, \\`stderr\\`, or \\`normalizedOutput\\`. |\n| \\`default\\` | any | Fallback when the selected output source is missing. |\n\nUse optional \\`type\\`, \\`enum\\`, \\`description\\`, and \\`required\\` on the same \\`inputs\\` / \\`outputs\\` bindings when you need a stable typed public contract, type coercion, required downstream values, or prompt-task \\`[Inputs]\\` / \\`[Output Format]\\` blocks.\n\n### 12. Typed task bindings (\\`inputs\\` / \\`outputs\\`)\n\nTasks declare both lightweight and typed dataflow through task-level \\`inputs\\` and \\`outputs\\` maps. There is no separate \\`ports:\\` key; do not write it.\n\nEvery task can consume inputs and publish outputs:\n\n- \\`inputs\\` are values the task needs.\n- \\`outputs\\` are values the task produces.\n- Command tasks use inputs in \\`{{inputs.name}}\\`.\n- Prompt tasks receive inputs as context and produce outputs as structured JSON.\n- When names match, Tagma connects them automatically.\n- Use \\`from\\` only when you need to disambiguate, rename, or read raw streams.\n\nPrompt tasks infer their typed I/O contract automatically from direct-neighbor \\`command\\` tasks at runtime (see \\`inferPromptPorts\\`), and may also declare explicit \\`inputs\\` or \\`outputs\\` to add descriptions, aliases, or disambiguation. There is still no separate \\`ports:\\` key.\n\n\\`\\`\\`yaml\npipeline:\n  tracks:\n    - id: build\n      tasks:\n        - id: compile\n          command: \u0027bun run build\u0027\n          outputs:\n            bundlePath:\n              type: string\n              description: Absolute path to the built bundle\n        - id: test\n          command: \u0027bun test "{{inputs.bundlePath}}"\u0027\n          depends_on: [compile]\n          inputs:\n            bundlePath:\n              type: string\n              required: true\n\\`\\`\\`\n\n#### Binding shape\n\nEvery entry in \\`inputs\\` or \\`outputs\\` is keyed by its binding name:\n\n| Field | Type | Required | Notes |\n|---|---|---|---|\n| binding key | string | Yes | Identifier: \\`/^[A-Za-z_][A-Za-z0-9_]*$/\\` (letters, digits, underscores; starts with letter/underscore). **Hyphens are not allowed** because they break the \\`{{inputs.\u003cname\u003e}}\\` template grammar. |\n| \\`type\\` | \\`string\\` \\\\| \\`number\\` \\\\| \\`boolean\\` \\\\| \\`enum\\` \\\\| \\`json\\` | No | Drives runtime coercion when set. Omit it for lightweight pass-through values. |\n| \\`description\\` | string | No | Free-text; rendered into the \\`[Inputs]\\` / \\`[Output Format]\\` context blocks for AI tasks. |\n| \\`required\\` | boolean | No | **Inputs only.** When \\`true\\`, the task is blocked if the binding cannot resolve. Defaults to \\`false\\`. |\n| \\`default\\` | any | No | Fallback value when the selected source is missing. |\n| \\`enum\\` | string[] | When \\`type: enum\\` | Must be a non-empty array of strings. The coerced value must be one of these strings. |\n| \\`from\\` | string | No | Inputs select an upstream value; outputs select \\`json.\u003ckey\u003e\\`, \\`stdout\\`, \\`stderr\\`, or \\`normalizedOutput\\`. |\n\nDo not write \\`required\\` on outputs.\n\n#### Port types and coercion\n\n| Type | Accepted values | Coercion behaviour |\n|---|---|---|\n| \\`string\\` | strings, numbers, booleans | Numbers / booleans - \\`String(value)\\` |\n| \\`number\\` | finite numbers, numeric strings | Strings parsed via \\`Number()\\`; rejects \\`NaN\\` / \\`Infinity\\` |\n| \\`boolean\\` | booleans, \\`\u0027true\u0027\\` / \\`\u0027false\u0027\\` | String forms accepted |\n| \\`enum\\` | any value coerced to string, then matched against \\`enum\\` array | Rejects values not in the declared \\`enum\\` list |\n| \\`json\\` | any JSON-serializable value | No validation - accepts anything that survives JSON round-trip |\n\n#### Upstream binding (\\`from\\`)\n\nAn input binding can declare \\`from\\` to select which upstream task supplies the value:\n\n- **\\`from: "taskId.name"\\`** or **\\`from: "taskId.outputs.name"\\`** - look up that exact upstream task output. Use **\\`trackId.taskId.outputs.name\\`** only when the short task id would be ambiguous. The upstream must be a direct dependency listed in \\`depends_on\\`.\n- **\\`from: "outputs.name"\\`** - match by output name across direct upstream tasks. If two or more upstreams export the same name, the task is blocked with an "ambiguous" error.\n- **\\`from: "trackId.taskId.stdout"\\`**, \\`stderr\\`, \\`normalizedOutput\\`, or \\`exitCode\\` - read a raw task result field.\n- **No \\`from\\`** - first match a same-name output across direct upstream tasks. If none resolves, use \\`default\\`; otherwise a required input is blocked and an optional input resolves as absent.\n\n#### Placeholder substitution\n\nBefore a task runs, every \\`{{inputs.\\u003cname\\u003e}}\\` placeholder in \\`command\\` and \\`prompt\\` is replaced with the resolved input value:\n\n- strings - inserted as-is\n- numbers / booleans - \\`String(value)\\`\n- objects / arrays - \\`JSON.stringify(value)\\`\n- missing / null - empty string (and the engine logs a diagnostic)\n\n**Quote your placeholders in command lines:** \\`weather.sh --city "{{inputs.city}}"\\`. The engine does **not** shell-escape.\n\n#### AI prompt context blocks (prompt tasks only)\n\nWhen a prompt task has inferred or explicit typed bindings, the engine auto-injects two \\`PromptContextBlock\\`s **before** the task text and before any middleware-added context:\n\n1. **\\`[Output Format]\\`** - instructs the model to emit a final-line JSON object whose keys match the declared \\`outputs\\` names. Example: \\`{"summary": "...", "score": 42}\\`.\n2. **\\`[Inputs]\\`** - renders every resolved input as \\`name: value  # description\\` lines.\n\nTasks with no typed inferred bindings get neither block.\n\n#### Output extraction\n\nAfter a task succeeds, the engine extracts declared \\`outputs\\` from the task\u0027s output:\n\n1. Prefer \\`normalizedOutput\\` (AI drivers provide this) over raw \\`stdout\\`.\n2. Find the **last non-empty line** that parses as a JSON object.\n3. Read each declared output \\`name\\` as a key from that JSON object.\n4. Coerce each value to the declared \\`type\\`.\n\nIf extraction fails (no JSON object found, missing key, or type coercion fails), the engine appends a diagnostic to \\`stderr\\` and the port is absent from the task\u0027s \\`outputs\\`.\n\n#### Ports and \\`depends_on\\`\n\nPort resolution only considers **direct upstreams** - tasks explicitly listed in \\`depends_on\\`. A task cannot consume an output from a task it does not directly depend on. Conversely, a \\`depends_on\\` with no matching port flow is perfectly valid (ordering dependency only).\n\n## Companion `.layout.json` file (hard constraint)\n\nEvery pipeline YAML has a companion file in the same pipeline folder with the same stem and the extension `.layout.json` (e.g. `foo/foo.yaml` -\u003e `foo/foo.layout.json`). The editor persists task positions and track heights in this shape:\n\n```json\n{ "positions": { "\u003ctrackId\u003e.\u003ctaskId\u003e": { "x": 20, "y": 12 } }, "folders": [], "trackHeights": { "\u003ctrackId\u003e": 120 } }\n```\n\n- `positions` keys are fully qualified task ids: `trackId.taskId`.\n- `x` is the horizontal task position; optional `y` is the task top offset within its track.\n- Optional top-level `trackHeights` stores per-track pixel heights.\n- Optional top-level `folders` stores editor-only track grouping. Preserve `folders` and `trackHeights` unless tracks are renamed/deleted or the user explicitly asks to change grouping or lane height.\n\n### Placement tool\n\nDo not calculate task x positions by hand. After deciding the final YAML graph, call the custom OpenCode tool `tagma_placement_plan` and write its returned `positions` object into the sibling `.layout.json`, preserving any existing per-task `y`, `folders`, and `trackHeights` where the topology still matches.\n\nTool input shape:\n\n```json\n{\n  "tracks": [\n    {\n      "id": "track_id",\n      "tasks": [\n        { "id": "task_id", "depends_on": ["upstream.track"], "continue_from": "prior" }\n      ]\n    }\n  ]\n}\n```\n\nThe tool owns mechanical placement: first task starts at `x = 20`, same-track tasks are spaced safely, cross-track downstream tasks are pushed right for readable arrows, and topology changes trigger a fresh positions map. If the tool returns warnings, fix unresolved dependency refs in YAML first, then call the tool again.\n\n### Layout maintenance\n\nAlways keep `.layout.json` synchronized with YAML topology in the same turn.\n\n- For creates, missing layout, topology changes, two or more added tasks, dependency changes, or non-trivial add/rename/delete edits, call `tagma_placement_plan` with the final graph and replace the whole `positions` map with the returned value.\n- Preserve any existing `folders` array and `trackHeights` map unless affected tracks are renamed/deleted. Preserve per-task `y` values when keeping an existing task position.\n- For a pure task rename with unchanged topology, rename the existing `positions` key only when preserving the old position is better than a full reflow.\n- For task deletes, remove deleted position keys.\n- If the layout file is missing, create it from `tagma_placement_plan`.\n- If the tool returns warnings, fix dependency references before writing layout JSON.\n\n## Companion \\`.requirements.md\\` file (hard constraint)\n\nEvery pipeline YAML has a second companion file **in the same pipeline folder with the same stem and the extension \\`.requirements.md\\`** (e.g. \\`foo/foo.yaml\\` - \\`foo/foo.requirements.md\\`). This file documents the external dependencies (CLI tools, environment variables, accounts) the host machine needs to actually run the pipeline. Tagma\u0027s runtime preflight reads it before launching a run and refuses to start when a binary or required env var is missing - so keeping it accurate is what lets the user\u0027s pipeline survive a move to another machine.\n\nThe file has YAML frontmatter followed by Markdown body. **Ownership is split:**\n\n| Field | Owner | When written |\n|---|---|---|\n| frontmatter \\`schemaVersion\\` / \\`generatedFor\\` / \\`generatedAt\\` | editor (server) | every YAML save |\n| frontmatter \\`binaries:\\` | **editor (server)** - auto-generated from the YAML | every YAML save |\n| frontmatter \\`env:\\` | **you** | when you edit the YAML in ways that change env-var needs |\n| frontmatter \\`services:\\` | **you** | when you edit the YAML in ways that change service needs |\n| Entire markdown body | **you** | when you edit the YAML in ways that change CLI or env needs |\n\n**You never write the frontmatter \\`binaries:\\` list.** It is recomputed from the YAML on every save and any edit you make to it would be overwritten on the next compile. Touch frontmatter \\`env:\\` / \\`services:\\` and the markdown body only.\n\n### Maintenance rules (keep the pair in sync)\n\n- **Creating a new \\`*.yaml\\`**: the editor auto-creates \\`*.requirements.md\\` with placeholder \\`### \\\\\\`\u003cbinary\u003e\\\\\\`\\` sections containing \\`\u003c!-- TODO: install instructions --\u003e\\` markers. Replace each TODO marker in the same turn with real install commands grounded in the binary\u0027s official docs - at minimum one command for macOS, one for Linux, and one for Windows, plus a \\`Verify:\\` line. If you don\u0027t know the canonical install command, ask the user; do not invent one from general knowledge.\n- **Editing an existing \\`*.yaml\\` to add / rename / remove a task in ways that change which binaries the pipeline uses**: also edit the same-folder \\`\u003cstem\u003e/\u003cstem\u003e.requirements.md\\` body. The editor will resync the frontmatter \\`binaries:\\` list automatically; **you** add or remove the corresponding \\`### \\\\\\`\u003cbinary\u003e\\\\\\`\\` section in the body to match.\n- **Adding a task whose \\`command\\` invokes a new CLI** (e.g. adding \\`pytest -q\\`): add a \\`### \\\\\\`pytest\\\\\\`\\` section to the body in the same turn, with macOS / Linux / Windows install commands and a Verify line.\n- **Removing the last task that used a CLI**: remove the corresponding \\`### \\\\\\`\u003cbinary\u003e\\\\\\`\\` section from the body.\n- **Adding a task whose \\`prompt\\` resolves to a non-default driver** (e.g. \\`driver: claude-code\\`): the editor will add the driver\u0027s binary (e.g. \\`claude\\`) to the frontmatter. You add the body section telling the user how to install it. The built-in \\`opencode\\` driver does NOT need a body section - it\u0027s shipped with the editor.\n- **Adding a task that requires a secret environment variable** (e.g. an \\`ANTHROPIC_API_KEY\\` for a claude-code prompt task, or a credential for an API the command calls): add the variable name to the narrowest YAML \\`secrets:\\` scope that needs it, add it to frontmatter \\`env:\\` with \\`name\\`, \\`required: true\\` if the pipeline can\u0027t run without it, and a one-line \\`description\\`. Also list it under \\`## Environment\\` in the body. Never write the secret value.\n- **Renaming a \\`*.yaml\\`**: rename the same-folder \\`.requirements.md\\` to the new stem in the same turn (parallel to the \\`.layout.json\\` rule).\n- **Deleting a pipeline**: the editor removes the entire pipeline folder, taking \\`.requirements.md\\` with it; you do not need to delete it separately.\n- **First read**: always read the existing \\`.requirements.md\\` before editing it so you preserve install instructions the user may have customized.\n\n### Body shape\n\nThe body is plain Markdown. Stick to this structure so the editor\u0027s pre-run modal can parse it:\n\n\\`\\`\\`markdown\n# Requirements for \\`\u003cyamlBasename\u003e\\`\n\n## CLI tools\n\n### \\`\u003cbinary\u003e\\`\n\nUsed in: \\`\u003ctrackId\u003e.\u003ctaskId\u003e\\`, \\`hooks.\u003cevent\u003e\\`\n\n- macOS: \\`\u003cinstall command\u003e\\`\n- Ubuntu: \\`\u003cinstall command\u003e\\`\n- Windows: \\`\u003cinstall command\u003e\\`\n\nVerify: \\`\u003cbinary\u003e --version\\`\n\n## Environment\n\n| Variable | Required | Notes |\n|---|---|---|\n| \\`\u003cVAR_NAME\u003e\\` | yes | \u003creason\u003e |\n\\`\\`\\`\n\nThe editor\u0027s pre-run "requirements missing" modal renders each \\`### \\\\\\`\u003cbinary\u003e\\\\\\`\\` section verbatim when that binary fails the preflight, so write the install commands as copy-pasteable shell snippets.\n\n## YAML compilation feedback (read after every write)\n\nEvery time you create or modify a \\`*.yaml\\` file, the editor automatically compiles it and writes validation results to a companion file **in the same pipeline folder** with the same stem and the extension \\`.compile.log\\` (e.g. \\`foo/foo.yaml\\` - \\`foo/foo.compile.log\\`).\n\n**You must read this file after every YAML write** and act on its contents:\n\n1. If \\`success\\` is \\`false\\`, fix the reported errors before ending your turn. The \\`validation.errors\\` array tells you exactly what is wrong and where (\\`path\\` is a JSONPath-style location like \\`tracks[0].tasks[1].prompt\\`).\n2. If \\`validation.warnings\\` is non-empty, evaluate whether they indicate real problems. Warnings about missing plugin types ("... is not registered") mean the user needs to install a plugin - tell them, don\u0027t invent the type.\n3. If \\`parseOk\\` is \\`false\\`, the YAML is malformed (not just invalid). Re-read the file you just wrote to see what went wrong.\n\n**When the compile log contradicts your own knowledge or assumptions, the compile log is the ground truth.** The validator runs against the exact schema and registry the editor uses at runtime; your training data may reflect older rules or different configurations. Always trust the compile log over your own intuition.\n\nDo not finish until you have read the compile log and confirmed \\`success: true\\` (or only warnings you have explicitly decided are acceptable).\n\nNever write to \\`.compile.log\\` yourself - it is owned by the editor.\n\n## Hard constraints - do not violate\n\n- Pipeline files live at `\u003cstem\u003e/\u003cstem\u003e.yaml` inside `.tagma/`. Never create `.tagma/\u003cfile\u003e.yaml` flat at the top level, never nest deeper than one level, and never let the folder basename diverge from the YAML stem.\n- Reserved directory names under `.tagma/` (`logs`, `plugin-runtime`, `plugin-store`, `node_modules`, anything starting with `.`) are never valid pipeline stems.\n- Companion files (`.layout.json`, `.compile.log`, `.requirements.md`) always live inside the same pipeline folder as their YAML and share its stem.\n- Never write, edit, rename, or delete a path that resolves outside `\u003cworkspace\u003e/.tagma/`.\n- Never drop existing top-level `folders` or `trackHeights` from `.layout.json` when rewriting `positions`, and preserve per-task `y` when a task remains in the same track.\n- Never hand-calculate `.layout.json` task positions. Use `tagma_placement_plan` for creates, topology changes, missing layout files, and non-trivial task add/rename/delete edits.\n- Never write the frontmatter `binaries:` field of any `.requirements.md` file.\n- Never let YAML and requirements drift: when a task adds/removes a CLI, non-default driver, required secret/env var, or external service, update the same-folder requirements body/env/services and YAML \\`secrets:\\` declaration in the same turn.\n- Never invent install commands for a CLI. Ground every install line in official docs or explicit user instruction; otherwise leave the TODO and ask.\n- Never give two prompt tasks in the same track different driver, model, agent_profile, permissions, or middleware needs. Split prompt tracks by agent identity.\n- Never set driver/model/reasoning_effort/agent_profile/middlewares/permissions on command-only tracks; the command path ignores them.'
    .concat(
      '\n\n## Trigger path boundary\n\n' +
        'file/directory trigger watch paths may be absolute or outside the workspace; ' +
        'authoring the reference is allowed without reading or writing that external path.\n' +
        'This exception does not apply to cwd, static_context.file, or file_exists.path.',
    )
    .split('\\`')
    .join('`')
    .replace(
      'The whole config lives under a single top-level `pipeline:` key. A document\nwithout that wrapper is rejected with `YAML must contain a top-level\n"pipeline" key`.\n\n```yaml',
      'The whole config lives under a single top-level `pipeline:` key. A document\nwithout that wrapper is rejected with `YAML must contain a top-level\n"pipeline" key`.\n\n`pipeline.requires.sdk` is SDK-owned compatibility metadata. Do not guess or\nhand-write a minimum SDK version unless the user explicitly asks for a higher\nruntime floor. The editor/SDK serializer infers the minimum from the final YAML\nfeatures and preserves existing higher requirements.\n\n```yaml',
    );
}

export function buildTagmaNativePrimitivesSkill(): string {
  return `---
name: tagma-native-primitives
description: Use when authoring or editing any Tagma YAML pipeline. Prefer native Tagma YAML primitives and native OpenCode behavior for command and prompt tasks before helper scripts or custom orchestration.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this before creating or materially editing a Tagma pipeline.

## Native primitive priority

Use Tagma YAML fields before helper scripts or custom tool creation:

1. command or prompt
2. depends_on and continue_from
3. cwd and timeout
4. trigger and completion
5. inputs and outputs
6. hooks
7. permissions, on_failure, driver, model, reasoning_effort

## YAML contract

- The root object is \`pipeline:\` with non-empty \`name\` and \`tracks\`.
- Tracks require \`id\`, \`name\`, and non-empty \`tasks\`.
- Tasks require \`id\` and exactly one non-empty \`prompt\` or \`command\`.
- \`prompt\` tasks are for AI work. They may use driver/model/reasoning_effort,
  agent_profile, middlewares, permissions, and continue_from.
- \`command\` tasks run exact shell commands. Do not put AI-only fields or
  continue_from on command tasks.
- Task and track ids must start with a letter or underscore and contain only
  letters, digits, underscores, or hyphens.
- Prefer fully qualified dependency refs (\`trackId.taskId\`) whenever a bare id
  could be ambiguous.
- Use \`inputs\` / \`outputs\` maps for dataflow. There is no \`ports:\` key and no
  task-level \`env:\` field.
- Quote \`{{inputs.name}}\` placeholders inside command strings; Tagma does not
  shell-escape substituted values.
- After every YAML write, read the same-folder \`.compile.log\`; the validator is
  the source of truth for detailed schema errors.

## Command tasks

- Use command for deterministic shell work where the exact command is known.
- Match the command dialect to Tagma's actual host shell contract:
${WINDOWS_COMMAND_AUTHORING_CONTRACT}
- On macOS and Linux, plain \`command\` strings and \`{ shell: ... }\` commands run under \`sh -c\` by default; use POSIX shell syntax unless the user explicitly configures \`PIPELINE_SHELL\`.
- Ground every command in user input, existing YAML, package scripts, README or CI docs, or another workspace file you read.
- Do not wrap deterministic shell work in a prompt task.
- Do not invent npm test, bun test, pytest, cargo test, deploy, migration, or release commands from general knowledge.
- If a command needs a value from an upstream task, use inputs and the native inputs.name placeholder instead of generating a custom templating script.
- For shell glue inside command strings, prefer the current host OS native command language first, then Python. Use Python only when native commands cannot express the work cleanly or would make the command bulky or fragile.

## Prompt tasks

- Use prompt when the work requires an AI to decide, write, review, summarize, diagnose, or edit.
- Put permission intent on the prompt task: read-only for planning/review, write for editing, execute only when the runtime agent truly needs tools or tests.
- In the prompt text, tell the runtime OpenCode agent to use native file/search/edit/bash tools, native subagents, approved skills, and the host-native-command-then-Python rule before creating ad hoc scripts.
- Keep prompt tasks bounded: state the target files, expected output, acceptance criteria, and what native checks to run when execute permission is granted.

## Plugins

Use only plugin types present in the current editor context. If a requested driver, trigger, completion, or middleware type is missing, do not invent it. Use installed native Tagma primitives, a manual trigger, or tell the user which plugin capability is missing.
`;
}

export function buildTagmaPlanDelegateSkill(): string {
  return `---
name: tagma-plan-delegate
description: Use for multi-step Tagma pipeline design, lifecycle workflows, ordered stages, parallel tracks, dependency planning, plan stress tests, requirements interviews, and bounded read-only OpenCode subagent lookups.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this for new multi-step pipelines, significant restructures, or requests with multiple independent workstreams.

## Design decision interview

Use this protocol when the user wants to stress-test, challenge, or clarify a plan or design before YAML is written.

1. Build a decision tree from the plan: goals, inputs, outputs, task graph, ordering, track identity, permissions, triggers, verification, failure handling, and operational risks.
2. Resolve dependencies in order. Do not ask about a downstream choice until its upstream premise is settled.
3. If a question can be answered by reading the workspace, use explore or direct read-only inspection instead of asking the user.
4. Ask exactly one question at a time.
5. For each question, include your recommended answer and why it fits the current evidence.
6. After the user answers, restate the resolved decision briefly, update the remaining branches, and continue until no material ambiguity remains.
7. Stop the interview with a compact shared-understanding summary before writing or editing YAML.

## Lifecycle

1. Classify the user intent: create new pipeline, edit current pipeline, or edit named pipeline.
2. Identify blocking unknowns. Ask only when the missing choice materially changes the pipeline. Otherwise use workspace evidence and conservative defaults.
3. Gather evidence. Use native OpenCode explore for read-only repository mapping and package-script discovery. Use scout only for external docs.
4. Split the workflow into lifecycle stages: prepare, analyze, execute, verify, report, cleanup.
5. Decide track boundaries by agent identity, not by parallelism.
   - Group prompt tasks that share a driver, model, agent_profile, permission tier, and middleware stack into one track; split tracks when any of those need to change.
   - For command-dominant work, use tracks as cwd / on_failure groups and as visual lanes that keep cross-track edges readable. Do not put AI fields (driver, model, agent_profile, reasoning_effort, middlewares, permissions) on a command-only track - the engine ignores them and they mislead readers.
   - Same-track tasks already run in parallel unless they share a depends_on chain. Never open a new track just to express "these run in parallel."
   - Convert true ordering constraints into depends_on edges, regardless of which tracks the tasks sit on.
6. Choose command vs prompt per task using tagma-native-primitives.
7. Add completions, triggers, timeouts, permissions, on_failure, and layout after the task graph is clear.
8. Write YAML and layout, then run the compile-log repair loop.

## Delegation rules

- Delegate only read-only lookup to explore or scout.
- Keep YAML/layout/requirements writes in the pipeline create/edit agents, and only inside the workspace .tagma directory.
- Do not create one giant prompt task for a whole workflow when lifecycle stages can be represented as native Tagma tasks.
- Do not create artificial dependencies just to make the diagram linear. Parallel work should stay parallel.
`;
}

export function buildTagmaTriggerStrategySkill(): string {
  return `---
name: tagma-trigger-strategy
description: Use when a user asks to run, start, schedule, automate, trigger, gate, or make a Tagma pipeline runnable. Choose native trigger/completion/plugin strategy without claiming chat can press Run.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this when the user asks about running now, scheduling later, automation, recurrence, webhook/file/directory/manual triggers, approval gates, or making a pipeline easy to launch.

## Boundary

The chat authoring agent writes YAML. It does not press the editor Run button, call run APIs, or create scheduler infrastructure by itself. Its job is to make the pipeline runnable by the editor, user, or installed trigger plugins.

## Trigger strategy

1. If the user only wants a normal runnable pipeline, omit task triggers and rely on the editor's Run action.
2. If a task needs planned approval, use the native manual trigger on that task.
3. If a task should wait for a local or external file artifact, use the native file trigger.
4. If a task should wait until a local or external folder is created, use the native directory trigger.
5. If an external system should start or unblock work, use a webhook or similar trigger only when it appears in the current editor context plugins list.
6. If the user asks for cron, recurring, delayed, or calendar scheduling, use a schedule/cron trigger only when that installed plugin appears in editor context. If no such plugin is listed, do not invent it; write a manual/file/directory-triggered pipeline and tell the user which trigger capability is missing.
7. Pair non-trivial triggers with explicit timeout values and meaningful completion checks so a scheduled or unattended run can fail clearly.
8. file/directory trigger watch paths may be absolute or outside the workspace; authoring the reference is allowed without reading or writing that external path.

## Wording

When the user says "run this", author and validate the pipeline, then say it is ready to run in the editor. Do not imply that YAML authoring itself executed the pipeline.
`;
}

export function buildTagmaExecutionResilienceSkill(): string {
  return `---
name: tagma-execution-resilience
description: Use when a generated pipeline should include native Tagma verification, bounded retry, diagnostic, or self-healing stages using on_failure, stderr inputs, and explicit retry tasks.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this when the user asks for robust execution, self-healing, retry, repair, build/test verification, or failure diagnosis.

## Native resilience patterns

- Prefer a fast preflight command before expensive AI or deploy work.
- Use timeout on long-running command and prompt tasks.
- Use track on_failure intentionally:
  - skip_downstream for normal fail-fast dependencies.
  - ignore when a downstream diagnostic or repair task must still run after a failed upstream.
  - stop_all only for dangerous failures that should abort every track.
- Use task inputs from direct upstream raw fields for diagnostics: taskId.stderr, taskId.stdout, taskId.exitCode, and taskId.normalizedOutput.

## Bounded self-healing pattern

Represent retry as explicit finite stages. Do not imply an unbounded loop.

1. Run a command verification task.
2. Put it on a track with on_failure: ignore if a downstream repair task must inspect failure output.
3. Add a prompt repair task depending on the verifier. Give it inputs from verifier.stderr and verifier.exitCode. Give write and execute permissions only if it must edit and rerun tools.
4. Add a retry command task depending on the repair task.
5. Stop after one or two explicit repair/retry rounds unless the user requested more.

## Human fallback

If the failure depends on missing credentials, external access, destructive changes, or an unclear product decision, use tagma-human-safety and a manual trigger instead of guessing.
`;
}

export function buildTagmaLocalToolsSkill(): string {
  return `---
name: tagma-local-tools
description: Use when native Tagma fields, installed plugins, and host-native commands are insufficient, and a small per-pipeline Python helper inside .tagma can safely bridge the gap without new dependencies.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this only after tagma-native-primitives cannot express the need with command, prompt, inputs, outputs, completion, trigger, middleware, hooks, an installed plugin, or a host-native command task.

## Decision order

1. Use an installed plugin type from editor context if it exists.
2. Use an existing workspace command or script if evidence supports it.
3. Use a native command task with inputs and outputs.
4. Use a tiny Python helper under tools/<pipeline-name>/ only when native commands cannot express the work cleanly or would make the command bulky or fragile.
5. Use tools/shared/ only when the user explicitly wants a reusable shared helper.
6. If the integration is complex, stateful, interactive, or requires an unavailable service plugin, use a manual trigger or tell the user which plugin capability is missing.

## Helper constraints

- Write helpers only under the current .tagma directory.
- Do not add package dependencies.
- Use Python for new per-pipeline helpers. Do not create new Node, Bun, JavaScript, or TypeScript helpers unless the user explicitly asks.
- Call Python through a configured or detected interpreter command. If no Python command is known, ask or document the requirement instead of guessing.
- Shape helpers as narrow functions plus a CLI entrypoint. Test the functions before wiring them into command tasks.
- Prefer CLI-style helpers for stateless, idempotent work where process isolation and zero idle resource use matter. Consider a local host server only for stateful interactive sessions, shared in-memory context, or high-frequency execution where a warm process is worth the complexity.
- Keep helpers deterministic and narrow. They should transform files, validate output, or bridge a small API shape, not become a hidden workflow engine.
- Do not store secrets in helper scripts, YAML, arguments, logs, or memory files.
- Command tasks should call helpers through explicit commands grounded in workspace evidence or the helper file you just wrote.
`;
}

export function buildTagmaHumanSafetySkill(): string {
  return `---
name: tagma-human-safety
description: Use for Tagma pipelines that need human approval, missing information, secret handling, destructive-operation safety, cost caps, or controlled failure behavior.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this for approvals, secrets, missing credentials, destructive commands, deploys, migrations, billing-heavy work, or any task that should pause for a human decision.

## Human-in-the-loop

- Use the native manual trigger for planned approval points.
- Put the manual trigger immediately before the task that needs the decision.
- Make the trigger message specific: what is needed, why it blocks, and what happens after approval.
- If a secret is needed, ask for an environment variable name or external setup instruction, not the secret value.

## Secrets

- Never write API keys, tokens, passwords, cookies, private keys, or bearer headers into YAML, helper scripts, memory files, logs, or prompt text.
- The secure path is user-managed: declare only environment variable names in YAML \`secrets:\`, then tell the user which variable to add in Settings -> Secrets Manager and which YAML pipeline to bind it to.
- Put \`secrets:\` at the narrowest scope that needs the value: task first, track if several tasks share it, pipeline only if almost every task needs it.
- Commands should read secrets from the process environment (Windows: \`$env:NAME\`, POSIX: \`$NAME\`); helpers should read their language's env API such as \`process.env.NAME\`.
- Do not configure secret values for the user, edit .tagma/secrets.json, call secret-manager APIs, or suggest .env files for pipeline secrets.

## Safety and cost

- Add timeout to long-running tasks.
- Prefer skip_downstream for ordinary dependency failures and stop_all only for true kill-switch failures.
- Do not add git stash, reset, checkout, clean, delete, migration, deploy, or publish commands unless the user asked for that workflow and workspace evidence supports the exact command.
- Current YAML can model lifecycle hooks, but it cannot guarantee a full snapshot/rollback API by itself. Do not pretend that hook-based rollback is equivalent to an engine-level snapshot.

## Best-effort rollback pattern

Use this only when the user explicitly asks for rollback/snapshot behavior and the workspace is known to be a git repository.

- Put a manual trigger before the first risky write, deploy, migration, publish, or cleanup task.
- Use short pipeline_start and pipeline_error hooks for best-effort snapshot and rollback commands, or call tiny helper scripts under .tagma/tools/<pipeline-name>/ when the shell needs more than one simple command.
- Prefer a preflight that refuses to continue on unexpected dirty state unless the user explicitly asked to include existing work.
- If using git stash, make the stash label pipeline-specific and document that rollback is best-effort. Do not use git reset, git clean, or destructive restore commands unless the user explicitly gave that exact strategy.
- Remember hooks have a short timeout and are not transactional. Say so when presenting the pipeline.
`;
}

export function buildTagmaMemoryContextSkill(): string {
  return `---
name: tagma-memory-context
description: Use for pipelines that need durable project lessons, large-log summarization, compact cross-task handoffs, or static_context wiring without exhausting the model context.
compatibility: opencode
metadata:
  owner: tagma
---

## When to use

Load this when a workflow should remember lessons, reuse prior project knowledge, summarize noisy outputs, or keep prompt context small.

## Memory

- Prefer .tagma/memory/ for durable Tagma-specific notes.
- Read only relevant memory files; do not bulk-load the directory.
- Add or update memory only when the user asks for durable memory or when the pipeline explicitly includes a learning/reporting stage.
- Keep memory short, factual, and source-linked to the pipeline/run context when possible.

## Context budgeting

- Prefer task outputs and concise summaries over long continue_from chains.
- Use static_context with max_chars when a prompt task needs a bounded reference file.
- Add summarizer prompt tasks after noisy commands when downstream tasks need only the conclusion, not the whole log.
- For prompt task outputs, request final-line JSON that matches declared outputs so downstream tasks can consume structured values.
- Do not pass entire stderr logs into multiple downstream prompts. One diagnostic prompt should summarize, then later tasks consume that summary.
`;
}

export function buildTagmaYamlSkeletonTool(): string {
  return `import { tool } from "@opencode-ai/plugin";

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function sectionIdWithoutPrefix(section, prefix) {
  const id = asString(section.id);
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function trackSectionId(section) {
  return asString(section.track, sectionIdWithoutPrefix(section, "track:")) || "main";
}

function taskSectionIds(section) {
  const raw = sectionIdWithoutPrefix(section, "task:");
  const dot = raw.indexOf(".");
  return {
    trackId: asString(section.track, dot > 0 ? raw.slice(0, dot) : ""),
    taskId: asString(section.task, dot > 0 ? raw.slice(dot + 1) : raw) || "task",
  };
}

function addBindingMap(lines, indent, key, names) {
  if (names.length === 0) return;
  lines.push(indent + key + ":");
  for (const name of names) lines.push(indent + "  " + name + ": {}");
}

function buildTask(section) {
  const taskId = taskSectionIds(section).taskId;
  const isCommand = section.type === "command";
  const summary = asString(section.summary);
  const body =
    summary && summary !== taskId
      ? summary
      : "TODO: define " + (isCommand ? "command" : "prompt") + " for " + taskId;
  return {
    id: taskId,
    name: summary && summary !== taskId ? summary : "",
    field: isCommand ? "command" : "prompt",
    body,
    depends_on: asStringArray(section.depends_on),
    inputs: asStringArray(section.inputs),
    outputs: asStringArray(section.outputs),
  };
}

function buildYamlSkeleton(manifest) {
  const root = asRecord(manifest);
  const pipeline = asRecord(root.pipeline);
  const sections = Array.isArray(root.sections) ? root.sections.map(asRecord) : [];
  const pipelineName = asString(pipeline.name, "Untitled Pipeline");
  const trackSections = sections.filter((section) => section.type === "track");
  const tasksByTrack = new Map();

  for (const section of sections) {
    if (section.type !== "command" && section.type !== "prompt" && section.type !== "unknown") {
      continue;
    }
    const trackId = taskSectionIds(section).trackId;
    if (!trackId) continue;
    const list = tasksByTrack.get(trackId) || [];
    list.push(buildTask(section));
    tasksByTrack.set(trackId, list);
  }

  const tracks =
    trackSections.length > 0
      ? trackSections.map((section) => {
          const trackId = trackSectionId(section);
          return {
            id: trackId,
            name: asString(section.summary, trackId),
            tasks: tasksByTrack.get(trackId) || [],
          };
        })
      : [{ id: "main", name: "Main", tasks: [] }];

  const lines = ["pipeline:", "  name: " + yamlString(pipelineName), "  tracks:"];
  for (const track of tracks) {
    lines.push("    - id: " + yamlString(track.id));
    lines.push("      name: " + yamlString(track.name));
    lines.push("      tasks:");
    const tasks = track.tasks.length > 0 ? track.tasks : [{ id: "placeholder", field: "prompt", body: "TODO: add tasks", depends_on: [], inputs: [], outputs: [] }];
    for (const task of tasks) {
      lines.push("        - id: " + yamlString(task.id));
      if (task.name) lines.push("          name: " + yamlString(task.name));
      lines.push("          " + task.field + ": " + yamlString(task.body));
      if (task.depends_on.length > 0) {
        lines.push("          depends_on:");
        for (const dep of task.depends_on) lines.push("            - " + yamlString(dep));
      }
      addBindingMap(lines, "          ", "inputs", task.inputs);
      addBindingMap(lines, "          ", "outputs", task.outputs);
    }
  }
  return lines.join("\\n") + "\\n";
}

export default tool({
  description: "Generate a Tagma YAML skeleton from a pipeline manifest.",
  args: {
    manifest: tool.schema
      .object({
        pipeline: tool.schema.object({ name: tool.schema.string().optional() }),
        sections: tool.schema.array(
          tool.schema.object({
            id: tool.schema.string(),
            type: tool.schema.string(),
            summary: tool.schema.string().optional(),
            track: tool.schema.string().optional(),
            task: tool.schema.string().optional(),
            depends_on: tool.schema.array(tool.schema.string()).optional(),
            inputs: tool.schema.array(tool.schema.string()).optional(),
            outputs: tool.schema.array(tool.schema.string()).optional(),
          }),
        ),
      })
      .describe("Pipeline manifest object previously written to <stem>/<stem>.manifest.json"),
  },
  async execute(args) {
    return JSON.stringify({ yaml: buildYamlSkeleton(args.manifest) }, null, 2);
  },
});
`;
}

export function buildTagmaPlacementTool(): string {
  return `import { tool } from "@opencode-ai/plugin";

const PAD_LEFT = 20;
const SAME_TRACK_STEP = 280;
const CROSS_TRACK_STEP = 340;
const TASK_WIDTH = 176;
const CROSS_TRACK_HEADROOM_PER_TRACK = 128;

function qid(trackId, taskId) {
  return \`\${trackId}.\${taskId}\`;
}

function resolveTaskRef(ref, currentTrackId, taskByQid, bareIndex) {
  if (ref.includes(".")) return taskByQid.has(ref) ? ref : null;
  const sameTrack = qid(currentTrackId, ref);
  if (taskByQid.has(sameTrack)) return sameTrack;
  const matches = bareIndex.get(ref) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function requiredStep(fromTrackIndex, toTrackIndex) {
  const trackGap = Math.abs(toTrackIndex - fromTrackIndex);
  if (trackGap === 0) return SAME_TRACK_STEP;
  return Math.max(CROSS_TRACK_STEP, TASK_WIDTH + CROSS_TRACK_HEADROOM_PER_TRACK * trackGap + 24);
}

function computePlacement(input) {
  const taskByQid = new Map();
  const bareIndex = new Map();
  const warnings = [];

  input.tracks.forEach((track, trackIndex) => {
    track.tasks.forEach((task, order) => {
      const id = qid(track.id, task.id);
      taskByQid.set(id, { trackId: track.id, trackIndex, order });
      bareIndex.set(task.id, [...(bareIndex.get(task.id) ?? []), id]);
    });
  });

  const depsByTask = new Map();
  input.tracks.forEach((track) => {
    track.tasks.forEach((task) => {
      const id = qid(track.id, task.id);
      const refs = [...(task.depends_on ?? [])];
      if (task.continue_from) refs.push(task.continue_from);
      const deps = [];
      for (const ref of refs) {
        const resolved = resolveTaskRef(ref, track.id, taskByQid, bareIndex);
        if (resolved) deps.push(resolved);
        else warnings.push(\`Could not resolve dependency "\${ref}" for \${id}\`);
      }
      depsByTask.set(id, deps);
    });
  });

  const positions = new Map();
  for (const id of taskByQid.keys()) positions.set(id, PAD_LEFT);
  const orderedQids = input.tracks.flatMap((track) => track.tasks.map((task) => qid(track.id, task.id)));

  for (let pass = 0; pass < Math.max(1, orderedQids.length); pass += 1) {
    let changed = false;
    for (const id of orderedQids) {
      const meta = taskByQid.get(id);
      if (!meta) continue;
      let nextX = positions.get(id) ?? PAD_LEFT;
      for (const dep of depsByTask.get(id) ?? []) {
        const upstream = taskByQid.get(dep);
        if (!upstream) continue;
        const minX = (positions.get(dep) ?? PAD_LEFT) + requiredStep(upstream.trackIndex, meta.trackIndex);
        if (minX > nextX) nextX = minX;
      }
      if (nextX !== positions.get(id)) {
        positions.set(id, nextX);
        changed = true;
      }
    }
    for (const track of input.tracks) {
      let previousX = null;
      for (const task of track.tasks) {
        const id = qid(track.id, task.id);
        const currentX = positions.get(id) ?? PAD_LEFT;
        const nextX = previousX === null ? currentX : Math.max(currentX, previousX + SAME_TRACK_STEP);
        if (nextX !== currentX) {
          positions.set(id, nextX);
          changed = true;
        }
        previousX = nextX;
      }
    }
    if (!changed) break;
  }

  return {
    positions: Object.fromEntries([...positions.entries()].map(([id, x]) => [id, { x: Math.round(x) }])),
    warnings,
  };
}

export default tool({
  description: "Compute deterministic Tagma .layout.json positions for a pipeline graph.",
  args: {
    tracks: tool.schema
      .array(
        tool.schema.object({
          id: tool.schema.string().describe("Track id"),
          tasks: tool.schema.array(
            tool.schema.object({
              id: tool.schema.string().describe("Task id"),
              depends_on: tool.schema.array(tool.schema.string()).optional(),
              continue_from: tool.schema.string().optional(),
            }),
          ),
        }),
      )
      .describe("Final YAML graph after the intended edit"),
  },
  async execute(args) {
    return JSON.stringify(computePlacement(args), null, 2);
  },
});
`;
}

export function buildTagmaTrialPlanTool(): string {
  return `import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";

const REQUIRED_COVERAGE = [
  "multiple-inputs",
  "duplicate-input-names",
  "multiline-content",
  "output-collision",
  "repeat-run",
  "empty-content",
  "special-characters",
];

function resolvePipelinePath(input, root) {
  const normalized = String(input || "").trim().replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  const parts = normalized.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("pipeline_path must be <stem>/<stem>.yaml inside the active pipeline root");
  }
  const yamlName = parts[1];
  const stem = yamlName.replace(/\\.ya?ml$/i, "");
  if (!/\\.ya?ml$/i.test(yamlName) || parts[0] !== stem) {
    throw new Error("pipeline_path folder and YAML stem must match");
  }
  const yamlPath = resolve(root, ...parts);
  const rel = relative(root, yamlPath);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\\\")) {
    throw new Error("pipeline_path escaped the active pipeline root");
  }
  const stat = lstatSync(yamlPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("pipeline_path must be a regular file");
  if (basename(dirname(yamlPath)) !== stem) throw new Error("pipeline_path has an invalid folder");
  return yamlPath;
}

function validateCoverage(coverage, cases) {
  const caseIds = new Set(cases.map((item) => item.id));
  const seen = new Set();
  for (const item of coverage) {
    if (!REQUIRED_COVERAGE.includes(item.dimension)) {
      throw new Error("unsupported coverage dimension: " + item.dimension);
    }
    if (seen.has(item.dimension)) throw new Error("duplicate coverage dimension: " + item.dimension);
    seen.add(item.dimension);
    if (item.status === "covered") {
      if (!item.caseIds || item.caseIds.length === 0) {
        throw new Error("covered dimension must reference a case: " + item.dimension);
      }
      for (const caseId of item.caseIds) {
        if (!caseIds.has(caseId)) throw new Error("coverage references unknown case: " + caseId);
      }
    }
  }
  for (const dimension of REQUIRED_COVERAGE) {
    if (!seen.has(dimension)) throw new Error("missing coverage dimension: " + dimension);
  }
}

export default tool({
  description: "Write a hash-bound targeted trial plan after the final YAML compile succeeds.",
  args: {
    pipeline_path: tool.schema.string().describe("Relative <stem>/<stem>.yaml path"),
    summary: tool.schema.string(),
    goals: tool.schema.array(tool.schema.string()),
    coverage: tool.schema.array(
      tool.schema.object({
        dimension: tool.schema.string(),
        status: tool.schema.string(),
        caseIds: tool.schema.array(tool.schema.string()),
        rationale: tool.schema.string(),
      }),
    ),
    findings: tool.schema.array(
      tool.schema.object({
        severity: tool.schema.string(),
        summary: tool.schema.string(),
        evidence: tool.schema.string(),
      }),
    ),
    cases: tool.schema.array(
      tool.schema.object({
        id: tool.schema.string(),
        title: tool.schema.string(),
        objective: tool.schema.string(),
        runs: tool.schema.number().optional(),
        targetTaskIds: tool.schema.array(tool.schema.string()).optional(),
        fixtures: tool.schema.array(
          tool.schema.object({ path: tool.schema.string(), content: tool.schema.string() }),
        ),
        expectations: tool.schema.array(
          tool.schema.object({
            type: tool.schema.string(),
            path: tool.schema.string().optional(),
            text: tool.schema.string().optional(),
            suffix: tool.schema.string().optional(),
            min: tool.schema.number().optional(),
            max: tool.schema.number().optional(),
            taskId: tool.schema.string().optional(),
            status: tool.schema.string().optional(),
          }),
        ),
      }),
    ),
  },
  async execute(args, context) {
    if (!Array.isArray(args.cases) || args.cases.length === 0 || args.cases.length > 8) {
      throw new Error("trial plan requires 1-8 targeted cases");
    }
    validateCoverage(args.coverage, args.cases);
    const root = resolve(context.directory);
    const yamlPath = resolvePipelinePath(args.pipeline_path, root);
    const yamlHash = createHash("sha1").update(readFileSync(yamlPath, "utf8")).digest("hex");
    const planPath = yamlPath.replace(/\\.ya?ml$/i, ".trial-plan.json");
    const plan = {
      version: 1,
      yamlHash,
      summary: args.summary,
      goals: args.goals,
      coverage: args.coverage,
      findings: args.findings,
      cases: args.cases,
    };
    const tempPath = planPath + "." + randomUUID() + ".tmp";
    writeFileSync(tempPath, JSON.stringify(plan, null, 2) + "\\n", "utf8");
    renameSync(tempPath, planPath);
    return JSON.stringify({ path: relative(root, planPath).replace(/\\\\/g, "/"), yamlHash }, null, 2);
  },
});
`;
}

const TAGMA_OPENCODE_SKILLS = [
  ['tagma-yaml-contract', buildTagmaYamlContractSkill],
  ['tagma-native-primitives', buildTagmaNativePrimitivesSkill],
  ['tagma-plan-delegate', buildTagmaPlanDelegateSkill],
  ['tagma-trigger-strategy', buildTagmaTriggerStrategySkill],
  ['tagma-execution-resilience', buildTagmaExecutionResilienceSkill],
  ['tagma-local-tools', buildTagmaLocalToolsSkill],
  ['tagma-human-safety', buildTagmaHumanSafetySkill],
  ['tagma-memory-context', buildTagmaMemoryContextSkill],
] as const;

function hostOsLabel(): string {
  // Match the labels the agent prompt documents (`windows`, `darwin`, `linux`).
  // Node reports `win32` on Windows; remap so the prompt's OS-specific guidance
  // keys cleanly. Other platforms (e.g. `freebsd`) fall through as-is.
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

function seedFile(targetDir: string, filename: string, content: string): boolean {
  const fullPath = join(targetDir, filename);
  let existing: string | null = null;
  try {
    existing = readFileSync(fullPath, 'utf8');
  } catch {
    // Missing file - fall through and write.
  }
  if (existing === content) return false;
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  return true;
}

// OpenCode scans both `.opencode/agent/` (legacy singular) and
// `.opencode/agents/` (current plural). We standardize on the plural path
// only; `pruneStaleAgentFiles` removes any singular-dir copy and renamed-away
// agents so a workspace seeded by an older editor converges cleanly.
const ACTIVE_AGENT_FILES = [
  `${TAGMA_ROUTER_AGENT}.md`,
  `${TAGMA_PIPELINE_AGENT}.md`,
  `${TAGMA_PIPELINE_DIAGNOSIS_AGENT}.md`,
  `${TAGMA_GENERAL_DISCUSSION_AGENT}.md`,
  `${TAGMA_HISTORY_COMPARE_AGENT}.md`,
  `${TAGMA_YAML_REVIEW_AGENT}.md`,
  `${TAGMA_PIPELINE_PLANNER_AGENT}.md`,
  `${TAGMA_COMMAND_EVIDENCE_AGENT}.md`,
  `${TAGMA_RUNTIME_GUARD_AGENT}.md`,
  `${TAGMA_CONTEXT_PACKAGER_AGENT}.md`,
  `${TAGMA_PIPELINE_SECTION_BUILDER_AGENT}.md`,
  'tagma-python-tools.md',
] as const;

// Agent files earlier editor versions seeded that no longer exist. OpenCode
// would still discover them as selectable agents, so we delete them from both
// the singular and plural agent dirs.
const STALE_AGENT_FILES = [
  'tagma-pipeline-create.md',
  'tagma-pipeline-edit.md',
  'tagma-yaml.md',
] as const;

export function applyOpencodeAgentMaxSteps(content: string, requestedSteps: number): string {
  const steps = Number.isFinite(requestedSteps)
    ? clampOpencodeAgentMaxSteps(requestedSteps)
    : DEFAULT_OPENCODE_AGENT_MAX_STEPS;
  if (!content.startsWith('---\n')) {
    throw new Error('OpenCode agent document must start with YAML frontmatter');
  }
  const closingFrontmatter = content.indexOf('\n---', 4);
  if (closingFrontmatter < 0) {
    throw new Error('OpenCode agent document is missing closing YAML frontmatter');
  }
  const frontmatter = content.slice(0, closingFrontmatter);
  const withSteps = /^steps:\s*.*$/mu.test(frontmatter)
    ? frontmatter.replace(/^steps:\s*.*$/mu, 'steps: ' + steps)
    : frontmatter + '\nsteps: ' + steps;
  return withSteps + content.slice(closingFrontmatter);
}

function seedAgentFile(
  tagmaCwd: string,
  filename: string,
  content: string,
  agentMaxSteps: number,
): boolean {
  return seedFile(
    join(tagmaCwd, '.opencode', 'agents'),
    filename,
    applyOpencodeAgentMaxSteps(content, agentMaxSteps),
  );
}

function pruneStaleAgentFiles(tagmaCwd: string): boolean {
  let changed = false;
  const singularDir = join(tagmaCwd, '.opencode', 'agent');
  const pluralDir = join(tagmaCwd, '.opencode', 'agents');
  // Every active agent now lives only in the plural dir - drop any singular copy.
  for (const filename of ACTIVE_AGENT_FILES) {
    const p = join(singularDir, filename);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      changed = true;
    }
  }
  // Renamed-away agents must not survive in either dir.
  for (const filename of STALE_AGENT_FILES) {
    for (const dir of [singularDir, pluralDir]) {
      const p = join(dir, filename);
      if (existsSync(p)) {
        rmSync(p, { force: true });
        changed = true;
      }
    }
  }
  return changed;
}

export type SeedOpencodeArtifactsOptions = TagmaPipelineAgentOptions & {
  /** Upper bound for every editor-managed OpenCode agent. */
  agentMaxSteps?: number;
};

export function seedOpencodeArtifacts(
  tagmaCwd: string,
  options: SeedOpencodeArtifactsOptions = {},
): boolean {
  const hostOs = hostOsLabel();
  const agentMaxSteps = options.agentMaxSteps ?? DEFAULT_OPENCODE_AGENT_MAX_STEPS;
  const seedAgent = (filename: string, content: string): boolean =>
    seedAgentFile(tagmaCwd, filename, content, agentMaxSteps);
  let changed = seedAgent(`${TAGMA_ROUTER_AGENT}.md`, buildTagmaRouterAgent());
  changed =
    seedAgent(`${TAGMA_PIPELINE_AGENT}.md`, buildTagmaPipelineAgent(hostOs, options)) || changed;
  changed =
    seedAgent(`${TAGMA_PIPELINE_DIAGNOSIS_AGENT}.md`, buildTagmaPipelineDiagnosisAgent()) ||
    changed;
  changed =
    seedAgent(`${TAGMA_GENERAL_DISCUSSION_AGENT}.md`, buildTagmaGeneralDiscussionAgent()) ||
    changed;
  changed =
    seedAgent(`${TAGMA_HISTORY_COMPARE_AGENT}.md`, buildTagmaHistoryCompareAgent()) || changed;
  changed = seedAgent(`${TAGMA_YAML_REVIEW_AGENT}.md`, buildTagmaYamlReviewAgent()) || changed;
  changed =
    seedAgent(`${TAGMA_PIPELINE_PLANNER_AGENT}.md`, buildTagmaPipelinePlannerAgent()) || changed;
  changed =
    seedAgent(`${TAGMA_COMMAND_EVIDENCE_AGENT}.md`, buildTagmaCommandEvidenceAgent()) || changed;
  changed = seedAgent(`${TAGMA_RUNTIME_GUARD_AGENT}.md`, buildTagmaRuntimeGuardAgent()) || changed;
  changed =
    seedAgent(`${TAGMA_CONTEXT_PACKAGER_AGENT}.md`, buildTagmaContextPackagerAgent()) || changed;
  changed =
    seedAgent(
      `${TAGMA_PIPELINE_SECTION_BUILDER_AGENT}.md`,
      buildTagmaPipelineSectionBuilderAgent(hostOs),
    ) || changed;
  changed = seedAgent('tagma-python-tools.md', buildTagmaPythonToolsAgent(hostOs)) || changed;
  changed =
    seedFile(
      join(tagmaCwd, '.opencode', 'tools'),
      'tagma_yaml_skeleton.ts',
      buildTagmaYamlSkeletonTool(),
    ) || changed;
  changed =
    seedFile(
      join(tagmaCwd, '.opencode', 'tools'),
      'tagma_placement_plan.ts',
      buildTagmaPlacementTool(),
    ) || changed;
  changed =
    seedFile(
      join(tagmaCwd, '.opencode', 'tools'),
      'tagma_trial_plan.ts',
      buildTagmaTrialPlanTool(),
    ) || changed;
  for (const [name, build] of TAGMA_OPENCODE_SKILLS) {
    changed = seedFile(join(tagmaCwd, '.opencode', 'skills', name), 'SKILL.md', build()) || changed;
  }
  // Prune the legacy yaml-pipeline skill that older editor versions seeded.
  // Its guidance has been folded into focused current skills and compile-log
  // driven validation, so the old broad skill would be a stale shadow.
  try {
    const legacySkillDir = join(tagmaCwd, '.opencode', 'skills', 'yaml-pipeline');
    if (existsSync(legacySkillDir)) {
      rmSync(legacySkillDir, { recursive: true, force: true });
      changed = true;
    }
  } catch {
    /* best-effort cleanup - a leftover skill dir is harmless, just redundant */
  }
  try {
    changed = pruneStaleAgentFiles(tagmaCwd) || changed;
  } catch {
    /* best-effort cleanup - a stale agent file is redundant, not fatal */
  }
  return changed;
}
