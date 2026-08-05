import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  isValidChatPipelineTrialPlanAttempts,
} from '../shared/chat-pipeline-trial-plan-limit.js';

export const CHAT_PIPELINE_TRIAL_PLAN_CONTRACT = {
  version: 3,
  limits: {
    planBytes: 256 * 1024,
    cases: 8,
    fixturesPerCase: 24,
    expectationsPerCase: 32,
    fixtureBytes: 64 * 1024,
    totalFixtureBytes: 256 * 1024,
    textExpectationBytes: 16 * 1024,
    findings: 16,
    goals: 16,
    runs: 3,
    toolAttemptsPerYaml: {
      min: MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
      default: DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
      max: MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
    },
    rejectionSummaries: 4,
  },
  coverageDimensions: [
    'multiple-inputs',
    'duplicate-input-names',
    'multiline-content',
    'inter-task-output-collision',
    'repeat-run-output-collision',
    'concurrent-run-output-collision',
    'repeat-run',
    'empty-content',
    'special-characters',
  ],
  coverageStatuses: ['covered', 'accepted-risk', 'not-applicable', 'blocked'],
  findingSeverities: ['blocking', 'warning'],
  findingRepairScopes: ['pipeline-artifact', 'diagnostic-only'],
  expectationTypes: [
    'path-exists',
    'path-not-exists',
    'file-contains',
    'file-not-contains',
    'file-equals',
    'directory-entry-count',
    'task-status',
  ],
  taskStatuses: ['success', 'failed', 'skipped', 'timeout', 'blocked'],
  pipelineCompanionSuffixes: [
    '.compile.log',
    '.layout.json',
    '.manifest.json',
    '.requirements.md',
    '.trial-plan.json',
  ],
} as const;

const TRIAL_PLAN_VERSION = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version;
const MAX_PLAN_BYTES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.planBytes;
const MAX_CASES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.cases;
const MAX_FIXTURES_PER_CASE = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.fixturesPerCase;
const MAX_EXPECTATIONS_PER_CASE = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.expectationsPerCase;
const MAX_FIXTURE_BYTES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.fixtureBytes;
const MAX_TOTAL_FIXTURE_BYTES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.totalFixtureBytes;
const MAX_TEXT_EXPECTATION_BYTES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.textExpectationBytes;
const PLAN_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const QUALIFIED_TASK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/;
const WINDOWS_RESERVED_CASE_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.])/i;

export const CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions;
export const CHAT_PIPELINE_TRIAL_COVERAGE_STATUSES =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageStatuses;
export const CHAT_PIPELINE_TRIAL_FINDING_SEVERITIES =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.findingSeverities;
export const CHAT_PIPELINE_TRIAL_FINDING_REPAIR_SCOPES =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.findingRepairScopes;
export const CHAT_PIPELINE_TRIAL_EXPECTATION_TYPES =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.expectationTypes;
export const CHAT_PIPELINE_TRIAL_TASK_STATUSES = CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.taskStatuses;

export type ChatPipelineTrialCoverageDimension =
  (typeof CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS)[number];
export type ChatPipelineTrialCoverageStatus =
  (typeof CHAT_PIPELINE_TRIAL_COVERAGE_STATUSES)[number];

export interface ChatPipelineTrialPlanCoverage {
  dimension: ChatPipelineTrialCoverageDimension;
  status: ChatPipelineTrialCoverageStatus;
  caseIds: string[];
  rationale: string;
}

export interface ChatPipelineTrialPlanFinding {
  severity: 'blocking' | 'warning';
  repairScope: 'pipeline-artifact' | 'diagnostic-only';
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
  | { type: 'file-equals'; path: string; text: string }
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
  maxAttempts: number;
  requiredCoverage: ChatPipelineTrialCoverageDimension[];
}

export type ChatPipelineTrialPlanReadResult =
  | { status: 'ready'; plan: ChatPipelineTrialPlan; planHash: string }
  | { status: 'required'; request: ChatPipelineTrialPlanRequest };

export interface ChatPipelineTrialPlanToolTelemetry {
  version: 2;
  yamlHash: string;
  relativeYamlPath: string;
  attemptIds: string[];
  toolAttemptCount: number;
  validationRejectionCount: number;
  repeatedValidationRejectionCount: number;
  successfulWriteCount: number;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  elapsedMs: number;
  rejections: Array<{ fingerprint: string; count: number; message: string }>;
}

const TRIAL_PLAN_TOOL_TELEMETRY_VERSION = 2;
const TRIAL_PLAN_HOST_ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TRIAL_PLAN_TOOL_TELEMETRY_BYTES = 32 * 1024;

