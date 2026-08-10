import { CHAT_PIPELINE_TRIAL_PLAN_CONTRACT } from './chat-pipeline-trial-plan.js';

/**
 * Build the OpenCode custom tool as a self-contained module. The tool runs in
 * the managed OpenCode process, outside the editor sidecar module graph, so the
 * authoritative contract is serialized into the generated source and enforced
 * again before any plan file is written.
 */
export function buildTagmaTrialPlanTool(): string {
  const contract = JSON.stringify(CHAT_PIPELINE_TRIAL_PLAN_CONTRACT);
  return `import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";

const CONTRACT = ${contract};
const REQUIRED_COVERAGE = [...CONTRACT.coverageDimensions];
const COVERAGE_STATUSES = [...CONTRACT.coverageStatuses];
const FINDING_SEVERITIES = [...CONTRACT.findingSeverities];
const FINDING_REPAIR_SCOPES = [...CONTRACT.findingRepairScopes];
const EXPECTATION_TYPES = [...CONTRACT.expectationTypes];
const TASK_STATUSES = [...CONTRACT.taskStatuses];
const PLAN_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const QUALIFIED_TASK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*\\.[A-Za-z_][A-Za-z0-9_-]*$/;
const WINDOWS_RESERVED_CASE_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|[.])/i;

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
  return value;
}

function asArray(value, label, max) {
  if (!Array.isArray(value)) throw new Error(label + " must be an array.");
  if (value.length > max) throw new Error(label + " exceeds the limit of " + max + ".");
  return value;
}

function asString(value, label, maxLength, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(label + (allowEmpty ? " must be a string." : " must be a non-empty string."));
  }
  const measured = allowEmpty ? value : value.trim();
  if (measured.length > maxLength) throw new Error(label + " is too long.");
  return measured;
}

function asInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(label + " must be an integer from " + min + " to " + max + ".");
  }
  return value;
}

function normalizeRelativeCasePath(value, label) {
  const path = asString(value, label, 240).replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\\//.test(path) ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        WINDOWS_RESERVED_CASE_SEGMENT_RE.test(part),
    ) ||
    (parts[0] || "").toLowerCase() === ".tagma"
  ) {
    throw new Error(label + " must stay inside the isolated case workspace and outside .tagma.");
  }
  return path;
}

function validateExpectation(value, label) {
  const raw = asRecord(value, label);
  const type = asString(raw.type, label + ".type", 64);
  if (!EXPECTATION_TYPES.includes(type)) throw new Error(label + ".type is unsupported.");
  if (type === "path-exists" || type === "path-not-exists") {
    normalizeRelativeCasePath(raw.path, label + ".path");
    return raw;
  }
  if (type === "file-equals") {
    asString(raw.text, label + ".text", CONTRACT.limits.textExpectationBytes, true);
    if (new TextEncoder().encode(raw.text).length > CONTRACT.limits.textExpectationBytes) {
      throw new Error(label + ".text exceeds the expectation byte limit.");
    }
    normalizeRelativeCasePath(raw.path, label + ".path");
    return raw;
  }
  if (type === "file-contains" || type === "file-not-contains") {
    const text = asString(raw.text, label + ".text", CONTRACT.limits.textExpectationBytes);
    if (new TextEncoder().encode(text).length > CONTRACT.limits.textExpectationBytes) {
      throw new Error(
        label + ".text exceeds " + CONTRACT.limits.textExpectationBytes + " bytes.",
      );
    }
    normalizeRelativeCasePath(raw.path, label + ".path");
    return raw;
  }
  if (type === "json-valid") {
    normalizeRelativeCasePath(raw.path, label + ".path");
    return raw;
  }
  if (type === "json-pointer-equals") {
    normalizeRelativeCasePath(raw.path, label + ".path");
    const pointer = asString(raw.pointer, label + ".pointer", 512, true);
    if (pointer !== "" && !pointer.startsWith("/")) {
      throw new Error(label + ".pointer must be empty or start with /.");
    }
    if (/~(?:[^01]|$)/u.test(pointer)) {
      throw new Error(label + ".pointer contains an invalid JSON Pointer escape.");
    }
    const expectedJson = asString(
      raw.expectedJson,
      label + ".expectedJson",
      CONTRACT.limits.textExpectationBytes,
    );
    if (new TextEncoder().encode(expectedJson).length > CONTRACT.limits.textExpectationBytes) {
      throw new Error(label + ".expectedJson exceeds the expectation byte limit.");
    }
    try {
      JSON.parse(expectedJson);
    } catch {
      throw new Error(label + ".expectedJson must contain one valid JSON value.");
    }
    return raw;
  }
  if (type === "directory-entry-count") {
    normalizeRelativeCasePath(raw.path, label + ".path");
    if (raw.suffix !== undefined && raw.suffix !== null && raw.suffix !== "") {
      asString(raw.suffix, label + ".suffix", 64);
    }
    const min = raw.min === undefined ? null : asInteger(raw.min, label + ".min", 0, 10000);
    const max = raw.max === undefined ? null : asInteger(raw.max, label + ".max", 0, 10000);
    if (min === null && max === null) throw new Error(label + " requires min or max.");
    if (min !== null && max !== null && min > max) {
      throw new Error(label + ".min cannot exceed max.");
    }
    return raw;
  }
  const taskId = asString(raw.taskId, label + ".taskId", 160);
  if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
    throw new Error(label + ".taskId must be a qualified track.task id.");
  }
  const status = asString(raw.status, label + ".status", 32);
  if (!TASK_STATUSES.includes(status)) throw new Error(label + ".status is invalid.");
  return raw;
}

function validateCase(value, index) {
  const label = "cases[" + index + "]";
  const raw = asRecord(value, label);
  const id = asString(raw.id, label + ".id", 64);
  if (!PLAN_ID_RE.test(id)) throw new Error(label + ".id has an invalid format.");
  const fixtures = asArray(
    raw.fixtures || [],
    label + ".fixtures",
    CONTRACT.limits.fixturesPerCase,
  ).map((fixtureValue, fixtureIndex) => {
    const fixtureLabel = label + ".fixtures[" + fixtureIndex + "]";
    const fixture = asRecord(fixtureValue, fixtureLabel);
    if (typeof fixture.content !== "string") {
      throw new Error(fixtureLabel + ".content must be a string.");
    }
    if (new TextEncoder().encode(fixture.content).length > CONTRACT.limits.fixtureBytes) {
      throw new Error(
        fixtureLabel + ".content exceeds " + CONTRACT.limits.fixtureBytes + " bytes.",
      );
    }
    return {
      path: normalizeRelativeCasePath(fixture.path, fixtureLabel + ".path"),
      content: fixture.content,
    };
  });
  const fixturePaths = fixtures.map((fixture) => fixture.path.toLowerCase());
  if (new Set(fixturePaths).size !== fixturePaths.length) {
    throw new Error(label + ".fixtures must not write the same path twice.");
  }
  const expectations = asArray(
    raw.expectations,
    label + ".expectations",
    CONTRACT.limits.expectationsPerCase,
  ).map((item, expectationIndex) =>
    validateExpectation(item, label + ".expectations[" + expectationIndex + "]"),
  );
  if (expectations.length === 0) {
    throw new Error(label + ".expectations must not be empty.");
  }
  const jsonAwarePaths = new Set(
    expectations
      .filter(
        (expectation) =>
          expectation.type === "json-valid" || expectation.type === "json-pointer-equals",
      )
      .map((expectation) => expectation.path.toLowerCase()),
  );
  for (const expectation of expectations) {
    if (
      !(
        expectation.type === "path-exists" ||
        expectation.type === "file-contains" ||
        expectation.type === "file-not-contains" ||
        expectation.type === "file-equals"
      ) ||
      !expectation.path.toLowerCase().endsWith(".json") ||
      jsonAwarePaths.has(expectation.path.toLowerCase())
    ) {
      continue;
    }
    throw new Error(
      "JSON artifact " +
        expectation.path +
        " requires a json-valid or json-pointer-equals expectation in the same case.",
    );
  }
  if (raw.targetTaskIds === undefined) {
    throw new Error(label + ".targetTaskIds is required.");
  }
  const targetTaskIds = [...new Set(
    asArray(raw.targetTaskIds, label + ".targetTaskIds", 32).map((item, taskIndex) => {
      const taskId = asString(item, label + ".targetTaskIds[" + taskIndex + "]", 160);
      if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
        throw new Error(
          label + ".targetTaskIds[" + taskIndex + "] must be a qualified track.task id.",
        );
      }
      return taskId;
    }),
  )];
  if (targetTaskIds.length === 0) {
    throw new Error(label + ".targetTaskIds must contain at least one qualified track.task id.");
  }
  return {
    ...raw,
    id,
    runs:
      raw.runs === undefined
        ? 1
        : asInteger(raw.runs, label + ".runs", 1, CONTRACT.limits.runs),
    targetTaskIds,
    fixtures,
    expectations,
  };
}

function validateCaseEntries(value, requireNonEmpty) {
  const cases = asArray(value, "trial plan cases", CONTRACT.limits.cases).map(
    validateCase,
  );
  if (requireNonEmpty && cases.length === 0) {
    throw new Error("trial plan cases must contain at least one case.");
  }
  const caseIds = new Set();
  for (const item of cases) {
    if (caseIds.has(item.id)) {
      throw new Error("trial plan case id is duplicated: " + item.id + ".");
    }
    caseIds.add(item.id);
  }
  const totalFixtureBytes = cases
    .flatMap((item) => item.fixtures)
    .reduce(
      (total, fixture) => total + new TextEncoder().encode(fixture.content).length,
      0,
    );
  if (totalFixtureBytes > CONTRACT.limits.totalFixtureBytes) {
    throw new Error(
      "trial plan fixtures exceed " + CONTRACT.limits.totalFixtureBytes + " bytes in total.",
    );
  }
  return cases;
}

function hasDuplicateFixtureBasenames(cases) {
  return cases.some((item) => {
    const basenames = item.fixtures.map(
      (fixture) => fixture.path.split("/").at(-1).toLowerCase(),
    );
    return new Set(basenames).size !== basenames.length;
  });
}

function hasDistinctOutputExpectation(cases) {
  return cases.some((item) => {
    const positivePaths = new Set();
    for (const expectation of item.expectations) {
      if (
        expectation.type === "directory-entry-count" &&
        expectation.min !== undefined &&
        expectation.min !== null &&
        expectation.min >= 2
      ) {
        return true;
      }
      if (
        expectation.type === "path-exists" ||
        expectation.type === "file-contains" ||
        expectation.type === "file-equals" ||
        expectation.type === "json-valid" ||
        expectation.type === "json-pointer-equals"
      ) {
        positivePaths.add(expectation.path.toLowerCase());
      }
    }
    return positivePaths.size >= 2;
  });
}

function validateCoveredCaseEvidence(coverage, cases) {
  const casesById = new Map(cases.map((item) => [item.id, item]));
  const failures = [];
  for (const entry of coverage) {
    if (entry.status !== "covered") continue;
    const linkedCases = entry.caseIds.map((caseId) => casesById.get(caseId)).filter(Boolean);
    let evidenced = true;
    if (entry.dimension === "multiple-inputs") {
      evidenced = linkedCases.some((item) => item.fixtures.length >= 2);
    } else if (entry.dimension === "duplicate-input-names") {
      evidenced = hasDuplicateFixtureBasenames(linkedCases);
    } else if (entry.dimension === "multiline-content") {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) => fixture.content.includes(String.fromCharCode(10))),
      );
    } else if (entry.dimension === "inter-task-output-collision") {
      evidenced = linkedCases.some(
        (item) => item.targetTaskIds.length >= 2 && hasDistinctOutputExpectation([item]),
      );
    } else if (entry.dimension === "repeat-run-output-collision") {
      evidenced = linkedCases.some(
        (item) => item.runs >= 2 && hasDistinctOutputExpectation([item]),
      );
    } else if (entry.dimension === "concurrent-run-output-collision") {
      failures.push(
        "trial plan coverage concurrent-run-output-collision cannot be covered by the sequential trial harness; use accepted-risk, blocked, or not-applicable.",
      );
      continue;
    } else if (entry.dimension === "repeat-run") {
      evidenced = linkedCases.some((item) => item.runs >= 2);
    } else if (entry.dimension === "empty-content") {
      evidenced = linkedCases.some(
        (item) =>
          item.fixtures.some((fixture) => fixture.content.length === 0) &&
          item.expectations.some(
            (expectation) =>
              expectation.type === "file-equals" && expectation.text.length === 0,
          ),
      );
    } else if (entry.dimension === "special-characters") {
      evidenced = linkedCases.some((item) =>
        item.fixtures.some((fixture) =>
          [...fixture.content].some((character) => {
            const codePoint = character.codePointAt(0) || 0;
            return (
              codePoint > 127 ||
              (character.trim().length > 0 && !/[A-Za-z0-9]/.test(character))
            );
          }),
        ),
      );
    }
    if (!evidenced) {
      failures.push(
        "trial plan coverage marks " +
          entry.dimension +
          " covered without concrete linked-case evidence.",
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join(String.fromCharCode(10)));
  }
}

function validateCoverageEntries(value) {
  return asArray(value, 'trial plan coverage', REQUIRED_COVERAGE.length).map(
    (item, index) => {
      const label = 'coverage[' + index + ']';
      const entry = asRecord(item, label);
      const dimension = asString(entry.dimension, label + '.dimension', 64);
      if (!REQUIRED_COVERAGE.includes(dimension)) {
        throw new Error(label + '.dimension is unsupported.');
      }
      const status = asString(entry.status, label + '.status', 32);
      if (!COVERAGE_STATUSES.includes(status)) {
        throw new Error(label + '.status is invalid.');
      }
      const caseIds = asArray(
        entry.caseIds,
        label + '.caseIds',
        CONTRACT.limits.cases,
      ).map((caseId, caseIndex) =>
        asString(caseId, label + '.caseIds[' + caseIndex + ']', 64),
      );
      if (status === 'covered' && caseIds.length === 0) {
        throw new Error(label + ' must reference at least one case when covered.');
      }
      return {
        dimension,
        status,
        caseIds: [...new Set(caseIds)],
        rationale: asString(entry.rationale, label + '.rationale', 1000),
      };
    },
  );
}

function validateCoverageSection(value, cases) {
  const coverage = validateCoverageEntries(value);
  const caseIds = new Set(cases.map((item) => item.id));
  for (const [index, entry] of coverage.entries()) {
    for (const caseId of entry.caseIds) {
      if (!caseIds.has(caseId)) {
        throw new Error("coverage[" + index + "] references unknown case " + caseId + ".");
      }
    }
  }
  const coverageDimensions = new Set(coverage.map((item) => item.dimension));
  for (const dimension of REQUIRED_COVERAGE) {
    if (!coverageDimensions.has(dimension)) {
      throw new Error("trial plan coverage is missing " + dimension + ".");
    }
  }
  if (coverageDimensions.size !== coverage.length) {
    throw new Error("trial plan coverage dimensions must not be duplicated.");
  }
  validateCoveredCaseEvidence(coverage, cases);
  return coverage;
}

function validateFindingEntries(value) {
  return asArray(value, 'trial plan findings', CONTRACT.limits.findings).map(
    (item, index) => {
      const label = 'findings[' + index + ']';
      const finding = asRecord(item, label);
      const severity = asString(finding.severity, label + '.severity', 32);
      if (!FINDING_SEVERITIES.includes(severity)) {
        throw new Error(label + '.severity is invalid.');
      }
      const repairScope = asString(finding.repairScope, label + '.repairScope', 32);
      if (!FINDING_REPAIR_SCOPES.includes(repairScope)) {
        throw new Error(label + '.repairScope is invalid.');
      }
      return {
        severity,
        repairScope,
        summary: asString(finding.summary, label + '.summary', 500),
        evidence: asString(finding.evidence, label + '.evidence', 2000),
      };
    },
  );
}

function assertValidPlan(value) {
  const raw = asRecord(value, "trial plan");
  if (raw.version !== CONTRACT.version) {
    throw new Error("trial plan version must be " + CONTRACT.version + ".");
  }
  const yamlHash = asString(raw.yamlHash, "trial plan yamlHash", 40);
  if (!/^[0-9a-f]{40}$/i.test(yamlHash)) {
    throw new Error("trial plan yamlHash must be SHA-1.");
  }
  asString(raw.summary, "trial plan summary", 2000);
  const goals = asArray(raw.goals, "trial plan goals", CONTRACT.limits.goals);
  if (goals.length === 0) {
    throw new Error("trial plan goals must contain at least one behavior goal.");
  }
  goals.forEach((goal, index) => asString(goal, "goals[" + index + "]", 1000));

  const cases = validateCaseEntries(raw.cases, true);
  validateCoverageSection(raw.coverage, cases);

  validateFindingEntries(raw.findings || []);
}

function assertTargetPaths(value, relativeYaml) {
  const yaml = relativeYaml.replace(/\\\\/g, '/');
  const slash = yaml.lastIndexOf('/');
  const dir = slash < 0 ? '' : yaml.slice(0, slash + 1);
  const name = slash < 0 ? yaml : yaml.slice(slash + 1);
  const stem = name.replace(/\\.ya?ml$/i, '');
  const blocked = new Set(
    [yaml, ...CONTRACT.pipelineCompanionSuffixes.map((suffix) => dir + stem + suffix)].map(
      (path) => path.toLowerCase(),
    ),
  );
  value.cases.forEach((testCase, caseIndex) => {
    const items = [
      ...testCase.fixtures.map((item, index) => ['fixtures', index, item.path]),
      ...testCase.expectations
        .map((item, index) => ['expectations', index, item.path])
        .filter((item) => typeof item[2] === 'string'),
    ];
    for (const [kind, index, path] of items) {
      if (blocked.has(path.toLowerCase())) {
        throw new Error('cases[' + caseIndex + '].' + kind + '[' + index + '].path must target case fixtures or outputs, not staged pipeline artifacts (' + path + ').');
      }
    }
  });
}

function portablePath(value) {
  return resolve(value).replace(/\\\\/g, "/");
}

function assertStagedAgentRoot(root) {
  if (!/\\/\\.tagma\\/\\.chat-staging\\/[^/]+\\/agent-workspace\\/\\.tagma$/i.test(portablePath(root))) {
    throw new Error(
      "trial plans may only be written inside host-owned chat staging; use the exact Target YAML path and never copy files to live .tagma",
    );
  }
}

function resolvePipelineTarget(input, contextDirectory) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("pipeline_path must be a non-empty path");
  const yamlPath = isAbsolute(raw)
    ? resolve(raw)
    : resolve(contextDirectory, ...raw.replace(/\\\\/g, "/").replace(/^\\.\\//, "").split("/"));
  const root = isAbsolute(raw) ? dirname(dirname(yamlPath)) : resolve(contextDirectory);
  assertStagedAgentRoot(root);
  const rel = relative(root, yamlPath);
  const parts = rel.replace(/\\\\/g, "/").split("/");
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\\\") ||
    parts.length !== 2 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("pipeline_path must be <stem>/<stem>.yaml inside the staged pipeline root");
  }
  const yamlName = parts[1];
  const stem = yamlName.replace(/\\.ya?ml$/i, "");
  if (!/\\.ya?ml$/i.test(yamlName) || parts[0] !== stem) {
    throw new Error("pipeline_path folder and YAML stem must match");
  }
  const stat = lstatSync(yamlPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("pipeline_path must be a regular file");
  }
  if (basename(dirname(yamlPath)) !== stem) {
    throw new Error("pipeline_path has an invalid folder");
  }
  return { root, yamlPath };
}

const TRIAL_PLAN_ATTEMPT_TELEMETRY_VERSION = 2;
const TRIAL_PLAN_DRAFT_VERSION = 2;
const TOOL_ATTEMPT_LIMITS = CONTRACT.limits.toolAttemptsPerYaml;
const MAX_REJECTION_SUMMARIES = CONTRACT.limits.rejectionSummaries;
const DRAFT_OPERATIONS = ['begin', 'upsert-case', 'set-coverage', 'set-findings', 'commit'];
const HOST_ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function readTrialPlanStageConfig(stageRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(stageRoot, 'stage.json'), 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { maxAttempts: TOOL_ATTEMPT_LIMITS.default, trialPlanAttempt: null };
    }
    throw new Error('chat stage attempt budget is invalid; discard this chat stage before retrying');
  }
  const value = parsed && typeof parsed === 'object' ? parsed.trialPlanMaxAttempts : undefined;
  const maxAttempts = value === undefined ? TOOL_ATTEMPT_LIMITS.default : value;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < TOOL_ATTEMPT_LIMITS.min ||
    maxAttempts > TOOL_ATTEMPT_LIMITS.max
  ) {
    throw new Error('chat stage attempt budget is invalid; discard this chat stage before retrying');
  }
  const attempt = parsed && typeof parsed === 'object' ? parsed.trialPlanAttempt : null;
  const trialPlanAttempt =
    attempt &&
    typeof attempt === 'object' &&
    typeof attempt.relativePath === 'string' &&
    typeof attempt.yamlHash === 'string' &&
    /^[0-9a-f]{40}$/.test(attempt.yamlHash) &&
    typeof attempt.attemptId === 'string' &&
    HOST_ATTEMPT_ID_RE.test(attempt.attemptId)
      ? attempt
      : null;
  return { maxAttempts, trialPlanAttempt };
}

function trialPlanAttemptPaths(root, yamlPath, yamlHash) {
  const stageRoot = dirname(dirname(root));
  const stageConfig = readTrialPlanStageConfig(stageRoot);
  const relativeYamlPath = relative(root, yamlPath).replace(/\\\\/g, "/");
  const key = createHash("sha256")
    .update(relativeYamlPath + String.fromCharCode(0) + yamlHash)
    .digest("hex");
  const telemetryDir = join(stageRoot, ".trial-plan-telemetry");
  const draftDir = join(stageRoot, ".trial-plan-drafts");
  return {
    relativeYamlPath,
    telemetryDir,
    draftDir,
    maxAttempts: stageConfig.maxAttempts,
    hostAttempt: stageConfig.trialPlanAttempt,
    telemetryPath: join(telemetryDir, key + ".json"),
    draftPath: join(draftDir, key + ".json"),
    lockPath: join(telemetryDir, key + ".lock"),
  };
}

function acquireTrialPlanLock(paths) {
  mkdirSync(paths.telemetryDir, { recursive: true });
  try {
    const lockFd = openSync(paths.lockPath, "wx");
    closeSync(lockFd);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("another trial plan tool operation is already in progress");
    }
    throw error;
  }
}

function withTrialPlanDraftLock(paths, callback) {
  acquireTrialPlanLock(paths);
  try {
    return callback();
  } finally {
    rmSync(paths.lockPath, { force: true });
  }
}

function newTrialPlanDraft(paths, yamlHash, attemptId, summary, goals) {
  return {
    draftVersion: TRIAL_PLAN_DRAFT_VERSION,
    version: CONTRACT.version,
    yamlHash,
    relativeYamlPath: paths.relativeYamlPath,
    attemptId,
    summary,
    goals,
    coverage: [],
    findings: [],
    cases: [],
    commitAttempted: false,
  };
}

function assertTrialPlanDraft(value, paths, yamlHash) {
  const draft = asRecord(value, 'trial plan draft');
  if (
    draft.draftVersion !== TRIAL_PLAN_DRAFT_VERSION ||
    draft.version !== CONTRACT.version ||
    draft.yamlHash !== yamlHash ||
    draft.relativeYamlPath !== paths.relativeYamlPath ||
    typeof draft.attemptId !== 'string' ||
    !HOST_ATTEMPT_ID_RE.test(draft.attemptId) ||
    !Array.isArray(draft.goals) ||
    !Array.isArray(draft.coverage) ||
    !Array.isArray(draft.findings) ||
    !Array.isArray(draft.cases) ||
    (draft.commitAttempted !== undefined && typeof draft.commitAttempted !== 'boolean')
  ) {
    throw new Error('trial plan draft does not match the staged YAML revision');
  }
  draft.summary = asString(draft.summary, 'trial plan summary', 2000);
  draft.goals = asArray(draft.goals, 'trial plan goals', CONTRACT.limits.goals).map(
    (goal, index) => asString(goal, 'goals[' + index + ']', 1000),
  );
  if (draft.goals.length === 0) {
    throw new Error('trial plan goals must contain at least one behavior goal.');
  }
  draft.cases = validateCaseEntries(draft.cases, false);
  assertTargetPaths(draft, paths.relativeYamlPath);
  draft.coverage =
    draft.coverage.length === 0
      ? []
      : validateCoverageSection(draft.coverage, draft.cases);
  draft.findings = validateFindingEntries(draft.findings);
  draft.commitAttempted = draft.commitAttempted === true;
  return draft;
}

function assertTrialPlanDraftOpen(draft) {
  if (draft.commitAttempted) {
    throw new Error('trial plan draft commit was already attempted; call begin before editing it');
  }
}

function readTrialPlanDraftIfExists(paths, yamlHash) {
  let raw;
  try {
    const stat = lstatSync(paths.draftPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > CONTRACT.limits.planBytes) {
      throw new Error('trial plan draft must be a bounded regular file');
    }
    raw = JSON.parse(readFileSync(paths.draftPath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return assertTrialPlanDraft(raw, paths, yamlHash);
}

function readTrialPlanDraft(paths, yamlHash) {
  const draft = readTrialPlanDraftIfExists(paths, yamlHash);
  if (!draft) {
    throw new Error('trial plan draft is missing; call begin before adding sections');
  }
  return draft;
}

function writeTrialPlanDraft(paths, draft) {
  const serialized = JSON.stringify(draft, null, 2) + String.fromCharCode(10);
  if (new TextEncoder().encode(serialized).length > CONTRACT.limits.planBytes) {
    throw new Error('trial plan draft exceeds the plan byte limit');
  }
  mkdirSync(paths.draftDir, { recursive: true });
  const tempPath = paths.draftPath + '.' + randomUUID() + '.tmp';
  writeFileSync(tempPath, serialized, 'utf8');
  renameSync(tempPath, paths.draftPath);
}

function trialPlanDraftResult(operation, draft) {
  return JSON.stringify(
    {
      operation,
      yamlHash: draft.yamlHash,
      cases: draft.cases.length,
      coverage: draft.coverage.length,
      findings: draft.findings.length,
      commitAvailable: draft.commitAttempted !== true,
    },
    null,
    2,
  );
}

function newTrialPlanAttemptTelemetry(yamlHash, relativeYamlPath) {
  return {
    version: TRIAL_PLAN_ATTEMPT_TELEMETRY_VERSION,
    yamlHash,
    relativeYamlPath,
    attemptIds: [],
    toolAttemptCount: 0,
    validationRejectionCount: 0,
    repeatedValidationRejectionCount: 0,
    successfulWriteCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    rejections: [],
  };
}

function isTelemetryInteger(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function isValidTrialPlanAttemptTelemetry(parsed, paths, yamlHash) {
  if (
    parsed.version !== TRIAL_PLAN_ATTEMPT_TELEMETRY_VERSION ||
    parsed.yamlHash !== yamlHash ||
    parsed.relativeYamlPath !== paths.relativeYamlPath ||
    !Array.isArray(parsed.attemptIds) ||
    parsed.attemptIds.length !== parsed.toolAttemptCount ||
    parsed.attemptIds.length > paths.maxAttempts ||
    new Set(parsed.attemptIds).size !== parsed.attemptIds.length ||
    !parsed.attemptIds.every(
      (attemptId) => typeof attemptId === 'string' && HOST_ATTEMPT_ID_RE.test(attemptId),
    ) ||
    !isTelemetryInteger(parsed.toolAttemptCount, paths.maxAttempts) ||
    !isTelemetryInteger(parsed.validationRejectionCount, parsed.toolAttemptCount) ||
    !isTelemetryInteger(parsed.repeatedValidationRejectionCount, parsed.validationRejectionCount) ||
    !isTelemetryInteger(parsed.successfulWriteCount, parsed.toolAttemptCount) ||
    parsed.validationRejectionCount + parsed.successfulWriteCount !== parsed.toolAttemptCount ||
    !Array.isArray(parsed.rejections) ||
    parsed.rejections.length > MAX_REJECTION_SUMMARIES
  ) {
    return false;
  }
  const timestampsValid =
    parsed.toolAttemptCount === 0
      ? parsed.firstAttemptAt === null && parsed.lastAttemptAt === null
      : Number.isSafeInteger(parsed.firstAttemptAt) &&
        parsed.firstAttemptAt >= 0 &&
        Number.isSafeInteger(parsed.lastAttemptAt) &&
        parsed.lastAttemptAt >= parsed.firstAttemptAt;
  return (
    timestampsValid &&
    parsed.rejections.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.fingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(item.fingerprint) &&
        isTelemetryInteger(item.count, parsed.validationRejectionCount) &&
        item.count > 0 &&
        typeof item.message === "string" &&
        item.message.length > 0 &&
        item.message.length <= 500,
    )
  );
}

function readTrialPlanAttemptTelemetry(paths, yamlHash) {
  try {
    const parsed = JSON.parse(readFileSync(paths.telemetryPath, "utf8"));
    if (!isValidTrialPlanAttemptTelemetry(parsed, paths, yamlHash)) {
      throw new Error("invalid telemetry shape");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return newTrialPlanAttemptTelemetry(yamlHash, paths.relativeYamlPath);
    }
    throw new Error(
      "trial plan attempt telemetry is invalid; discard this chat stage before retrying",
    );
  }
}

function writeTrialPlanAttemptTelemetry(paths, telemetry) {
  const tempPath = paths.telemetryPath + "." + randomUUID() + ".tmp";
  writeFileSync(tempPath, JSON.stringify(telemetry, null, 2) + "\\n", "utf8");
  renameSync(tempPath, paths.telemetryPath);
}

function beginTrialPlanAttempt(paths, yamlHash, attemptId) {
  acquireTrialPlanLock(paths);
  try {
    const draft = readTrialPlanDraft(paths, yamlHash);
    assertTrialPlanDraftOpen(draft);
    if (draft.attemptId !== attemptId) {
      throw new Error('trial plan draft belongs to a different host attempt; call begin first');
    }
    const telemetry = readTrialPlanAttemptTelemetry(paths, yamlHash);
    if (telemetry.attemptIds.includes(attemptId)) {
      throw new Error(
        'trial plan commit was already submitted for this host attempt; wait for host continuation',
      );
    }
    if (telemetry.toolAttemptCount >= paths.maxAttempts) {
      throw new Error(
        "trial plan tool attempt budget exhausted for this staged YAML revision",
      );
    }
    draft.commitAttempted = true;
    writeTrialPlanDraft(paths, draft);
    const now = Date.now();
    telemetry.toolAttemptCount += 1;
    telemetry.attemptIds.push(attemptId);
    telemetry.firstAttemptAt = telemetry.firstAttemptAt || now;
    telemetry.lastAttemptAt = now;
    writeTrialPlanAttemptTelemetry(paths, telemetry);
    return { paths, telemetry, draft };
  } catch (error) {
    rmSync(paths.lockPath, { force: true });
    throw error;
  }
}

function rejectionSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\\s+/g, " ").trim().slice(0, 500) || "unknown validation rejection";
}

function recordTrialPlanRejection(attempt, error) {
  try {
    const message = rejectionSummary(error);
    const fingerprint = createHash("sha256").update(message).digest("hex");
    let rejection = attempt.telemetry.rejections.find(
      (item) => item.fingerprint === fingerprint,
    );
    if (!rejection) {
      rejection = { fingerprint, count: 0, message };
      attempt.telemetry.rejections.push(rejection);
      attempt.telemetry.rejections = attempt.telemetry.rejections.slice(
        -MAX_REJECTION_SUMMARIES,
      );
    }
    rejection.count += 1;
    attempt.telemetry.validationRejectionCount += 1;
    if (rejection.count > 1) attempt.telemetry.repeatedValidationRejectionCount += 1;
    writeTrialPlanAttemptTelemetry(attempt.paths, attempt.telemetry);
    if (rejection.count > 1) {
      throw new Error(
        "Repeated equivalent validation rejection (" +
          rejection.count +
          "x): " +
          rejection.message,
      );
    }
    throw error;
  } finally {
    rmSync(attempt.paths.lockPath, { force: true });
  }
}

function recordTrialPlanSuccess(attempt) {
  try {
    attempt.telemetry.successfulWriteCount += 1;
    writeTrialPlanAttemptTelemetry(attempt.paths, attempt.telemetry);
  } finally {
    rmSync(attempt.paths.lockPath, { force: true });
  }
}

const expectationSchema = tool.schema.discriminatedUnion("type", [
  tool.schema.object({
    type: tool.schema.literal("path-exists"),
    path: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("path-not-exists"),
    path: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("file-contains"),
    path: tool.schema.string(),
    text: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("file-not-contains"),
    path: tool.schema.string(),
    text: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("file-equals"),
    path: tool.schema.string(),
    text: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("json-valid"),
    path: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("json-pointer-equals"),
    path: tool.schema.string(),
    pointer: tool.schema.string(),
    expectedJson: tool.schema.string(),
  }),
  tool.schema.object({
    type: tool.schema.literal("directory-entry-count"),
    path: tool.schema.string(),
    suffix: tool.schema.string().optional(),
    min: tool.schema.number().int().min(0).max(10000).optional(),
    max: tool.schema.number().int().min(0).max(10000).optional(),
  }),
  tool.schema.object({
    type: tool.schema.literal("task-status"),
    taskId: tool.schema.string(),
    status: tool.schema.enum(TASK_STATUSES),
  }),
]);

const coverageEntrySchema = tool.schema.object({
  dimension: tool.schema.enum(REQUIRED_COVERAGE),
  status: tool.schema.enum(COVERAGE_STATUSES),
  caseIds: tool.schema.array(tool.schema.string()).max(CONTRACT.limits.cases),
  rationale: tool.schema.string().min(1).max(1000),
});

const findingSchema = tool.schema.object({
  severity: tool.schema.enum(FINDING_SEVERITIES),
  repairScope: tool.schema.enum(FINDING_REPAIR_SCOPES),
  summary: tool.schema.string().min(1).max(500),
  evidence: tool.schema.string().min(1).max(2000),
});

const caseSchema = tool.schema.object({
  id: tool.schema.string(),
  title: tool.schema.string().min(1).max(240),
  objective: tool.schema.string().min(1).max(1000),
  runs: tool.schema.number().int().min(1).max(CONTRACT.limits.runs).optional(),
  targetTaskIds: tool.schema.array(tool.schema.string()).min(1).max(32),
  fixtures: tool.schema
    .array(
      tool.schema.object({
        path: tool.schema.string(),
        content: tool.schema.string(),
      }),
    )
    .max(CONTRACT.limits.fixturesPerCase),
  expectations: tool.schema
    .array(expectationSchema)
    .min(1)
    .max(CONTRACT.limits.expectationsPerCase),
});

function commitTrialPlanDraft(input) {
  const attempt = beginTrialPlanAttempt(input.paths, input.yamlHash, input.attemptId);
  const planPath =
    input.yamlPath.slice(0, input.yamlPath.lastIndexOf('.')) + '.trial-plan.json';
  try {
    const draft = attempt.draft;
    const plan = {
      version: CONTRACT.version,
      yamlHash: input.yamlHash,
      summary: draft.summary,
      goals: draft.goals,
      coverage: draft.coverage,
      findings: draft.findings,
      cases: draft.cases,
    };
    assertValidPlan(plan);
    assertTargetPaths(
      plan,
      relative(input.root, input.yamlPath).replaceAll(String.fromCharCode(92), '/'),
    );
    const serialized = JSON.stringify(plan, null, 2) + String.fromCharCode(10);
    if (new TextEncoder().encode(serialized).length > CONTRACT.limits.planBytes) {
      throw new Error('trial plan exceeds the plan byte limit');
    }
    const tempPath = planPath + '.' + randomUUID() + '.tmp';
    writeFileSync(tempPath, serialized, 'utf8');
    renameSync(tempPath, planPath);
  } catch (error) {
    return recordTrialPlanRejection(attempt, error);
  }
  recordTrialPlanSuccess(attempt);
  return JSON.stringify(
    {
      path: relative(input.root, planPath).replaceAll(String.fromCharCode(92), '/'),
      yamlHash: input.yamlHash,
    },
    null,
    2,
  );
}

function executeExistingTrialPlanDraftOperation(input) {
  if (input.operation === 'commit') {
    return commitTrialPlanDraft(input);
  }
  return withTrialPlanDraftLock(input.paths, () => {
    const draft = readTrialPlanDraft(input.paths, input.yamlHash);
    if (draft.attemptId !== input.attemptId) {
      throw new Error('trial plan draft belongs to a different host attempt; call begin first');
    }
    assertTrialPlanDraftOpen(draft);
    if (input.operation === 'upsert-case') {
      const existingIndex = draft.cases.findIndex(
        (item) => item && typeof item === 'object' && item.id === input.args.case?.id,
      );
      const draftIndex = existingIndex < 0 ? draft.cases.length : existingIndex;
      if (existingIndex < 0 && draft.cases.length >= CONTRACT.limits.cases) {
        throw new Error('trial plan cases exceed the case limit');
      }
      const nextCases = [...draft.cases];
      nextCases[draftIndex] = input.args.case;
      const validatedCases = validateCaseEntries(nextCases, false);
      assertTargetPaths({ cases: validatedCases }, input.paths.relativeYamlPath);
      if (draft.coverage.length > 0) {
        validateCoverageSection(draft.coverage, validatedCases);
      }
      draft.cases = validatedCases;
    } else if (input.operation === 'set-coverage') {
      draft.coverage = validateCoverageSection(input.args.coverage, draft.cases);
    } else if (input.operation === 'set-findings') {
      draft.findings = validateFindingEntries(input.args.findings);
    }
    writeTrialPlanDraft(input.paths, draft);
    return trialPlanDraftResult(input.operation, draft);
  });
}

function executeTrialPlanOperation(args, context) {
  const operation = asString(args.operation, 'operation', 32);
  if (!DRAFT_OPERATIONS.includes(operation)) {
    throw new Error('operation is unsupported');
  }
  const { root, yamlPath } = resolvePipelineTarget(args.pipeline_path, context.directory);
  const attemptId = asString(args.attempt_id, 'attempt_id', 128);
  if (!HOST_ATTEMPT_ID_RE.test(attemptId)) {
    throw new Error('attempt_id must be the exact host-issued attempt ID');
  }
  const yamlHash = createHash('sha1').update(readFileSync(yamlPath, 'utf8')).digest('hex');
  const paths = trialPlanAttemptPaths(root, yamlPath, yamlHash);
  if (
    !paths.hostAttempt ||
    paths.hostAttempt.attemptId !== attemptId ||
    paths.hostAttempt.yamlHash !== yamlHash ||
    paths.hostAttempt.relativePath.replace(/\\\\/g, '/') !== paths.relativeYamlPath
  ) {
    throw new Error(
      'attempt_id was not issued by the host for this staged YAML revision; use the exact current host prompt',
    );
  }

  if (operation === 'begin') {
    const summary = asString(args.summary, 'summary', 2000);
    const goals = asArray(args.goals, 'goals', CONTRACT.limits.goals).map((goal, index) =>
      asString(goal, 'goals[' + index + ']', 1000),
    );
    if (goals.length === 0) {
      throw new Error('goals must contain at least one behavior goal');
    }
    if (args.reset !== undefined && typeof args.reset !== 'boolean') {
      throw new Error('reset must be a boolean');
    }
    return withTrialPlanDraftLock(paths, () => {
      const telemetry = readTrialPlanAttemptTelemetry(paths, yamlHash);
      if (telemetry.attemptIds.includes(attemptId)) {
        throw new Error(
          'trial plan commit was already submitted for this host attempt; wait for host continuation',
        );
      }
      const draft =
        (args.reset ? null : readTrialPlanDraftIfExists(paths, yamlHash)) ||
        newTrialPlanDraft(paths, yamlHash, attemptId, summary, goals);
      draft.commitAttempted = false;
      draft.attemptId = attemptId;
      draft.summary = summary;
      draft.goals = goals;
      writeTrialPlanDraft(paths, draft);
      return trialPlanDraftResult(operation, draft);
    });
  }

  return executeExistingTrialPlanDraftOperation({
    args,
    attemptId,
    operation,
    root,
    yamlPath,
    yamlHash,
    paths,
  });
}

export default tool({
  description:
    "Build a targeted trial plan in bounded draft operations, then validate and commit it atomically.",
  args: {
    operation: tool.schema.enum(DRAFT_OPERATIONS).describe(
      "begin creates or resumes the revision-bound draft, upsert-case adds one case, set-coverage and set-findings replace those sections, and commit performs the single counted validation/write attempt.",
    ),
    pipeline_path: tool.schema
      .string()
      .describe("Exact staged Target YAML path from the host prompt, or staged-root relative <stem>/<stem>.yaml"),
    attempt_id: tool.schema
      .string()
      .min(1)
      .max(128)
      .describe("Exact Host attempt ID from the current host prompt; every call in the draft lifecycle must use the same value."),
    summary: tool.schema.string().min(1).max(2000).optional(),
    goals: tool.schema
      .array(tool.schema.string().min(1).max(1000))
      .min(1)
      .max(CONTRACT.limits.goals)
      .optional(),
    reset: tool.schema
      .boolean()
      .optional()
      .describe("Use only with begin to discard a prior draft for this exact path and YAML hash."),
    coverage: tool.schema
      .array(coverageEntrySchema)
      .max(REQUIRED_COVERAGE.length)
      .optional(),
    findings: tool.schema
      .array(findingSchema)
      .max(CONTRACT.limits.findings)
      .optional(),
    case: caseSchema.optional(),
  },
  async execute(args, context) {
    return executeTrialPlanOperation(args, context);
  },
});
`;
}
