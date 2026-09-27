import type {
  ChatPipelineTrialPlan,
  ChatPipelineTrialPlanCase,
} from './chat-pipeline-trial-plan.js';
import type { PipelineConfig } from '@tagma/sdk';
import { buildDag } from '@tagma/sdk/config';

export type ExplicitResilienceObligation =
  | 'timeout-recovery'
  | 'failure-recovery'
  | 'empty-result'
  | 'unlocated-source'
  | 'source-preservation';

const RECOVERY_WORDS =
  /\b(?:continue|still|recover|fallback|fall back|handle|produce|generate|write|list|show|display|include|without crashing|without aborting|does not crash)\b|继续|仍|恢复|回退|处理|生成|列出|显示|不崩溃|不中断/iu;
const TIMEOUT_WORDS = /\b(?:time[ -]?outs?|times out|timed out|timing out|deadline)\b|超时/iu;
const EMPTY_RESULT_WORDS =
  /\b(?:no|zero|empty)\s+(?:testable\s+|factual\s+)?claims?\b|\bclaims?\s+(?:are|is)\s+empty\b|没有.{0,12}(?:声明|主张)|零.{0,8}(?:声明|主张)|空.{0,8}(?:声明|主张)/iu;
const UNLOCATED_WORDS =
  /\b(?:unlocated|unmatched|not located|cannot (?:be )?located|cannot (?:be )?matched|no source span)\b|无法定位|未定位|匹配不到/iu;
const FAILURE_WORDS =
  /\b(?:failure|fails?|errors?|exception|unavailable|offline|permission denied|missing file|invalid response)\b|失败|错误|异常|不可用|离线|权限拒绝|文件缺失/iu;
const CONDITIONAL_WORDS = /\b(?:if|when|whenever|in case|even if)\b|如果|当|即使/iu;

