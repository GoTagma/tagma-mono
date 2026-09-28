import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import type { PipelineConfig } from '@tagma/sdk';
import { buildDag } from '@tagma/sdk/config';

import {
  DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  isValidChatPipelineTrialPlanAttempts,
} from '../shared/chat-pipeline-trial-plan-limit.js';
import { sameFilesystemPathCoordinate } from '../shared/filesystem-paths.js';
import {
  buildTrialPlanPathCoordinateContext,
  createTrialPathCoordinateRules,
} from './chat-trial-path-coordinate-rules.js';
import {
  normalizeTrialPrerequisiteCases,
  type ChatPipelineTrialPrerequisiteControls,
} from './chat-pipeline-trial-prerequisites.js';
import {
  parseTrialCaseEvidence,
  parseTrialEvidenceReview,
  requiredTrialEvidence,
  inspectTrialEvidence,
  trialIntentDigest,
} from './chat-trial-intent-coverage.js';

const trialPathCoordinateRules = createTrialPathCoordinateRules();

export const CHAT_PIPELINE_TRIAL_PLAN_CONTRACT = {
  version: 12,
  limits: {
    planBytes: 256 * 1024,
    cases: 8,
    fixturesPerCase: 24,
    generatedInputPathsPerCase: 24,
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
    'file-preserves-lines',
    'json-valid',
    'json-pointer-equals',
    'json-pointer-text-occurrence',
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
const MAX_GENERATED_INPUT_PATHS_PER_CASE =
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.generatedInputPathsPerCase;
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
  /** null removes one regular file from the isolated copy; empty string writes an empty file. */
  content: string | null;
}

export type ChatPipelineTrialExpectation =
  | { type: 'path-exists'; path: string }
  | { type: 'path-not-exists'; path: string }
  | { type: 'file-contains'; path: string; text: string }
  | { type: 'file-not-contains'; path: string; text: string }
  | { type: 'file-equals'; path: string; text: string }
  | { type: 'file-preserves-lines'; path: string; sourcePath: string; text: string }
  | { type: 'json-valid'; path: string }
  | {
      type: 'json-pointer-text-occurrence';
      path: string;
      pointer: string;
      sourcePath: string;
      present: boolean;
    }
  | {
      type: 'json-pointer-equals';
      path: string;
      pointer: string;
      expectedJson: string;
    }
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

export interface ChatPipelineTrialPlanCase extends ChatPipelineTrialPrerequisiteControls {
  id: string;
  title: string;
  objective: string;
  runs: number;
  targetTaskIds: string[];
  fixtures: ChatPipelineTrialFixture[];
  /** Files the targeted closure must generate before consuming them as downstream inputs. */
  generatedInputPaths?: string[];
  expectations: ChatPipelineTrialExpectation[];
  evidence?: import('./chat-trial-resilience-rules.js').TrialCaseEvidence[];
}

export interface ChatPipelineTrialPlan {
  version: typeof TRIAL_PLAN_VERSION;
  yamlHash: string;
  summary: string;
  goals: string[];
  coverage: ChatPipelineTrialPlanCoverage[];
  findings: ChatPipelineTrialPlanFinding[];
  cases: ChatPipelineTrialPlanCase[];
  evidenceReview?: import('./chat-trial-resilience-rules.js').TrialEvidenceReview;
}

export function findUncoveredChatPipelineTrialTerminalTaskIds(
  plan: ChatPipelineTrialPlan,
  pipelineConfig: PipelineConfig,
): string[] {
  const dag = buildDag(pipelineConfig);
  const dependedOnTaskIds = new Set([...dag.nodes.values()].flatMap((node) => node.dependsOn));
  const targetedTaskIds = new Set(
    plan.cases
      .filter((testCase) => !testCase.baselineCaseId)
      .flatMap((testCase) => testCase.targetTaskIds),
  );
  return [...dag.nodes.keys()].filter(
    (taskId) => !dependedOnTaskIds.has(taskId) && !targetedTaskIds.has(taskId),
  );
}

export interface ChatPipelineTrialPlanRequest {
  reason: 'missing' | 'stale' | 'invalid';
  relativePlanPath: string;
  pipelineHash: string;
  message: string;
  maxAttempts: number;
  requiredCoverage: ChatPipelineTrialCoverageDimension[];
  /** Host-confirmed staged artifact lacks a control needed for executable edge-case evidence. */
  artifactRepair?: 'missing_controlled_fault_seam' | 'recovery_failure_policy';
  /** Host-observed cases that must be revised before repeating a failed Trial. */
  affectedCases?: Array<{
    caseId: string;
    failedExpectationTypes: string[];
    originalCaseHash: string;
    requiredFixture?: { path: string; content: null };
  }>;
}

export function chatPipelineTrialCaseExecutionHash(testCase: ChatPipelineTrialPlanCase): string {
  const { title: _title, objective: _objective, ...execution } = testCase;
  return createHash('sha256').update(JSON.stringify(execution)).digest('hex');
}

/** Bound plan-review evidence to failed cases; infer absence only from a passing peer. */
export function affectedChatPipelineTrialPlanCases(
  plan: ChatPipelineTrialPlan,
  results: readonly {
    id: string;
    success: boolean;
    expectations: readonly { type: string; passed: boolean }[];
  }[],
): NonNullable<ChatPipelineTrialPlanRequest['affectedCases']> {
  const passed = new Set(results.filter((item) => item.success).map((item) => item.id));
  return results
    .filter((item) => !item.success && item.expectations.some((expectation) => !expectation.passed))
    .slice(0, 16)
    .flatMap((result) => {
      const testCase = plan.cases.find((item) => item.id === result.id);
      if (!testCase) return [];
      const failedExpectationTypes = [
        ...new Set(result.expectations.filter((item) => !item.passed).map((item) => item.type)),
      ].slice(0, 16);
      const peer = plan.cases.find(
        (item) =>
          passed.has(item.id) &&
          JSON.stringify([...item.targetTaskIds].sort()) ===
            JSON.stringify([...testCase.targetTaskIds].sort()),
      );
      const missing = peer?.fixtures.filter(
        (fixture) =>
          fixture.content !== null &&
          !testCase.fixtures.some((other) => other.path === fixture.path),
      );
      return [
        {
          caseId: result.id,
          failedExpectationTypes,
          originalCaseHash: chatPipelineTrialCaseExecutionHash(testCase),
          ...(missing?.length === 1
            ? { requiredFixture: { path: missing[0]!.path, content: null } }
            : {}),
        },
      ];
    });
}

class TrialPlanFixtureSetupError extends Error {
  constructor(
    message: string,
    readonly affectedCases: NonNullable<ChatPipelineTrialPlanRequest['affectedCases']>,
  ) {
    super(message);
  }
}

export type ChatPipelineTrialPlanReadResult =
  | {
      status: 'ready';
      plan: ChatPipelineTrialPlan;
      planHash: string;
      reviewedRequirements?: readonly import('./chat-trial-resilience-rules.js').ExplicitResilienceObligation[];
    }
  | {
      status: 'required';
      request: ChatPipelineTrialPlanRequest;
      reviewedRequirements?: readonly import('./chat-trial-resilience-rules.js').ExplicitResilienceObligation[];
    };

export interface ChatPipelineTrialPlanToolTelemetry {
  version: 2;
  yamlHash: string;
  relativeYamlPath: string;
  attemptIds: string[];
  toolAttemptCount: number;
  validationRejectionCount: number;
  repeatedValidationRejectionCount: number;
  successfulWriteCount: number;
  committedPlanHash: string | null;
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
    committedPlanHash: null,
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
  const committedPlanHash = raw.committedPlanHash;
  if (
    (successfulWriteCount === 0 && committedPlanHash !== null) ||
    (successfulWriteCount > 0 &&
      (typeof committedPlanHash !== 'string' || !/^[0-9a-f]{64}$/.test(committedPlanHash)))
  ) {
    throw new Error('Trial plan committed hash telemetry is invalid.');
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
    committedPlanHash: committedPlanHash as string | null,
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

function parseJsonPointer(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 512) {
    throw new Error(`${label} must be a JSON Pointer no longer than 512 characters.`);
  }
  if (value !== '' && !value.startsWith('/')) {
    throw new Error(`${label} must be empty or start with /.`);
  }
  if (/~(?:[^01]|$)/u.test(value)) {
    throw new Error(`${label} contains an invalid JSON Pointer escape.`);
  }
  return value;
}

function parseExpectedJson(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON string.`);
  if (new TextEncoder().encode(value).length > MAX_TEXT_EXPECTATION_BYTES) {
    throw new Error(`${label} exceeds the expectation byte limit.`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`${label} must contain one valid JSON value.`);
  }
  return value;
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
  if (type === 'file-preserves-lines') {
    asString(raw.text, `${label}.text`, MAX_TEXT_EXPECTATION_BYTES);
    const text = raw.text as string;
    if (new TextEncoder().encode(text).length > MAX_TEXT_EXPECTATION_BYTES) {
      throw new Error(`${label}.text exceeds ${MAX_TEXT_EXPECTATION_BYTES} bytes.`);
    }
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, `${label}.path`),
      sourcePath: normalizeRelativeCasePath(raw.sourcePath, `${label}.sourcePath`),
      text,
    };
  }
  if (type === 'json-valid') {
    return { type, path: normalizeRelativeCasePath(raw.path, `${label}.path`) };
  }
  if (type === 'json-pointer-equals') {
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, `${label}.path`),
      pointer: parseJsonPointer(raw.pointer, `${label}.pointer`),
      expectedJson: parseExpectedJson(raw.expectedJson, `${label}.expectedJson`),
    };
  }
  if (type === 'json-pointer-text-occurrence') {
    if (typeof raw.present !== 'boolean') throw new Error(`${label}.present must be a boolean.`);
    return {
      type,
      path: normalizeRelativeCasePath(raw.path, `${label}.path`),
      pointer: parseJsonPointer(raw.pointer, `${label}.pointer`),
      sourcePath: normalizeRelativeCasePath(raw.sourcePath, `${label}.sourcePath`),
      present: raw.present,
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

function relativeFilePathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseCase(value: unknown, index: number): ChatPipelineTrialPlanCase {
  const label = `cases[${index}]`;
  const raw = normalizeTrialPrerequisiteCases([asRecord(value, label)], false)[0]!;
  const id = asString(raw.id, `${label}.id`, 64);
  if (!PLAN_ID_RE.test(id)) throw new Error(`${label}.id has an invalid format.`);
  const fixtures = asArray(raw.fixtures ?? [], `${label}.fixtures`, MAX_FIXTURES_PER_CASE).map(
    (fixtureValue, fixtureIndex) => {
      const fixtureLabel = `${label}.fixtures[${fixtureIndex}]`;
      const fixture = asRecord(fixtureValue, fixtureLabel);
      if (fixture.content !== null && typeof fixture.content !== 'string') {
        throw new Error(`${fixtureLabel}.content must be a string or null (remove a copied file).`);
      }
      const size = new TextEncoder().encode(fixture.content ?? '').length;
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
  if (
    fixturePaths.some((path, index) =>
      fixturePaths.slice(0, index).some((candidate) => relativeFilePathsOverlap(path, candidate)),
    )
  ) {
    throw new Error(`${label}.fixtures must not write overlapping file paths.`);
  }
  const generatedInputPaths = asArray(
    raw.generatedInputPaths ?? [],
    `${label}.generatedInputPaths`,
    MAX_GENERATED_INPUT_PATHS_PER_CASE,
  ).map((path, pathIndex) =>
    normalizeRelativeCasePath(path, `${label}.generatedInputPaths[${pathIndex}]`),
  );
  const normalizedGeneratedInputPaths = generatedInputPaths.map((path) => path.toLowerCase());
  if (new Set(normalizedGeneratedInputPaths).size !== normalizedGeneratedInputPaths.length) {
    throw new Error(`${label}.generatedInputPaths must not name the same path twice.`);
  }
  if (normalizedGeneratedInputPaths.some((path) => fixturePaths.includes(path))) {
    throw new Error(`${label}.generatedInputPaths must not also be pre-seeded through fixtures.`);
  }
  if (
    normalizedGeneratedInputPaths.some(
      (path, index) =>
        fixturePaths.some((candidate) => relativeFilePathsOverlap(path, candidate)) ||
        normalizedGeneratedInputPaths
          .slice(0, index)
          .some((candidate) => relativeFilePathsOverlap(path, candidate)),
    )
  ) {
    throw new Error(`${label}.generatedInputPaths must not overlap fixtures or each other.`);
  }
  const expectations = asArray(
    raw.expectations,
    `${label}.expectations`,
    MAX_EXPECTATIONS_PER_CASE,
  ).map((item, expectationIndex) =>
    parseExpectation(item, `${label}.expectations[${expectationIndex}]`),
  );
  if (expectations.length === 0) throw new Error(`${label}.expectations must not be empty.`);
  for (const expectation of expectations) {
    if (expectation.type !== 'file-preserves-lines') continue;
    const source = fixtures.find((fixture) => fixture.path === expectation.sourcePath);
    if (!source || source.content === null || source.content !== expectation.text) {
      throw new Error(
        `${label}.file-preserves-lines must exactly match a non-null source fixture.`,
      );
    }
    if (expectation.path === expectation.sourcePath) {
      throw new Error(`${label}.file-preserves-lines output must differ from its source fixture.`);
    }
    if (fixtures.some((fixture) => fixture.path === expectation.path)) {
      throw new Error(`${label}.file-preserves-lines output must be generated by the pipeline.`);
    }
  }
  const generatedInputExpectationPaths = new Set(
    expectations.flatMap((expectation) =>
      expectation.type === 'file-equals' ? [expectation.path.toLowerCase()] : [],
    ),
  );
  for (const generatedInputPath of normalizedGeneratedInputPaths) {
    if (!generatedInputExpectationPaths.has(generatedInputPath)) {
      throw new Error(
        `${label}.generatedInputPaths requires a file-equals expectation for ${generatedInputPath}.`,
      );
    }
  }
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
    generatedInputPaths,
    expectations,
    ...(raw.evidence === undefined
      ? {}
      : {
          evidence: parseTrialCaseEvidence(raw.evidence).map((item) =>
            item.type !== 'source-preservation' && item.fault.type === 'artifact-replace'
              ? {
                  ...item,
                  fault: {
                    ...item.fault,
                    path: normalizeRelativeCasePath(
                      item.fault.path,
                      `${label}.evidence.fault.path`,
                    ),
                  },
                }
              : item,
          ),
        }),
    ...(raw.baselineCaseId !== undefined ? { baselineCaseId: raw.baselineCaseId } : {}),
    ...(raw.environment !== undefined ? { environment: raw.environment } : {}),
    ...(raw.deniedManualTaskIds !== undefined
      ? { deniedManualTaskIds: raw.deniedManualTaskIds }
      : {}),
  };
}

interface ChatPipelineTrialInputEvidence {
  path: string;
  content: string;
}

function inputEvidence(testCase: ChatPipelineTrialPlanCase): ChatPipelineTrialInputEvidence[] {
  const generated = (testCase.generatedInputPaths ?? []).flatMap((path) => {
    const expectation = testCase.expectations.find(
      (candidate) =>
        candidate.type === 'file-equals' && candidate.path.toLowerCase() === path.toLowerCase(),
    );
    return expectation?.type === 'file-equals' ? [{ path, content: expectation.text }] : [];
  });
  return [
    ...testCase.fixtures.filter(
      (item): item is { path: string; content: string } => item.content !== null,
    ),
    ...generated,
  ];
}

function hasDuplicateInputBasenames(cases: ChatPipelineTrialPlanCase[]): boolean {
  return cases.some((item) => {
    const basenames = inputEvidence(item).map(
      (input) => input.path.split('/').at(-1)?.toLowerCase() ?? '',
    );
    return new Set(basenames).size !== basenames.length;
  });
}

export function findChatPipelineTrialRepeatedFileOutputPaths(
  testCase: ChatPipelineTrialPlanCase,
): string[] {
  if (testCase.runs < 2) return [];
  const fixturePaths = new Set(testCase.fixtures.map((fixture) => fixture.path.toLowerCase()));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const expectation of testCase.expectations) {
    if (!(
      expectation.type === 'file-contains' ||
      expectation.type === 'file-not-contains' ||
      expectation.type === 'file-equals' ||
      expectation.type === 'file-preserves-lines' ||
      expectation.type === 'json-valid' ||
      expectation.type === 'json-pointer-equals'
    )) {
      continue;
    }
    const normalizedPath = expectation.path.toLowerCase();
    if (fixturePaths.has(normalizedPath) || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    paths.push(expectation.path);
  }
  return paths;
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
        expectation.type === 'file-equals' ||
        expectation.type === 'file-preserves-lines' ||
        expectation.type === 'json-valid' ||
        expectation.type === 'json-pointer-equals'
      ) {
        positivePaths.add(expectation.path.toLowerCase());
      }
    }
    return positivePaths.size >= 2;
  });
}

function validateJsonArtifactExpectations(cases: ChatPipelineTrialPlanCase[]): void {
  for (const testCase of cases) {
    const jsonAwarePaths = new Set(
      testCase.expectations
        .filter(
          (expectation) =>
            expectation.type === 'json-valid' ||
            expectation.type === 'json-pointer-equals' ||
            expectation.type === 'json-pointer-text-occurrence',
        )
        .map((expectation) => expectation.path.toLowerCase()),
    );
    for (const expectation of testCase.expectations) {
      if (
        !(
          expectation.type === 'path-exists' ||
          expectation.type === 'file-contains' ||
          expectation.type === 'file-not-contains' ||
          expectation.type === 'file-equals' ||
          expectation.type === 'file-preserves-lines'
        ) ||
        !expectation.path.toLowerCase().endsWith('.json') ||
        jsonAwarePaths.has(expectation.path.toLowerCase())
      ) {
        continue;
      }
      throw new Error(
        `JSON artifact ${expectation.path} requires a json-valid or json-pointer-equals expectation in the same case.`,
      );
    }
  }
}

function coverageEvidenceHint(dimension: ChatPipelineTrialCoverageDimension): string {
  if (dimension === 'multiple-inputs')
    return 'needs at least two pre-seeded or pipeline-generated inputs in the linked case';
  if (dimension === 'duplicate-input-names')
    return 'needs same-basename pre-seeded or pipeline-generated inputs in different folders';
  if (dimension === 'multiline-content')
    return 'needs a pre-seeded or pipeline-generated input containing a newline';
  if (dimension === 'inter-task-output-collision')
    return 'needs at least two target task ids plus distinct-output expectations';
  if (dimension === 'repeat-run-output-collision')
    return 'needs runs >= 2 plus a non-fixture file assertion that the Host can probe after every run';
  if (dimension === 'repeat-run') return 'needs runs >= 2';
  if (dimension === 'empty-content')
    return 'needs an empty pre-seeded or pipeline-generated input with exact file evidence';
  if (dimension === 'special-characters')
    return 'needs a pre-seeded or pipeline-generated input containing a non-ASCII or non-alphanumeric character';
  return 'needs concrete linked-case evidence';
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
      evidenced = linkedCases.some((item) => inputEvidence(item).length >= 2);
    } else if (entry.dimension === 'duplicate-input-names') {
      evidenced = hasDuplicateInputBasenames(linkedCases);
    } else if (entry.dimension === 'multiline-content') {
      evidenced = linkedCases.some((item) =>
        inputEvidence(item).some((input) => input.content.includes(String.fromCharCode(10))),
      );
    } else if (entry.dimension === 'inter-task-output-collision') {
      evidenced = linkedCases.some(
        (item) => item.targetTaskIds.length >= 2 && hasDistinctOutputExpectation([item]),
      );
    } else if (entry.dimension === 'repeat-run-output-collision') {
      evidenced = linkedCases.some(
        (item) => findChatPipelineTrialRepeatedFileOutputPaths(item).length > 0,
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
          inputEvidence(item).some((input) => input.content.length === 0) &&
          item.expectations.some(
            (expectation) => expectation.type === 'file-equals' && expectation.text.length === 0,
          ),
      );
    } else if (entry.dimension === 'special-characters') {
      evidenced = linkedCases.some((item) =>
        inputEvidence(item).some((input) =>
          [...input.content].some((character) => {
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
          ' covered without concrete linked-case evidence: ' +
          coverageEvidenceHint(entry.dimension) +
          '. Add that evidence, or mark the dimension blocked when the harness cannot observe it, or accepted-risk when it is an accepted unverified risk.',
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

  const cases = normalizeTrialPrerequisiteCases(
    asArray(raw.cases, 'trial plan cases', MAX_CASES).map(parseCase),
  );
  if (cases.length === 0) throw new Error('trial plan cases must contain at least one case.');
  validateJsonArtifactExpectations(cases);
  const caseIds = new Set<string>();
  for (const item of cases) {
    if (caseIds.has(item.id)) throw new Error(`trial plan case id is duplicated: ${item.id}.`);
    caseIds.add(item.id);
  }
  const totalFixtureBytes = cases
    .flatMap((item) => item.fixtures)
    .reduce((total, fixture) => total + new TextEncoder().encode(fixture.content ?? '').length, 0);
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
    ...(raw.evidenceReview === undefined
      ? {}
      : { evidenceReview: parseTrialEvidenceReview(raw.evidenceReview) }),
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
      ...testCase.expectations.flatMap((expectation, index) =>
        'sourcePath' in expectation
          ? [
              {
                label: `cases[${caseIndex}].expectations[${index}].sourcePath`,
                path: expectation.sourcePath,
              },
            ]
          : [],
      ),
      ...(testCase.evidence ?? []).flatMap((item, index) =>
        item.type !== 'source-preservation' && item.fault.type === 'artifact-replace'
          ? [{ label: `cases[${caseIndex}].evidence[${index}].fault.path`, path: item.fault.path }]
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

/** Precommit and authoritative Host checks share the same case-root coordinate rules. */
export function validateChatPipelineTrialPlanTaskPathCoordinates(
  plan: ChatPipelineTrialPlan,
  pipelineConfig: PipelineConfig,
  relativeYamlPath: string,
  workDir: string,
): void {
  trialPathCoordinateRules.validate(
    plan,
    buildTrialPlanPathCoordinateContext(pipelineConfig, relativeYamlPath, workDir),
  );
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

function isDefaultExitCodeCompletion(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const completion = value as { type?: unknown; expect?: unknown };
  return (
    completion.type === 'exit_code' &&
    (completion.expect === undefined ||
      completion.expect === 0 ||
      (Array.isArray(completion.expect) &&
        completion.expect.length === 1 &&
        completion.expect[0] === 0))
  );
}

function hostFixedPromptTrialPlan(
  pipelineConfig: PipelineConfig,
  yamlHash: string,
  workDir?: string,
): ChatPipelineTrialPlan | null {
  if (pipelineConfig.tracks.length !== 1) return null;
  const track = pipelineConfig.tracks[0];
  if (!track || track.tasks.length !== 1) return null;
  const task = track.tasks[0];
  if (!task || typeof task.prompt !== 'string' || task.prompt.trim().length === 0) return null;
  if (task.command !== undefined) return null;

  const permissions =
    task.permissions ??
    track.permissions ??
    pipelineConfig.permissions ??
    ({ read: true, write: false, execute: false } as const);
  if (permissions.read || permissions.write || permissions.execute || permissions.web) return null;
  const driver = task.driver ?? track.driver ?? pipelineConfig.driver ?? 'opencode';
  if (driver !== 'opencode') return null;
  if ((task.depends_on?.length ?? 0) > 0 || task.continue_from) return null;
  if (Object.keys(task.inputs ?? {}).length > 0 || Object.keys(task.outputs ?? {}).length > 0) {
    return null;
  }
  if (task.trigger || !isDefaultExitCodeCompletion(task.completion)) return null;
  const middlewares = task.middlewares ?? track.middlewares ?? [];
  if (middlewares.length > 0) return null;
  if (
    (pipelineConfig.secrets?.length ?? 0) > 0 ||
    (track.secrets?.length ?? 0) > 0 ||
    (task.secrets?.length ?? 0) > 0
  ) {
    return null;
  }
  if (pipelineConfig.hooks && Object.keys(pipelineConfig.hooks).length > 0) return null;
  if (pipelineConfig.plugins && pipelineConfig.plugins.length > 0) return null;
  const usesDefaultCwd = (cwd: string | undefined): boolean =>
    !cwd || (!!workDir && sameFilesystemPathCoordinate(cwd, workDir));
  if (!usesDefaultCwd(track.cwd) || !usesDefaultCwd(task.cwd)) return null;

  const qualifiedTaskId = `${track.id}.${task.id}`;
  const caseId = 'host-fixed-prompt-repeat';
  return parseChatPipelineTrialPlan({
    version: TRIAL_PLAN_VERSION,
    yamlHash,
    summary: 'Run the fixed tool-free prompt repeatedly without changing its business input.',
    goals: ['Verify that the sole fixed prompt completes successfully on repeated execution.'],
    coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) =>
      dimension === 'repeat-run'
        ? {
            dimension,
            status: 'covered',
            caseIds: [caseId],
            rationale: 'The Host-owned case executes the same fixed prompt twice.',
          }
        : {
            dimension,
            status: 'not-applicable',
            caseIds: [],
            rationale:
              'The tool-free fixed prompt has no authored input or artifact surface for this dimension.',
          },
    ),
    findings: [],
    cases: [
      {
        id: caseId,
        title: 'Repeat the fixed prompt',
        objective:
          'Confirm the exact authored prompt succeeds twice without tools or case fixtures.',
        runs: 2,
        targetTaskIds: [qualifiedTaskId],
        fixtures: [],
        expectations: [{ type: 'task-status', taskId: qualifiedTaskId, status: 'success' }],
      },
    ],
  });
}

function planRequest(
  reason: ChatPipelineTrialPlanRequest['reason'],
  relativeYamlPath: string,
  pipelineHash: string,
  message: string,
  maxAttempts: number,
  artifactRepair?: ChatPipelineTrialPlanRequest['artifactRepair'],
): ChatPipelineTrialPlanReadResult {
  return {
    status: 'required',
    request: {
      ...buildChatPipelineTrialPlanRequest(
        reason,
        relativeYamlPath,
        pipelineHash,
        message,
        maxAttempts,
      ),
      ...(artifactRepair ? { artifactRepair } : {}),
    },
  };
}

/** Reject a structurally unchanged negative setup before it can authorize artifact repair. */
export function validateChatPipelineTrialFixtureSetup(
  plan: ChatPipelineTrialPlan,
  stagedYamlPath: string,
  relativeYamlPath: string,
): void {
  const namespace = dirname(relativeYamlPath).replace(/\\/g, '/');
  const fingerprint = (content: string | Uint8Array | null): string | null =>
    content === null ? null : createHash('sha256').update(content).digest('hex');
  const base = new Map<string, string | null>();
  const readBase = (path: string): string | null => {
    if (base.has(path)) return base.get(path)!;
    let value: string | null = null;
    if (path.startsWith(`${namespace}/`)) {
      const suffix = path.slice(namespace.length + 1);
      let current = dirname(stagedYamlPath);
      for (const segment of suffix.split('/')) {
        current = join(current, segment);
        try {
          if (lstatSync(current).isSymbolicLink())
            throw new Error('Trial fixtures must not address symlinks.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            base.set(path, null);
            return null;
          }
          throw error;
        }
      }
      if (!lstatSync(current).isFile())
        throw new Error('Trial file fixtures must address regular files.');
      value = fingerprint(readFileSync(current));
    }
    base.set(path, value);
    return value;
  };
  for (const negative of plan.cases) {
    if (
      negative.baselineCaseId ||
      negative.evidence?.some((item) => item.type !== 'source-preservation') ||
      (negative.environment?.length ?? 0) > 0 ||
      (negative.deniedManualTaskIds?.length ?? 0) > 0
    )
      continue;
    for (const positive of plan.cases) {
      if (
        positive === negative ||
        positive.baselineCaseId ||
        positive.evidence?.some((item) => item.type !== 'source-preservation') ||
        (positive.environment?.length ?? 0) > 0 ||
        JSON.stringify([...positive.targetTaskIds].sort()) !==
          JSON.stringify([...negative.targetTaskIds].sort())
      )
        continue;
      const contradictsSuccess = negative.expectations.some(
        (item) =>
          item.type === 'task-status' &&
          item.status !== 'success' &&
          positive.expectations.some(
            (other) =>
              other.type === 'task-status' &&
              other.taskId === item.taskId &&
              other.status === 'success',
          ),
      );
      if (!contradictsSuccess) continue;
      const left = new Map(positive.fixtures.map((item) => [item.path, fingerprint(item.content)]));
      const right = new Map(
        negative.fixtures.map((item) => [item.path, fingerprint(item.content)]),
      );
      const omittedPaths = [...left.keys()].filter((path) => !right.has(path));
      if (omittedPaths.length > 0) {
        throw new TrialPlanFixtureSetupError(
          `Case ${negative.id} omits a file input controlled by positive case ${positive.id}. Omission keeps the staged file; it does not construct absence. Explicitly fixture the negative input (content: null for missing, a string for present bytes) before testing a contradictory task outcome. Correct the plan, not the pipeline.`,
          [
            {
              caseId: negative.id,
              failedExpectationTypes: ['task-status'],
              originalCaseHash: chatPipelineTrialCaseExecutionHash(negative),
              ...(omittedPaths.length === 1
                ? { requiredFixture: { path: omittedPaths[0]!, content: null } }
                : {}),
            },
          ],
        );
      }
      const paths = new Set([...left.keys(), ...right.keys()]);
      if (
        [...paths].every(
          (path) =>
            (left.has(path) ? left.get(path) : readBase(path)) ===
            (right.has(path) ? right.get(path) : readBase(path)),
        )
      ) {
        throw new TrialPlanFixtureSetupError(
          `Case ${negative.id} expects a different task outcome from ${positive.id} with the same effective file inputs and targets. fixtures: [] retains copied support files. Correct the plan's setup; use content: null to remove a required file and assert path-not-exists. Do not repair the pipeline to satisfy an unchanged negative setup.`,
          [
            {
              caseId: negative.id,
              failedExpectationTypes: ['task-status'],
              originalCaseHash: chatPipelineTrialCaseExecutionHash(negative),
            },
          ],
        );
      }
    }
  }
}

