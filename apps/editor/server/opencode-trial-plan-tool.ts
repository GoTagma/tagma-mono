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
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { tool } from "@opencode-ai/plugin";

const CONTRACT = ${contract};
const REQUIRED_COVERAGE = [...CONTRACT.coverageDimensions];
const COVERAGE_STATUSES = [...CONTRACT.coverageStatuses];
const FINDING_SEVERITIES = [...CONTRACT.findingSeverities];
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
  const targetTaskIds = asArray(raw.targetTaskIds || [], label + ".targetTaskIds", 32).map(
    (item, taskIndex) => {
      const taskId = asString(item, label + ".targetTaskIds[" + taskIndex + "]", 160);
      if (!QUALIFIED_TASK_ID_RE.test(taskId)) {
        throw new Error(
          label + ".targetTaskIds[" + taskIndex + "] must be a qualified track.task id.",
        );
      }
      return taskId;
    },
  );
  return {
    ...raw,
    id,
    runs:
      raw.runs === undefined
        ? 1
        : asInteger(raw.runs, label + ".runs", 1, CONTRACT.limits.runs),
    targetTaskIds: [...new Set(targetTaskIds)],
    fixtures,
    expectations,
  };
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
        expectation.type === "file-equals"
      ) {
        positivePaths.add(expectation.path.toLowerCase());
      }
    }
    return positivePaths.size >= 2;
  });
}

function validateCoveredCaseEvidence(coverage, cases) {
  const casesById = new Map(cases.map((item) => [item.id, item]));
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
    } else if (entry.dimension === "output-collision") {
      evidenced = hasDistinctOutputExpectation(linkedCases);
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
      throw new Error(
        "trial plan coverage marks " +
          entry.dimension +
          " covered without concrete linked-case evidence.",
      );
    }
  }
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

  const cases = asArray(raw.cases, "trial plan cases", CONTRACT.limits.cases).map(
    validateCase,
  );
  if (cases.length === 0) throw new Error("trial plan cases must contain at least one case.");
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

  const coverage = asArray(
    raw.coverage,
    "trial plan coverage",
    REQUIRED_COVERAGE.length,
  ).map((item, index) => {
    const label = "coverage[" + index + "]";
    const entry = asRecord(item, label);
    const dimension = asString(entry.dimension, label + ".dimension", 64);
    if (!REQUIRED_COVERAGE.includes(dimension)) {
      throw new Error(label + ".dimension is unsupported.");
    }
    const status = asString(entry.status, label + ".status", 32);
    if (!COVERAGE_STATUSES.includes(status)) throw new Error(label + ".status is invalid.");
    const linkedCaseIds = asArray(
      entry.caseIds || [],
      label + ".caseIds",
      CONTRACT.limits.cases,
    ).map((caseId, caseIndex) =>
      asString(caseId, label + ".caseIds[" + caseIndex + "]", 64),
    );
    if (status === "covered" && linkedCaseIds.length === 0) {
      throw new Error(label + " must reference at least one case when covered.");
    }
    for (const caseId of linkedCaseIds) {
      if (!caseIds.has(caseId)) {
        throw new Error(label + " references unknown case " + caseId + ".");
      }
    }
    return {
      dimension,
      status,
      caseIds: [...new Set(linkedCaseIds)],
      rationale: asString(entry.rationale, label + ".rationale", 1000),
    };
  });
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

  asArray(raw.findings || [], "trial plan findings", CONTRACT.limits.findings).forEach(
    (item, index) => {
      const label = "findings[" + index + "]";
      const finding = asRecord(item, label);
      const severity = asString(finding.severity, label + ".severity", 32);
      if (!FINDING_SEVERITIES.includes(severity)) {
        throw new Error(label + ".severity is invalid.");
      }
      asString(finding.summary, label + ".summary", 500);
      asString(finding.evidence, label + ".evidence", 2000);
    },
  );
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

export default tool({
  description:
    "Write a fully validated, hash-bound targeted trial plan beside an exact staged YAML target.",
  args: {
    pipeline_path: tool.schema
      .string()
      .describe("Exact staged Target YAML path from the host prompt, or staged-root relative <stem>/<stem>.yaml"),
    summary: tool.schema.string().min(1).max(2000),
    goals: tool.schema.array(tool.schema.string().min(1).max(1000)).min(1).max(CONTRACT.limits.goals),
    coverage: tool.schema
      .array(
        tool.schema.object({
          dimension: tool.schema.enum(REQUIRED_COVERAGE),
          status: tool.schema.enum(COVERAGE_STATUSES),
          caseIds: tool.schema.array(tool.schema.string()).max(CONTRACT.limits.cases),
          rationale: tool.schema.string().min(1).max(1000),
        }),
      )
      .max(REQUIRED_COVERAGE.length),
    findings: tool.schema
      .array(
        tool.schema.object({
          severity: tool.schema.enum(FINDING_SEVERITIES),
          summary: tool.schema.string().min(1).max(500),
          evidence: tool.schema.string().min(1).max(2000),
        }),
      )
      .max(CONTRACT.limits.findings),
    cases: tool.schema
      .array(
        tool.schema.object({
          id: tool.schema.string(),
          title: tool.schema.string().min(1).max(240),
          objective: tool.schema.string().min(1).max(1000),
          runs: tool.schema.number().int().min(1).max(CONTRACT.limits.runs).optional(),
          targetTaskIds: tool.schema.array(tool.schema.string()).max(32).optional(),
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
        }),
      )
      .min(1)
      .max(CONTRACT.limits.cases),
  },
  async execute(args, context) {
    const { root, yamlPath } = resolvePipelineTarget(args.pipeline_path, context.directory);
    const yamlHash = createHash("sha1").update(readFileSync(yamlPath, "utf8")).digest("hex");
    const planPath = yamlPath.replace(/\\.ya?ml$/i, ".trial-plan.json");
    const plan = {
      version: CONTRACT.version,
      yamlHash,
      summary: args.summary,
      goals: args.goals,
      coverage: args.coverage,
      findings: args.findings,
      cases: args.cases.map((item) => ({
        ...item,
        runs: item.runs === undefined ? 1 : item.runs,
        targetTaskIds: item.targetTaskIds || [],
      })),
    };
    assertValidPlan(plan);
    const tempPath = planPath + "." + randomUUID() + ".tmp";
    writeFileSync(tempPath, JSON.stringify(plan, null, 2) + "\\n", "utf8");
    renameSync(tempPath, planPath);
    return JSON.stringify(
      { path: relative(root, planPath).replace(/\\\\/g, "/"), yamlHash },
      null,
      2,
    );
  },
});
`;
}
