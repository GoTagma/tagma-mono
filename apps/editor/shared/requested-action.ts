export const CREATE_NEW_PIPELINE_ACTION_KIND = 'create-new-pipeline';
export const FILL_MANUAL_NEW_PIPELINE_ACTION_KIND = 'fill-manual-new-pipeline';

export interface PipelineRequestContext {
  currentPipelineIsManualNewDraft?: boolean;
}

const CREATE_PIPELINE_PATTERNS = [
  /\b(?:create|generate|scaffold|set up|build|make)\b.{0,64}\b(?:new\s+)?(?:[A-Za-z0-9_-]+\s+)?(?:pipeline|workflow)\b/i,
  /\bnew\b.{0,32}\b(?:pipeline|workflow)\b/i,
  /(?:创建|新建|新增|生成|建立|搭建|做一个|建一个).{0,48}(?:pipeline|流水线|管线)/iu,
  /(?:新的?|新).{0,24}(?:pipeline|流水线|管线)/iu,
] as const;

const PIPELINE_TARGET_RE = /(?:pipeline|流水线|管线)/iu;
const WORKFLOW_TARGET_RE = /workflow/iu;
const NON_PIPELINE_OBJECT_BEFORE_RE =
  /\b(?:task|tasks|track|tracks|node|nodes|stage|stages|step|steps|job|jobs)\b|(?:任务|节点|步骤|阶段)/iu;
const NON_PIPELINE_OBJECT_AFTER_RE =
  /^\s*(?:task|tasks|track|tracks|node|nodes|stage|stages|step|steps|job|jobs)\b|^\s*(?:的|中|里|里面)?\s*(?:任务|节点|步骤|阶段)/iu;
const SEPARATE_NEW_PIPELINE_PATTERNS = [
  /\b(?:another|separate|different|sibling|second)\b.{0,48}\b(?:pipeline|workflow)\b/i,
  /\b(?:pipeline|workflow)\b.{0,48}\b(?:another|separate|different|sibling|second)\b/i,
  /(?:另一个|另外|再(?:创建|新建|新增|生成|建立|搭建|做一个|建一个|来一个)|单独|独立|第二个|不要当前|不是当前|别改当前).{0,48}(?:pipeline|流水线|管线)/iu,
  /(?:pipeline|流水线|管线).{0,48}(?:另一个|另外|单独|独立|第二个|不要当前|不是当前|别改当前)/iu,
] as const;
function looksLikePipelineSubobjectCreation(
  text: string,
  matchStart: number,
  matchText: string,
): boolean {
  const pipeline = PIPELINE_TARGET_RE.exec(matchText) ?? WORKFLOW_TARGET_RE.exec(matchText);
  if (!pipeline) return false;

  const pipelineStart = matchStart + pipeline.index;
  const pipelineEnd = pipelineStart + pipeline[0].length;
  const beforePipeline = text.slice(Math.max(0, pipelineStart - 64), pipelineStart);
  const afterPipeline = text.slice(pipelineEnd, pipelineEnd + 32);

  return (
    NON_PIPELINE_OBJECT_BEFORE_RE.test(beforePipeline) ||
    NON_PIPELINE_OBJECT_AFTER_RE.test(afterPipeline)
  );
}

export function isCreateNewPipelineRequest(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return CREATE_PIPELINE_PATTERNS.some((pattern) => {
    const match = pattern.exec(text);
    if (!match) return false;
    return !looksLikePipelineSubobjectCreation(text, match.index, match[0]);
  });
}

export function isExplicitSeparateNewPipelineRequest(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  return SEPARATE_NEW_PIPELINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldFillManualNewPipeline(
  text: string | undefined,
  context: PipelineRequestContext | undefined,
): boolean {
  return (
    isCreateNewPipelineRequest(text) &&
    !isExplicitSeparateNewPipelineRequest(text) &&
    context?.currentPipelineIsManualNewDraft === true
  );
}

export function fillManualNewPipelineRequestedActionLines(
  text: string | undefined,
  context?: PipelineRequestContext,
): string[] {
  if (!shouldFillManualNewPipeline(text, context)) return [];
  return [
    `  <requested-action kind="${FILL_MANUAL_NEW_PIPELINE_ACTION_KIND}">`,
    '    <target>current-file</target>',
    '    <reason>current file is the editor-created manual new pipeline draft</reason>',
    '  </requested-action>',
  ];
}

export function createNewPipelineRequestedActionLines(
  text: string | undefined,
  context?: PipelineRequestContext,
): string[] {
  if (shouldFillManualNewPipeline(text, context)) return [];
  if (!isCreateNewPipelineRequest(text)) return [];
  return [
    `  <requested-action kind="${CREATE_NEW_PIPELINE_ACTION_KIND}">`,
    '    <collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
    '  </requested-action>',
  ];
}

export function isCreateNewPipelineRequestedAction(value: unknown): boolean {
  if (value === CREATE_NEW_PIPELINE_ACTION_KIND) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === CREATE_NEW_PIPELINE_ACTION_KIND;
}