export function readChatPipelineTrialPlan(
  stagedYamlPath: string,
  relativeYamlPath: string,
  pipelineHash: string,
  maxAttempts = DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  pipelineConfig?: PipelineConfig,
  workDir?: string,
  authenticatedPlanHash?: string | null,
  affectedCases?: ChatPipelineTrialPlanRequest['affectedCases'],
  intentText?: string,
  pinnedRequirements: readonly import('./chat-trial-resilience-rules.js').ExplicitResilienceObligation[] = [],
): ChatPipelineTrialPlanReadResult {
  if (!isValidChatPipelineTrialPlanAttempts(maxAttempts)) {
    throw new Error('Trial plan max attempts is invalid.');
  }
  if (pipelineConfig && !intentText) {
    const plan = hostFixedPromptTrialPlan(pipelineConfig, pipelineHash, workDir);
    if (plan)
      return {
        status: 'ready',
        plan,
        planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
      };
  }
  const path = pipelineTrialPlanPath(stagedYamlPath);
  let reviewedRequirements:
    readonly import('./chat-trial-resilience-rules.js').ExplicitResilienceObligation[] | undefined;
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
    const planHash = createHash('sha256').update(content).digest('hex');
    if (authenticatedPlanHash === planHash)
      reviewedRequirements = requiredTrialEvidence(
        plan,
        intentText ? trialIntentDigest(intentText) : undefined,
        pinnedRequirements,
      );
    validateChatPipelineTrialPlanTargetPaths(plan, relativeYamlPath);
    validateChatPipelineTrialFixtureSetup(plan, stagedYamlPath, relativeYamlPath);
    if (affectedCases?.length) {
      const unchanged = affectedCases.filter((affected) => {
        const current = plan.cases.find((item) => item.id === affected.caseId);
        return current && chatPipelineTrialCaseExecutionHash(current) === affected.originalCaseHash;
      });
      if (unchanged.length) {
        return planRequest(
          'invalid',
          relativeYamlPath,
          pipelineHash,
          `Committed Trial Plan did not revise affected case(s): ${unchanged.map((item) => item.caseId).join(', ')}. Correct those cases before repeating Trial.`,
          maxAttempts,
        );
      }
    }
    if (pipelineConfig && workDir) {
      validateChatPipelineTrialPlanTaskPathCoordinates(
        plan,
        pipelineConfig,
        relativeYamlPath,
        workDir,
      );
    }
    if (plan.yamlHash !== pipelineHash) {
      return planRequest(
        'stale',
        relativeYamlPath,
        pipelineHash,
        'The trial plan targets an older YAML revision.',
        maxAttempts,
      );
    }
    const committedPlanHash =
      authenticatedPlanHash === undefined
        ? readChatPipelineTrialPlanToolTelemetry(stagedYamlPath, maxAttempts).committedPlanHash
        : authenticatedPlanHash;
    if (committedPlanHash !== planHash) {
      return planRequest(
        'invalid',
        relativeYamlPath,
        pipelineHash,
        'The trial plan was not committed by the host-authorized trial plan tool for this exact content.',
        maxAttempts,
      );
    }
    const requirements = requiredTrialEvidence(
      plan,
      intentText ? trialIntentDigest(intentText) : undefined,
      pinnedRequirements,
    );
    reviewedRequirements = requirements;
    {
      const inspection = inspectTrialEvidence(
        requirements,
        plan,
        pipelineConfig,
        workDir ? { relativeYamlPath, workDir } : undefined,
      );
      if (inspection.missing.length) {
        const details = inspection.issues
          .map(
            (issue) =>
              (issue.caseId ?? 'plan') +
              ':' +
              issue.field +
              ' [' +
              issue.code +
              '] ' +
              issue.message,
          )
          .join('\n');
        const response = planRequest(
          'invalid',
          relativeYamlPath,
          pipelineHash,
          'Required structured Trial evidence is incomplete: ' +
            inspection.missing.join(', ') +
            '.\n' +
            details,
          maxAttempts,
          inspection.issues.some((issue) => issue.repairScope === 'pipeline-artifact')
            ? 'recovery_failure_policy'
            : undefined,
        );
        return { ...response, reviewedRequirements: requirements };
      }
    }
    return {
      status: 'ready',
      plan,
      planHash,
      reviewedRequirements: requirements,
    };
  } catch (err) {
    const response = planRequest(
      'invalid',
      relativeYamlPath,
      pipelineHash,
      err instanceof Error ? err.message : String(err),
      maxAttempts,
    );
    if (err instanceof TrialPlanFixtureSetupError && response.status === 'required') {
      response.request.affectedCases = err.affectedCases;
    }
    return { ...response, ...(reviewedRequirements ? { reviewedRequirements } : {}) };
  }
}
