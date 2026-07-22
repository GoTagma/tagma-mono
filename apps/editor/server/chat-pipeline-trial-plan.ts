import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

const TRIAL_PLAN_VERSION = 1;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_CASES = 8;
const MAX_FIXTURES_PER_CASE = 24;
const MAX_EXPECTATIONS_PER_CASE = 32;
const MAX_FIXTURE_BYTES = 64 * 1024;
const MAX_TOTAL_FIXTURE_BYTES = 256 * 1024;
const MAX_TEXT_EXPECTATION_BYTES = 16 * 1024;
const PLAN_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const QUALIFIED_TASK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/;
const WINDOWS_RESERVED_CASE_SEGMENT_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.])/i;

export const CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS = [
  'multiple-inputs',
  'duplicate-input-names',
  'multiline-content',
  'output-collision',
  'repeat-run',
  'empty-content',
  'special-characters',
] as const;

export type ChatPipelineTrialCoverageDimension =
  (typeof CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS)[number];
export type ChatPipelineTrialCoverageStatus = 'covered' | 'not-applicable' | 'blocked';

export interface ChatPipelineTrialPlanCoverage {
  dimension: ChatPipelineTrialCoverageDimension;
  status: ChatPipelineTrialCoverageStatus;
  caseIds: string[];
  rationale: string;
}

export interface ChatPipelineTrialPlanFinding {
  severity: 'blocking' | 'warning';
  summary: string;
  evidence: string;
}

export interface ChatPipelineTrialFixture {
  path: string;
  content: string;
}

export type ChatPipelineTrialExpectation =
  | { type: 'path-exists'; path: string }
  | { type: 'path-not-exists'; path: string }
  | { type: 'file-contains'; path: string; text: string }
  | { type: 'file-not-contains'; path: string; text: string }
  | {
      type: 'directory-entry-count';
      path: string;
      suffix: string | null;
      min: number | null;
      max: number | null;
    }
  | {
      type: 'task-status';
      taskId: string;
      status: 'success' | 'failed' | 'skipped' | 'timeout' | 'blocked';
    };

export interface ChatPipelineTrialPlanCase {
  id: string;
  title: string;
  objective: string;
  runs: number;
  targetTaskIds: string[];
  fixtures: ChatPipelineTrialFixture[];
  expectations: ChatPipelineTrialExpectation[];
}

export interface ChatPipelineTrialPlan {
  version: typeof TRIAL_PLAN_VERSION;
  yamlHash: string;
  summary: string;
  goals: string[];
  coverage: ChatPipelineTrialPlanCoverage[];
  findings: ChatPipelineTrialPlanFinding[];
  cases: ChatPipelineTrialPlanCase[];
}

export interface ChatPipelineTrialPlanRequest {
  reason: 'missing' | 'stale' | 'invalid';
  relativePlanPath: string;
  pipelineHash: string;
  message: string;
  requiredCoverage: ChatPipelineTrialCoverageDimension[];
}

export type ChatPipelineTrialPlanReadResult =
  | { status: 'ready'; plan: ChatPipelineTrialPlan; planHash: string }
  | { status: 'required'; request: ChatPipelineTrialPlanRequest };

export function pipelineTrialPlanPath(yamlPath: string): string {
  return yamlPath.replace(/\.ya?ml$/i, '.trial-plan.json');
}

export function relativeTrialPlanPath(relativeYamlPath: string): string {
  return relativeYamlPath.replace(/\.ya?ml$/i, '.trial-plan.json');
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > max) throw new Error(`${label} exceeds the limit of ${max}.`);
  return value;
}