function emptyTrialPlanToolTelemetry(
  yamlHash: string,
  relativeYamlPath: string,
): ChatPipelineTrialPlanToolTelemetry {
  return {
    version: TRIAL_PLAN_TOOL_TELEMETRY_VERSION,
    yamlHash,
    relativeYamlPath,
    attemptIds: [],
    toolAttemptCount: 0,
    validationRejectionCount: 0,
    repeatedValidationRejectionCount: 0,
    successfulWriteCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    elapsedMs: 0,
    rejections: [],
  };
}

function telemetryInteger(value: unknown, label: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

export function readChatPipelineTrialPlanToolTelemetry(
  stagedYamlPath: string,
  maxAttempts = DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
): ChatPipelineTrialPlanToolTelemetry {
  if (!isValidChatPipelineTrialPlanAttempts(maxAttempts)) {
    throw new Error('Trial plan max attempts is invalid.');
  }
  const yamlHash = createHash('sha1').update(readFileSync(stagedYamlPath, 'utf8')).digest('hex');
  const agentTagmaDir = dirname(dirname(stagedYamlPath));
  const relativeYamlPath = relative(agentTagmaDir, stagedYamlPath).replace(/\\/g, '/');
  const stageRoot = dirname(dirname(agentTagmaDir));
  const key = createHash('sha256')
    .update(relativeYamlPath + String.fromCharCode(0) + yamlHash)
    .digest('hex');
  const telemetryPath = join(stageRoot, '.trial-plan-telemetry', `${key}.json`);
  if (!existsSync(telemetryPath)) {
    return emptyTrialPlanToolTelemetry(yamlHash, relativeYamlPath);
  }
  const stat = lstatSync(telemetryPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRIAL_PLAN_TOOL_TELEMETRY_BYTES) {
    throw new Error('Trial plan tool telemetry must be a small regular file.');
  }
  const raw = JSON.parse(readFileSync(telemetryPath, 'utf8')) as Record<string, unknown>;
  if (
    raw.version !== TRIAL_PLAN_TOOL_TELEMETRY_VERSION ||
    raw.yamlHash !== yamlHash ||
    raw.relativeYamlPath !== relativeYamlPath
  ) {
    throw new Error('Trial plan tool telemetry does not match the staged YAML revision.');
  }
  const toolAttemptCount = telemetryInteger(raw.toolAttemptCount, 'toolAttemptCount', maxAttempts);
  if (
    !Array.isArray(raw.attemptIds) ||
    raw.attemptIds.length !== toolAttemptCount ||
    new Set(raw.attemptIds).size !== raw.attemptIds.length ||
    !raw.attemptIds.every(
      (attemptId) => typeof attemptId === 'string' && TRIAL_PLAN_HOST_ATTEMPT_ID_RE.test(attemptId),
    )
  ) {
    throw new Error('Trial plan host attempt telemetry is invalid.');
  }
  const attemptIds = raw.attemptIds as string[];
  const validationRejectionCount = telemetryInteger(
    raw.validationRejectionCount,
    'validationRejectionCount',
    toolAttemptCount,
  );
  const repeatedValidationRejectionCount = telemetryInteger(
    raw.repeatedValidationRejectionCount,
    'repeatedValidationRejectionCount',
    validationRejectionCount,
  );
  const successfulWriteCount = telemetryInteger(
    raw.successfulWriteCount,
    'successfulWriteCount',
    toolAttemptCount,
  );
  if (validationRejectionCount + successfulWriteCount !== toolAttemptCount) {
    throw new Error('Trial plan tool telemetry counters are inconsistent.');
  }
  if (!Array.isArray(raw.rejections)) throw new Error('Trial plan rejection telemetry is invalid.');
  const rejections = raw.rejections.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Trial plan rejection telemetry ${index} is invalid.`);
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.fingerprint) ||
      typeof item.message !== 'string' ||
      item.message.length === 0 ||
      item.message.length > 500
    ) {
      throw new Error(`Trial plan rejection telemetry ${index} is invalid.`);
    }
    return {
      fingerprint: item.fingerprint,
      count: telemetryInteger(item.count, `rejections[${index}].count`, validationRejectionCount),
      message: item.message,
    };
  });
  if (rejections.length > CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.rejectionSummaries) {
    throw new Error('Trial plan rejection telemetry exceeds its summary limit.');
  }
  const firstAttemptAt =
    raw.firstAttemptAt === null
      ? null
      : telemetryInteger(raw.firstAttemptAt, 'firstAttemptAt', Number.MAX_SAFE_INTEGER);
  const lastAttemptAt =
    raw.lastAttemptAt === null
      ? null
      : telemetryInteger(raw.lastAttemptAt, 'lastAttemptAt', Number.MAX_SAFE_INTEGER);
  if (
    (toolAttemptCount === 0 && (firstAttemptAt !== null || lastAttemptAt !== null)) ||
    (toolAttemptCount > 0 && (firstAttemptAt === null || lastAttemptAt === null)) ||
    (firstAttemptAt !== null && lastAttemptAt !== null && firstAttemptAt > lastAttemptAt)
  ) {
    throw new Error('Trial plan tool telemetry timestamps are invalid.');
  }
  return {
    version: TRIAL_PLAN_TOOL_TELEMETRY_VERSION,
    yamlHash,
    relativeYamlPath,
    attemptIds,
    toolAttemptCount,
    validationRejectionCount,
    repeatedValidationRejectionCount,
    successfulWriteCount,
    firstAttemptAt,
    lastAttemptAt,
    elapsedMs:
      firstAttemptAt === null || lastAttemptAt === null ? 0 : lastAttemptAt - firstAttemptAt,
    rejections,
  };
}

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
  if (type === 'file-equals') {
    if (typeof raw.text !== 'string') {
      throw new Error(label + '.text must be a string.');
    }
    if (new TextEncoder().encode(raw.text).length > MAX_TEXT_EXPECTATION_BYTES) {
      throw new Error(label + '.text exceeds the expectation byte limit.');
    }
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, label + '.path'),
      text: raw.text,
    };
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
    if (!CHAT_PIPELINE_TRIAL_TASK_STATUSES.includes(status as never)) {
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
  const targetTaskIds = [
    ...new Set(
      asArray(raw.targetTaskIds, `${label}.targetTaskIds`, 32).map((item, taskIndex) => {
        const taskId = asString(item, `${label}.targetTaskIds[${taskIndex}]`, 160);
        if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
          throw new Error(
            `${label}.targetTaskIds[${taskIndex}] must be a qualified track.task id.`,
          );
        }
        return taskId;
      }),
    ),
  ];
  if (targetTaskIds.length === 0) {
    throw new Error(`${label}.targetTaskIds must contain at least one qualified track.task id.`);
  }
  return {
    id,
    title: asString(raw.title, `${label}.title`, 240),
    objective: asString(raw.objective, `${label}.objective`, 1_000),
    runs: raw.runs === undefined ? 1 : asInteger(raw.runs, `${label}.runs`, 1, 3),
    targetTaskIds,
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
      if (
        expectation.type === 'path-exists' ||
        expectation.type === 'file-contains' ||
        expectation.type === 'file-equals'
      ) {
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
    } else if (entry.dimension === 'inter-task-output-collision') {
      evidenced = linkedCases.some(
        (item) => item.targetTaskIds.length >= 2 && hasDistinctOutputExpectation([item]),
      );
    } else if (entry.dimension === 'repeat-run-output-collision') {
      evidenced = linkedCases.some(
        (item) => item.runs >= 2 && hasDistinctOutputExpectation([item]),
      );
    } else if (entry.dimension === 'concurrent-run-output-collision') {
      throw new Error(
        'trial plan coverage concurrent-run-output-collision cannot be covered by the sequential trial harness; use accepted-risk, blocked, or not-applicable.',
      );
    } else if (entry.dimension === 'repeat-run') {
      evidenced = linkedCases.some((item) => item.runs >= 2);
    } else if (entry.dimension === 'empty-content') {
      evidenced = linkedCases.some(
        (item) =>
          item.fixtures.some((fixture) => fixture.content.length === 0) &&
          item.expectations.some(
            (expectation) => expectation.type === 'file-equals' && expectation.text.length === 0,
          ),
      );
    } else if (entry.dimension === 'special-characters') {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) =>
          [...fixture.content].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return (
              codePoint > 127 || (character.trim().length > 0 && !/[A-Za-z0-9]/.test(character))
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
  if (!Array.isArray(raw.goals) || raw.goals.length === 0) {
    throw new Error('trial plan goals must contain at least one behavior goal.');
  }

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
    if (!CHAT_PIPELINE_TRIAL_COVERAGE_STATUSES.includes(status as never)) {
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

  const findings = asArray(
    raw.findings ?? [],
    'trial plan findings',
    CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.findings,
  ).map((item, index): ChatPipelineTrialPlanFinding => {
    const label = `findings[${index}]`;
    const finding = asRecord(item, label);
    const severity = asString(finding.severity, `${label}.severity`, 32);
    if (!CHAT_PIPELINE_TRIAL_FINDING_SEVERITIES.includes(severity as never)) {
      throw new Error(`${label}.severity is invalid.`);
    }
    const repairScope = asString(finding.repairScope, `${label}.repairScope`, 32);
    if (!CHAT_PIPELINE_TRIAL_FINDING_REPAIR_SCOPES.includes(repairScope as never)) {
      throw new Error(`${label}.repairScope is invalid.`);
    }
    return {
      severity: severity as ChatPipelineTrialPlanFinding['severity'],
      repairScope: repairScope as ChatPipelineTrialPlanFinding['repairScope'],
      summary: asString(finding.summary, `${label}.summary`, 500),
      evidence: asString(finding.evidence, `${label}.evidence`, 2_000),
    };
  });

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

function reservedPipelineArtifactPaths(relativeYamlPath: string): Set<string> {
  const normalized = relativeYamlPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const separator = normalized.lastIndexOf('/');
  const directory = separator >= 0 ? normalized.slice(0, separator + 1) : '';
  const yamlName = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const stem = yamlName.replace(/\.ya?ml$/i, '');
  return new Set(
    [
      normalized,
      ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.pipelineCompanionSuffixes.map(
        (suffix) => `${directory}${stem}${suffix}`,
      ),
    ].map((path) => path.toLowerCase()),
  );
}

export function validateChatPipelineTrialPlanTargetPaths(
  plan: ChatPipelineTrialPlan,
  relativeYamlPath: string,
): void {
  const reserved = reservedPipelineArtifactPaths(relativeYamlPath);
  for (const [caseIndex, testCase] of plan.cases.entries()) {
    const paths = [
      ...testCase.fixtures.map((fixture, index) => ({
        label: `cases[${caseIndex}].fixtures[${index}].path`,
        path: fixture.path,
      })),
      ...testCase.expectations.flatMap((expectation, index) =>
        'path' in expectation
          ? [
              {
                label: `cases[${caseIndex}].expectations[${index}].path`,
                path: expectation.path,
              },
            ]
          : [],
      ),
    ];
    for (const item of paths) {
      if (!reserved.has(item.path.toLowerCase())) continue;
      throw new Error(
        `${item.label} must target case fixtures or outputs, not staged pipeline artifacts (${item.path}).`,
      );
    }
  }
}

export function buildChatPipelineTrialPlanRequest(
  reason: ChatPipelineTrialPlanRequest['reason'],
  relativeYamlPath: string,
  pipelineHash: string,
  message: string,
  maxAttempts: number,
): ChatPipelineTrialPlanRequest {
  return {
    reason,
    relativePlanPath: relativeTrialPlanPath(relativeYamlPath),
    pipelineHash,
    message,
    maxAttempts,
    requiredCoverage: [...CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS],
  };
}

function planRequest(
  reason: ChatPipelineTrialPlanRequest['reason'],
  relativeYamlPath: string,
  pipelineHash: string,
  message: string,
  maxAttempts: number,
): ChatPipelineTrialPlanReadResult {
  return {
    status: 'required',
    request: buildChatPipelineTrialPlanRequest(
      reason,
      relativeYamlPath,
      pipelineHash,
      message,
      maxAttempts,
    ),
  };
}

export function readChatPipelineTrialPlan(
  stagedYamlPath: string,
  relativeYamlPath: string,
  pipelineHash: string,
  maxAttempts = DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
): ChatPipelineTrialPlanReadResult {
  if (!isValidChatPipelineTrialPlanAttempts(maxAttempts)) {
    throw new Error('Trial plan max attempts is invalid.');
  }
  const path = pipelineTrialPlanPath(stagedYamlPath);
  if (!existsSync(path)) {
    return planRequest(
      'missing',
      relativeYamlPath,
      pipelineHash,
      'No trial plan was written.',
      maxAttempts,
    );
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return planRequest(
        'invalid',
        relativeYamlPath,
        pipelineHash,
        'The trial plan must be a regular file.',
        maxAttempts,
      );
    }
    if (stat.size > MAX_PLAN_BYTES) {
      return planRequest(
        'invalid',
        relativeYamlPath,
        pipelineHash,
        `The trial plan exceeds ${MAX_PLAN_BYTES} bytes.`,
        maxAttempts,
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
        maxAttempts,
      );
    }
    const plan = parseChatPipelineTrialPlan(parsed);
    validateChatPipelineTrialPlanTargetPaths(plan, relativeYamlPath);
    if (plan.yamlHash !== pipelineHash) {
      return planRequest(
        'stale',
        relativeYamlPath,
        pipelineHash,
        'The trial plan targets an older YAML revision.',
        maxAttempts,
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
      maxAttempts,
    );
  }
}