function clauses(text: string): string[] {
  return text
    .split(/[\n.!?。！？;；]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Only explicit recovery promises create a publication obligation. A mere task
 * deadline is not a promise that downstream work survives that deadline.
 */
export function explicitResilienceObligations(intentText: string): ExplicitResilienceObligation[] {
  const found = new Set<ExplicitResilienceObligation>();
  const parts = clauses(intentText);
  for (const [index, clause] of parts.entries()) {
    const following = parts[index + 1] ?? '';
    if (
      !RECOVERY_WORDS.test(clause) &&
      !(CONDITIONAL_WORDS.test(clause) && RECOVERY_WORDS.test(following))
    )
      continue;
    if (TIMEOUT_WORDS.test(clause)) found.add('timeout-recovery');
    if (FAILURE_WORDS.test(clause)) found.add('failure-recovery');
    if (EMPTY_RESULT_WORDS.test(clause)) found.add('empty-result');
    if (UNLOCATED_WORDS.test(clause)) found.add('unlocated-source');
  }
  // A document fact-checker promises a usable annotated copy of its source. These
  // branches are part of that contract even when the author did not enumerate them.
  // Keep the inference narrow so an unrelated command timeout is unaffected.
  if (
    /fact[ -]?check|核查|事实核验/iu.test(intentText) &&
    /(?:extract|提取).{0,35}(?:claims?|声明|主张)/iu.test(intentText) &&
    /(?:web|search|网页|网络)/iu.test(intentText) &&
    /(?:annotat|原文|原稿|draft)/iu.test(intentText)
  ) {
    found.add('timeout-recovery');
    found.add('empty-result');
    found.add('unlocated-source');
    found.add('source-preservation');
  }
  return (
    [
      'timeout-recovery',
      'failure-recovery',
      'empty-result',
      'unlocated-source',
      'source-preservation',
    ] as const
  ).filter((kind) => found.has(kind));
}

function successfulTerminalWithOutput(testCase: ChatPipelineTrialPlanCase): boolean {
  return (
    testCase.expectations.some(
      (item) => item.type === 'task-status' && item.status === 'success',
    ) &&
    testCase.expectations.some(
      (item) =>
        item.type === 'file-contains' ||
        item.type === 'file-equals' ||
        item.type === 'file-preserves-lines' ||
        item.type === 'json-pointer-equals',
    )
  );
}

function controlledVariation(
  testCase: ChatPipelineTrialPlanCase,
  pattern: RegExp,
  pipelineConfig?: PipelineConfig,
): boolean {
  const consumedNames = new Set<string>();
  if (pipelineConfig) {
    const dag = buildDag(pipelineConfig);
    const pending = [...testCase.targetTaskIds];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = dag.nodes.get(id);
      if (!node) continue;
      pending.push(...node.dependsOn);
      const source = JSON.stringify({
        command: node.task.command,
        prompt: node.task.prompt,
        inputs: node.task.inputs,
      });
      for (const item of testCase.environment ?? []) {
        if (source.includes(item.name)) consumedNames.add(item.name);
      }
    }
  }
  return (
    testCase.environment?.some(
      (item) =>
        item.value !== null &&
        pattern.test(`${item.name} ${item.value}`) &&
        (!pipelineConfig || consumedNames.has(item.name)),
    ) ?? false
  );
}

function differentialMarker(
  testCase: ChatPipelineTrialPlanCase,
  cases: readonly ChatPipelineTrialPlanCase[],
  marker: RegExp,
): boolean {
  const fixtureSignature = (candidate: ChatPipelineTrialPlanCase) =>
    JSON.stringify(
      [...candidate.fixtures].sort((left, right) => left.path.localeCompare(right.path)),
    );
  const environmentSignature = (candidate: ChatPipelineTrialPlanCase) =>
    JSON.stringify(
      [...(candidate.environment ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    );
  return testCase.expectations.some(
    (positive) =>
      positive.type === 'file-contains' &&
      marker.test(positive.text) &&
      cases.some(
        (baseline) =>
          baseline.id !== testCase.id &&
          [...baseline.targetTaskIds].sort().join('\0') ===
            [...testCase.targetTaskIds].sort().join('\0') &&
          fixtureSignature(baseline) === fixtureSignature(testCase) &&
          environmentSignature(baseline) !== environmentSignature(testCase) &&
          baseline.expectations.some(
            (item) => item.type === 'task-status' && item.status === 'success',
          ) &&
          baseline.expectations.some(
            (item) => item.type === 'path-exists' && item.path === positive.path,
          ) &&
          baseline.expectations.some(
            (negative) =>
              negative.type === 'file-not-contains' &&
              negative.path === positive.path &&
              negative.text === positive.text,
          ),
      ),
  );
}

function timeoutEvidence(
  testCase: ChatPipelineTrialPlanCase,
  cases: readonly ChatPipelineTrialPlanCase[],
  pipelineConfig?: PipelineConfig,
): boolean {
  return (
    successfulTerminalWithOutput(testCase) &&
    TIMEOUT_WORDS.test(`${testCase.title} ${testCase.objective}`) &&
    controlledVariation(testCase, /timeout|deadline|delay|fault|failure|超时/iu, pipelineConfig) &&
    differentialMarker(testCase, cases, /unverified|timeout|fallback|failed|未核实|无法核实|超时/iu)
  );
}

function failureEvidence(
  testCase: ChatPipelineTrialPlanCase,
  cases: readonly ChatPipelineTrialPlanCase[],
  pipelineConfig?: PipelineConfig,
): boolean {
  return (
    successfulTerminalWithOutput(testCase) &&
    FAILURE_WORDS.test(`${testCase.title} ${testCase.objective}`) &&
    controlledVariation(
      testCase,
      /failure|error|fault|offline|unavailable|invalid|missing|失败|错误|不可用/iu,
      pipelineConfig,
    ) &&
    differentialMarker(
      testCase,
      cases,
      /failed|failure|error|unavailable|offline|unverified|degraded|失败|错误|不可用|未核实/iu,
    )
  );
}

function emptyResultEvidence(testCase: ChatPipelineTrialPlanCase): boolean {
  return (
    successfulTerminalWithOutput(testCase) &&
    EMPTY_RESULT_WORDS.test(`${testCase.title} ${testCase.objective}`) &&
    testCase.fixtures.some(
      (fixture) => fixture.content !== null && fixture.content.trim().length > 0,
    ) &&
    testCase.expectations.some(
      (item) =>
        item.type === 'json-pointer-equals' &&
        (item.pointer === '' || item.pointer === '/claims') &&
        item.expectedJson.trim() === '[]',
    ) &&
    testCase.expectations.some(
      (item) =>
        (item.type === 'file-contains' || item.type === 'file-equals') &&
        /no.{0,20}claims?|zero.{0,20}claims?|没有.{0,12}(?:声明|主张)|无.{0,12}(?:声明|主张)/iu.test(
          item.text,
        ),
    )
  );
}

function sourcePreservationEvidence(testCase: ChatPipelineTrialPlanCase): boolean {
  if (!successfulTerminalWithOutput(testCase)) return false;
  return testCase.fixtures.some((fixture) => {
    if (fixture.content === null || !/\.md$/iu.test(fixture.path)) return false;
    if (fixture.content.split(/\r?\n/u).filter((line) => line.trim().length >= 12).length < 3)
      return false;
    return testCase.expectations.some(
      (item) =>
        item.type === 'file-preserves-lines' &&
        item.sourcePath === fixture.path &&
        item.text === fixture.content &&
        /\.md$/iu.test(item.path),
    );
  });
}

function unlocatedEvidence(
  testCase: ChatPipelineTrialPlanCase,
  cases: readonly ChatPipelineTrialPlanCase[],
  pipelineConfig?: PipelineConfig,
): boolean {
  return (
    successfulTerminalWithOutput(testCase) &&
    UNLOCATED_WORDS.test(`${testCase.title} ${testCase.objective}`) &&
    controlledVariation(
      testCase,
      /unlocated|unmatched|missing|fault|未定位|无法定位/iu,
      pipelineConfig,
    ) &&
    differentialMarker(testCase, cases, UNLOCATED_WORDS)
  );
}

/** Host-side check of executable evidence, independent of the planner's coverage labels. */
export function missingExplicitResilienceEvidence(
  intentText: string,
  plan: ChatPipelineTrialPlan,
  pipelineConfig?: PipelineConfig,
): ExplicitResilienceObligation[] {
  const obligations = explicitResilienceObligations(intentText);
  return obligations.filter(
    (kind) =>
      !plan.cases.some((testCase) => {
        if (kind === 'timeout-recovery')
          return timeoutEvidence(testCase, plan.cases, pipelineConfig);
        if (kind === 'failure-recovery')
          return failureEvidence(testCase, plan.cases, pipelineConfig);
        if (kind === 'empty-result') return emptyResultEvidence(testCase);
        if (kind === 'source-preservation') return sourcePreservationEvidence(testCase);
        return unlocatedEvidence(testCase, plan.cases, pipelineConfig);
      }),
  );
}

/** A controlled edge case cannot be authored until the staged closure consumes a fault control. */
export function missingControlledFaultSeam(
  missing: readonly ExplicitResilienceObligation[],
  pipelineConfig: PipelineConfig,
): boolean {
  if (!missing.includes('timeout-recovery') && !missing.includes('unlocated-source')) return false;
  const taskSources = pipelineConfig.tracks.flatMap((track) =>
    track.tasks.map((task) => `${task.command ?? ''}\n${task.prompt ?? ''}`),
  );
  return !taskSources.some((source) =>
    /\b(?:TAGMA_TEST_[A-Z0-9_]+|[A-Z][A-Z0-9_]*(?:FAULT|FAIL|TIMEOUT|UNLOCATED|MOCK|SIMULATE)[A-Z0-9_]*)\b/u.test(
      source,
    ),
  );
}