function asString(value: unknown, label: string, maxLength = 2_000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} is too long.`);
  return trimmed;
}

function asOptionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return asString(value, label, maxLength);
}

function asInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function normalizeRelativeCasePath(value: unknown, label: string): string {
  const path = asString(value, label, 240).replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = path.split('/');
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        WINDOWS_RESERVED_CASE_SEGMENT_RE.test(part),
    ) ||
    parts[0]?.toLowerCase() === '.tagma'
  ) {
    throw new Error(`${label} must stay inside the isolated case workspace and outside .tagma.`);
  }
  return path;
}

function parseExpectation(value: unknown, label: string): ChatPipelineTrialExpectation {
  const raw = asRecord(value, label);
  const type = asString(raw.type, `${label}.type`, 64);
  if (type === 'path-exists' || type === 'path-not-exists') {
    return { type, path: normalizeRelativeCasePath(raw.path, `${label}.path`) };
  }
  if (type === 'file-contains' || type === 'file-not-contains') {
    const text = asString(raw.text, `${label}.text`, MAX_TEXT_EXPECTATION_BYTES);
    if (new TextEncoder().encode(text).length > MAX_TEXT_EXPECTATION_BYTES) {
      throw new Error(`${label}.text exceeds ${MAX_TEXT_EXPECTATION_BYTES} bytes.`);
    }
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, `${label}.path`),
      text,
    };
  }
  if (type === 'directory-entry-count') {
    const min = raw.min === undefined ? null : asInteger(raw.min, `${label}.min`, 0, 10_000);
    const max = raw.max === undefined ? null : asInteger(raw.max, `${label}.max`, 0, 10_000);
    if (min === null && max === null) throw new Error(`${label} requires min or max.`);
    if (min !== null && max !== null && min > max) {
      throw new Error(`${label}.min cannot exceed max.`);
    }
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, `${label}.path`),
      suffix: asOptionalString(raw.suffix, `${label}.suffix`, 64),
      min,
      max,
    };
  }
  if (type === 'task-status') {
    const taskId = asString(raw.taskId, `${label}.taskId`, 160);
    if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
      throw new Error(`${label}.taskId must be a qualified track.task id.`);
    }
    const status = asString(raw.status, `${label}.status`, 32);
    if (!['success', 'failed', 'skipped', 'timeout', 'blocked'].includes(status)) {
      throw new Error(`${label}.status is invalid.`);
    }
    return {
      type,
      taskId,
      status: status as 'success' | 'failed' | 'skipped' | 'timeout' | 'blocked',
    };
  }
  throw new Error(`${label}.type is unsupported.`);
}

function parseCase(value: unknown, index: number): ChatPipelineTrialPlanCase {
  const label = `cases[${index}]`;
  const raw = asRecord(value, label);
  const id = asString(raw.id, `${label}.id`, 64);
  if (!PLAN_ID_RE.test(id)) throw new Error(`${label}.id has an invalid format.`);
  const fixtures = asArray(raw.fixtures ?? [], `${label}.fixtures`, MAX_FIXTURES_PER_CASE).map(
    (fixtureValue, fixtureIndex) => {
      const fixtureLabel = `${label}.fixtures[${fixtureIndex}]`;
      const fixture = asRecord(fixtureValue, fixtureLabel);
      if (typeof fixture.content !== 'string') {
        throw new Error(`${fixtureLabel}.content must be a string.`);
      }
      const size = new TextEncoder().encode(fixture.content).length;
      if (size > MAX_FIXTURE_BYTES) {
        throw new Error(`${fixtureLabel}.content exceeds ${MAX_FIXTURE_BYTES} bytes.`);
      }
      return {
        path: normalizeRelativeCasePath(fixture.path, `${fixtureLabel}.path`),
        content: fixture.content,
      };
    },
  );
  const fixturePaths = fixtures.map((fixture) => fixture.path.toLowerCase());
  if (new Set(fixturePaths).size !== fixturePaths.length) {
    throw new Error(label + '.fixtures must not write the same path twice.');
  }
  const expectations = asArray(
    raw.expectations,
    `${label}.expectations`,
    MAX_EXPECTATIONS_PER_CASE,
  ).map((item, expectationIndex) =>
    parseExpectation(item, `${label}.expectations[${expectationIndex}]`),
  );
  if (expectations.length === 0) throw new Error(`${label}.expectations must not be empty.`);
  const targetTaskIds = asArray(raw.targetTaskIds ?? [], `${label}.targetTaskIds`, 32).map(
    (item, taskIndex) => {
      const taskId = asString(item, `${label}.targetTaskIds[${taskIndex}]`, 160);
      if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
        throw new Error(`${label}.targetTaskIds[${taskIndex}] must be a qualified track.task id.`);
      }
      return taskId;
    },
  );
  return {
    id,
    title: asString(raw.title, `${label}.title`, 240),
    objective: asString(raw.objective, `${label}.objective`, 1_000),
    runs: raw.runs === undefined ? 1 : asInteger(raw.runs, `${label}.runs`, 1, 3),
    targetTaskIds: [...new Set(targetTaskIds)],
    fixtures,
    expectations,
  };
}

function hasDuplicateFixtureBasenames(cases: ChatPipelineTrialPlanCase[]): boolean {
  return cases.some((item) => {
    const basenames = item.fixtures.map(
      (fixture) => fixture.path.split('/').at(-1)?.toLowerCase() ?? '',
    );
    return new Set(basenames).size !== basenames.length;
  });
}

function hasDistinctOutputExpectation(cases: ChatPipelineTrialPlanCase[]): boolean {
  return cases.some((item) => {
    const positivePaths = new Set<string>();
    for (const expectation of item.expectations) {
      if (
        expectation.type === 'directory-entry-count' &&
        expectation.min !== null &&
        expectation.min >= 2
      ) {
        return true;
      }
      if (expectation.type === 'path-exists' || expectation.type === 'file-contains') {
        positivePaths.add(expectation.path.toLowerCase());
      }
    }
    return positivePaths.size >= 2;
  });
}

function validateCoveredCaseEvidence(
  coverage: ChatPipelineTrialPlanCoverage[],
  cases: ChatPipelineTrialPlanCase[],
): void {
  const casesById = new Map(cases.map((item) => [item.id, item]));
  for (const entry of coverage) {
    if (entry.status !== 'covered') continue;
    const linkedCases = entry.caseIds
      .map((caseId) => casesById.get(caseId))
      .filter((item): item is ChatPipelineTrialPlanCase => !!item);
    let evidenced = true;
    if (entry.dimension === 'multiple-inputs') {
      evidenced = linkedCases.some((item) => item.fixtures.length >= 2);
    } else if (entry.dimension === 'duplicate-input-names') {
      evidenced = hasDuplicateFixtureBasenames(linkedCases);
    } else if (entry.dimension === 'multiline-content') {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) => fixture.content.includes(String.fromCharCode(10))),
      );
    } else if (entry.dimension === 'output-collision') {
      evidenced = hasDistinctOutputExpectation(linkedCases);
    } else if (entry.dimension === 'repeat-run') {
      evidenced = linkedCases.some((item) => item.runs >= 2);
    } else if (entry.dimension === 'empty-content') {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) => fixture.content.length === 0),
      );
    } else if (entry.dimension === 'special-characters') {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) =>
          [...fixture.content].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return (
              codePoint > 127 ||
              (character.trim().length > 0 && !/[A-Za-z0-9]/.test(character))
            );
          }),
        ),
      );
    }
    if (!evidenced) {
      throw new Error(
        'trial plan coverage marks ' +
          entry.dimension +
          ' covered without concrete linked-case evidence.',
      );
    }
  }
}

export function parseChatPipelineTrialPlan(value: unknown): ChatPipelineTrialPlan {
  const raw = asRecord(value, 'trial plan');
  if (raw.version !== TRIAL_PLAN_VERSION) {
    throw new Error(`trial plan version must be ${TRIAL_PLAN_VERSION}.`);
  }
  const yamlHash = asString(raw.yamlHash, 'trial plan yamlHash', 40);
  if (!/^[0-9a-f]{40}$/i.test(yamlHash)) throw new Error('trial plan yamlHash must be SHA-1.');

  const cases = asArray(raw.cases, 'trial plan cases', MAX_CASES).map(parseCase);
  if (cases.length === 0) throw new Error('trial plan cases must contain at least one case.');
  const caseIds = new Set<string>();
  for (const item of cases) {
    if (caseIds.has(item.id)) throw new Error(`trial plan case id is duplicated: ${item.id}.`);
    caseIds.add(item.id);
  }
  const totalFixtureBytes = cases
    .flatMap((item) => item.fixtures)
    .reduce((total, fixture) => total + new TextEncoder().encode(fixture.content).length, 0);
  if (totalFixtureBytes > MAX_TOTAL_FIXTURE_BYTES) {
    throw new Error(`trial plan fixtures exceed ${MAX_TOTAL_FIXTURE_BYTES} bytes in total.`);
  }

  const coverageRaw = asArray(
    raw.coverage,
    'trial plan coverage',
    CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.length,
  );
  const coverage = coverageRaw.map((item, index): ChatPipelineTrialPlanCoverage => {
    const label = `coverage[${index}]`;
    const entry = asRecord(item, label);
    const dimension = asString(entry.dimension, `${label}.dimension`, 64);
    if (!CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.includes(dimension as never)) {
      throw new Error(`${label}.dimension is unsupported.`);
    }
    const status = asString(entry.status, `${label}.status`, 32);
    if (!['covered', 'not-applicable', 'blocked'].includes(status)) {
      throw new Error(`${label}.status is invalid.`);
    }
    const linkedCaseIds = asArray(entry.caseIds ?? [], `${label}.caseIds`, MAX_CASES).map(
      (caseId, caseIndex) => asString(caseId, `${label}.caseIds[${caseIndex}]`, 64),
    );
    if (status === 'covered' && linkedCaseIds.length === 0) {
      throw new Error(`${label} must reference at least one case when covered.`);
    }
    for (const caseId of linkedCaseIds) {
      if (!caseIds.has(caseId)) throw new Error(`${label} references unknown case ${caseId}.`);
    }
    return {
      dimension: dimension as ChatPipelineTrialCoverageDimension,
      status: status as ChatPipelineTrialCoverageStatus,
      caseIds: [...new Set(linkedCaseIds)],
      rationale: asString(entry.rationale, `${label}.rationale`, 1_000),
    };
  });
  const coverageDimensions = new Set(coverage.map((item) => item.dimension));
  for (const dimension of CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS) {
    if (!coverageDimensions.has(dimension)) {
      throw new Error(`trial plan coverage is missing ${dimension}.`);
    }
  }
  if (coverageDimensions.size !== coverage.length) {
    throw new Error('trial plan coverage dimensions must not be duplicated.');
  }
  validateCoveredCaseEvidence(coverage, cases);

  const findings = asArray(raw.findings ?? [], 'trial plan findings', 16).map(
    (item, index): ChatPipelineTrialPlanFinding => {
      const label = `findings[${index}]`;
      const finding = asRecord(item, label);
      const severity = asString(finding.severity, `${label}.severity`, 32);
      if (severity !== 'blocking' && severity !== 'warning') {
        throw new Error(`${label}.severity is invalid.`);
      }
      return {
        severity,
        summary: asString(finding.summary, `${label}.summary`, 500),
        evidence: asString(finding.evidence, `${label}.evidence`, 2_000),
      };
    },
  );

  return {
    version: TRIAL_PLAN_VERSION,
    yamlHash,
    summary: asString(raw.summary, 'trial plan summary', 2_000),
    goals: asArray(raw.goals, 'trial plan goals', 16).map((goal, index) =>
      asString(goal, `goals[${index}]`, 1_000),
    ),
    coverage,
    findings,
    cases,
  };
}

function planRequest(
  reason: ChatPipelineTrialPlanRequest['reason'],
  relativeYamlPath: string,
  pipelineHash: string,
  message: string,
): ChatPipelineTrialPlanReadResult {
  return {
    status: 'required',
    request: {
      reason,
      relativePlanPath: relativeTrialPlanPath(relativeYamlPath),
      pipelineHash,
      message,
      requiredCoverage: [...CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS],
    },
  };
}

export function readChatPipelineTrialPlan(
  stagedYamlPath: string,
  relativeYamlPath: string,
  pipelineHash: string,
): ChatPipelineTrialPlanReadResult {
  const path = pipelineTrialPlanPath(stagedYamlPath);
  if (!existsSync(path)) {
    return planRequest('missing', relativeYamlPath, pipelineHash, 'No trial plan was written.');
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return planRequest(
        'invalid',
        relativeYamlPath,
        pipelineHash,
        'The trial plan must be a regular file.',
      );
    }
    if (stat.size > MAX_PLAN_BYTES) {
      return planRequest(
        'invalid',
        relativeYamlPath,
        pipelineHash,
        `The trial plan exceeds ${MAX_PLAN_BYTES} bytes.`,
      );
    }
    const content = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const candidateHash =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { yamlHash?: unknown }).yamlHash
        : null;
    if (typeof candidateHash === 'string' && candidateHash !== pipelineHash) {
      return planRequest(
        'stale',
        relativeYamlPath,
        pipelineHash,
        'The trial plan targets an older YAML revision.',
      );
    }
    const plan = parseChatPipelineTrialPlan(parsed);
    if (plan.yamlHash !== pipelineHash) {
      return planRequest(
        'stale',
        relativeYamlPath,
        pipelineHash,
        'The trial plan targets an older YAML revision.',
      );
    }
    return {
      status: 'ready',
      plan,
      planHash: createHash('sha256').update(content).digest('hex'),
    };
  } catch (err) {
    return planRequest(
      'invalid',
      relativeYamlPath,
      pipelineHash,
      err instanceof Error ? err.message : String(err),
    );
  }
}
