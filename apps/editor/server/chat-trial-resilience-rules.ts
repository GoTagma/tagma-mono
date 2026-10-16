import type {
  ChatPipelineTrialPlan,
  ChatPipelineTrialPlanCase,
  ChatPipelineTrialExpectation,
} from './chat-pipeline-trial-plan.js';
import type { TrialPlanPathCoordinateContext } from './chat-trial-path-coordinate-rules.js';

export const TRIAL_EVIDENCE_KINDS = [
  'timeout-recovery',
  'failure-recovery',
  'empty-result',
  'unlocated-source',
  'source-preservation',
] as const;
export type ExplicitResilienceObligation = (typeof TRIAL_EVIDENCE_KINDS)[number];
export type TrialCoreWitness =
  | {
      readonly status: 'covered';
      readonly normalCaseId: string;
      readonly taskRoles: readonly {
        readonly taskId: string;
        readonly role: 'content' | 'execution';
        readonly rationale: string;
        readonly expectationIndices: readonly number[];
      }[];
      readonly generatedInputs: readonly {
        readonly path: string;
        readonly producerTaskId: string;
        readonly consumerTaskId: string;
      }[];
    }
  | {
      readonly status: 'blocked';
      readonly taskIds: readonly string[];
      readonly code: string;
      readonly rationale: string;
    };
export interface TrialEvidenceReview {
  readonly version: 1;
  readonly intentDigest: string;
  readonly coreWitness?: TrialCoreWitness;
  readonly decisions: readonly {
    readonly type: ExplicitResilienceObligation;
    readonly required: boolean;
    readonly taskIds: readonly string[];
    readonly rationale: string;
  }[];
}
export type TrialControlledFault =
  | { readonly type: 'task-timeout'; readonly taskId: string; readonly timeoutMs: number }
  | { readonly type: 'task-exit'; readonly taskId: string; readonly exitCode: number }
  | {
      readonly type: 'artifact-replace';
      readonly producerTaskId: string;
      readonly consumerTaskId: string;
      readonly path: string;
      readonly content: string;
    };
export type TrialCaseEvidence =
  | { readonly type: 'source-preservation'; readonly preservationExpectationIndex: number }
  | {
      readonly type: Exclude<ExplicitResilienceObligation, 'source-preservation'>;
      readonly normalCaseId: string;
      readonly recoveredTaskId: string;
      readonly outcomeExpectationIndices: readonly number[];
      readonly fault: TrialControlledFault;
      readonly observationExpectationIndex?: number;
    };
export type TrialResilienceTaskEvidence = Readonly<
  Record<
    string,
    {
      readonly dependsOn: readonly string[];
      readonly kind?: 'command' | 'prompt';
      readonly onFailure?: 'ignore' | 'skip_downstream' | 'stop_all';
      readonly artifactPaths?: readonly string[];
      readonly source?: string;
    }
  >
>;
export interface TrialPlanValidationContext {
  readonly version: 1 | 2;
  readonly obligations: readonly ExplicitResilienceObligation[];
  readonly tasks: TrialResilienceTaskEvidence;
  readonly pathCoordinates?: TrialPlanPathCoordinateContext;
  readonly intentDigest?: string;
  readonly declaredEnvironmentNames?: readonly string[];
}
export interface TrialEvidenceIssue {
  readonly type: ExplicitResilienceObligation;
  readonly caseId: string | null;
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly repairScope: 'pipeline-artifact' | 'diagnostic-only';
}

/** Deterministic protocol checks. Human text never selects an evidence type or outcome. */
export function createTrialResilienceRules() {
  const kinds = [
    'timeout-recovery',
    'failure-recovery',
    'empty-result',
    'unlocated-source',
    'source-preservation',
  ] as const;
  function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(label + ' must be an object.');
    return value as Record<string, unknown>;
  }
  function keys(
    raw: Record<string, unknown>,
    allowed: readonly string[],
    label = 'structured evidence',
  ): void {
    const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
    if (unknown.length)
      throw new Error(
        'Unknown structured evidence field(s) in ' +
          label +
          ': ' +
          unknown
            .slice(0, 8)
            .map((key) => JSON.stringify(key.slice(0, 96)))
            .join(', ') +
          '. Allowed fields: ' +
          allowed.join(', ') +
          '.',
      );
  }
  function taskId(value: unknown, label: string): string {
    const id = text(value, label, 128);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(id))
      throw new Error(label + ' must be a qualified task id.');
    return id;
  }
  function text(value: unknown, label: string, max: number): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      new TextEncoder().encode(value).length > max
    )
      throw new Error(label + ' is invalid or exceeds its bound.');
    return value;
  }
  function index(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= 32)
      throw new Error(label + ' must name an expectation index.');
    return value as number;
  }
  function parseReview(value: unknown): TrialEvidenceReview {
    const raw = record(value, 'evidenceReview');
    keys(raw, ['version', 'intentDigest', 'decisions', 'coreWitness'], 'evidenceReview');
    if (
      raw.version !== 1 ||
      typeof raw.intentDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(raw.intentDigest) ||
      !Array.isArray(raw.decisions) ||
      raw.decisions.length !== kinds.length
    )
      throw new Error(
        'evidenceReview must bind the Host intent digest and review every evidence kind.',
      );
    const decisions = raw.decisions.map((value, i) => {
      const item = record(value, 'evidenceReview.decisions[' + i + ']');
      keys(item, ['type', 'required', 'taskIds', 'rationale'], 'decision');
      if (!kinds.includes(item.type as never) || typeof item.required !== 'boolean')
        throw new Error('Evidence review disposition is invalid.');
      const scope = item.taskIds;
      const scopeLabel = 'evidenceReview.decisions[' + i + '].taskIds (' + String(item.type) + ')';
      if (!Array.isArray(scope)) throw new Error(scopeLabel + ' must be an array.');
      if (scope.length > 32) throw new Error(scopeLabel + ' must contain at most 32 task ids.');
      if (item.required && scope.length === 0)
        throw new Error(scopeLabel + ' must name at least one task when required: true.');
      if (!item.required && scope.length > 0)
        throw new Error(scopeLabel + ' must be empty when required: false.');
      if (
        scope.some(
          (id) =>
            typeof id !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(id),
        )
      )
        throw new Error(scopeLabel + ' must use qualified track.task identifiers.');
      if (new Set(scope).size !== scope.length)
        throw new Error(scopeLabel + ' must contain unique task ids.');
      return {
        type: item.type as ExplicitResilienceObligation,
        required: item.required,
        taskIds: item.taskIds as string[],
        rationale: text(item.rationale, 'evidence review rationale', 1000),
      };
    });
    if (new Set(decisions.map((item) => item.type)).size !== kinds.length)
      throw new Error('Evidence review kinds must not be duplicated.');
    return {
      version: 1,
      intentDigest: raw.intentDigest,
      decisions,
      ...(raw.coreWitness === undefined ? {} : { coreWitness: parseCoreWitness(raw.coreWitness) }),
    };
  }
  function parseCoreWitness(value: unknown): TrialCoreWitness {
    const raw = record(value, 'coreWitness');
    const rationale = (value: unknown): string => {
      const result = text(value, 'core witness rationale', 1000);
      if (result.trim().length === 0)
        throw new Error('Core witness needs a nonempty semantic rationale.');
      return result;
    };
    if (raw.status === 'blocked') {
      keys(raw, ['status', 'taskIds', 'code', 'rationale'], 'coreWitness');
      if (!Array.isArray(raw.taskIds) || raw.taskIds.length === 0 || raw.taskIds.length > 32)
        throw new Error('Blocked core witness must name its bounded responsible task scope.');
      const ids = raw.taskIds.map((id) => taskId(id, 'coreWitness.taskIds'));
      if (new Set(ids).size !== ids.length)
        throw new Error('Core witness task ids must be unique.');
      const code = text(raw.code, 'coreWitness.code', 96);
      if (!/^[a-z][a-z0-9_-]*$/.test(code)) throw new Error('Core witness code must be finite.');
      return { status: 'blocked', taskIds: ids, code, rationale: rationale(raw.rationale) };
    }
    if (raw.status !== 'covered') throw new Error('Core witness must be covered or blocked.');
    keys(raw, ['status', 'normalCaseId', 'taskRoles', 'generatedInputs'], 'coreWitness');
    if (
      !Array.isArray(raw.taskRoles) ||
      raw.taskRoles.length === 0 ||
      raw.taskRoles.length > 32 ||
      !Array.isArray(raw.generatedInputs) ||
      raw.generatedInputs.length > 32
    )
      throw new Error('Core witness mappings must be explicit and bounded.');
    const roles = raw.taskRoles.map((value) => {
      const item = record(value, 'coreWitness.taskRoles');
      keys(item, ['taskId', 'role', 'rationale', 'expectationIndices'], 'coreWitness.taskRoles');
      if (
        !['content', 'execution'].includes(item.role as string) ||
        !Array.isArray(item.expectationIndices) ||
        item.expectationIndices.length > 32 ||
        (item.role === 'content'
          ? item.expectationIndices.length === 0
          : item.expectationIndices.length !== 0)
      )
        throw new Error('Each core task must explicitly review content or execution behavior.');
      const indices = item.expectationIndices.map((value) =>
        index(value, 'core expectation index'),
      );
      if (new Set(indices).size !== indices.length)
        throw new Error('Core expectation indices must be unique.');
      return {
        taskId: taskId(item.taskId, 'core task'),
        role: item.role as 'content' | 'execution',
        rationale: rationale(item.rationale),
        expectationIndices: indices,
      };
    });
    if (new Set(roles.map((role) => role.taskId)).size !== roles.length)
      throw new Error('Core witness must map each task exactly once.');
    const generated = raw.generatedInputs.map((value) => {
      const item = record(value, 'coreWitness.generatedInputs');
      keys(item, ['path', 'producerTaskId', 'consumerTaskId'], 'coreWitness.generatedInputs');
      const path = text(item.path, 'generated core input path', 240);
      if (
        path.startsWith('/') ||
        /^[A-Za-z]:/.test(path) ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Generated core input must use a normalized case-relative path.');
      return {
        path,
        producerTaskId: taskId(item.producerTaskId, 'core producer'),
        consumerTaskId: taskId(item.consumerTaskId, 'core consumer'),
      };
    });
    if (new Set(generated.map((item) => item.path.toLowerCase())).size !== generated.length)
      throw new Error('Generated core input paths must be unique.');
    const normalCaseId = text(raw.normalCaseId, 'core normalCaseId', 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(normalCaseId))
      throw new Error('Core normal case id is invalid.');
    return { status: 'covered', normalCaseId, taskRoles: roles, generatedInputs: generated };
  }
  function parseFault(value: unknown): TrialControlledFault {
    const raw = record(value, 'evidence.fault');
    if (raw.type === 'task-timeout') {
      keys(raw, ['type', 'taskId', 'timeoutMs']);
      if (
        !Number.isInteger(raw.timeoutMs) ||
        (raw.timeoutMs as number) < 1 ||
        (raw.timeoutMs as number) > 5000
      )
        throw new Error('Controlled timeout must be an integer from 1 to 5000ms.');
      return {
        type: raw.type,
        taskId: taskId(raw.taskId, 'fault.taskId'),
        timeoutMs: raw.timeoutMs as number,
      };
    }
    if (raw.type === 'task-exit') {
      keys(raw, ['type', 'taskId', 'exitCode']);
      if (
        !Number.isInteger(raw.exitCode) ||
        (raw.exitCode as number) < 1 ||
        (raw.exitCode as number) > 125
      )
        throw new Error('Controlled exit must be an integer from 1 to 125.');
      return {
        type: raw.type,
        taskId: taskId(raw.taskId, 'fault.taskId'),
        exitCode: raw.exitCode as number,
      };
    }
    if (raw.type === 'artifact-replace') {
      keys(raw, ['type', 'producerTaskId', 'consumerTaskId', 'path', 'content']);
      if (
        typeof raw.content !== 'string' ||
        new TextEncoder().encode(raw.content).length > 64 * 1024
      )
        throw new Error('Controlled artifact bytes exceed their bound.');
      return {
        type: raw.type,
        producerTaskId: taskId(raw.producerTaskId, 'fault.producerTaskId'),
        consumerTaskId: taskId(raw.consumerTaskId, 'fault.consumerTaskId'),
        path: text(raw.path, 'fault.path', 240),
        content: raw.content,
      };
    }
    throw new Error('Unsupported controlled fault type.');
  }
  function parseCaseEvidence(value: unknown): TrialCaseEvidence[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > kinds.length)
      throw new Error('Case evidence must be a bounded array.');
    const evidence = value.map((value): TrialCaseEvidence => {
      const raw = record(value, 'case evidence');
      if (!kinds.includes(raw.type as never)) throw new Error('Case evidence type is unsupported.');
      if (raw.type === 'source-preservation') {
        keys(raw, ['type', 'preservationExpectationIndex']);
        return {
          type: raw.type,
          preservationExpectationIndex: index(
            raw.preservationExpectationIndex,
            'preservationExpectationIndex',
          ),
        };
      }
      keys(raw, [
        'type',
        'normalCaseId',
        'recoveredTaskId',
        'outcomeExpectationIndices',
        'fault',
        'observationExpectationIndex',
      ]);
      if (
        !Array.isArray(raw.outcomeExpectationIndices) ||
        raw.outcomeExpectationIndices.length === 0 ||
        raw.outcomeExpectationIndices.length > 32
      )
        throw new Error('Evidence must reference bounded outcome expectations.');
      const indices = raw.outcomeExpectationIndices.map((item) =>
        index(item, 'outcomeExpectationIndices'),
      );
      if (new Set(indices).size !== indices.length)
        throw new Error('Outcome expectation indices must be unique.');
      return {
        type: raw.type as Exclude<ExplicitResilienceObligation, 'source-preservation'>,
        normalCaseId: text(raw.normalCaseId, 'normalCaseId', 64),
        recoveredTaskId: taskId(raw.recoveredTaskId, 'recoveredTaskId'),
        outcomeExpectationIndices: indices,
        fault: parseFault(raw.fault),
        ...(raw.observationExpectationIndex === undefined
          ? {}
          : {
              observationExpectationIndex: index(
                raw.observationExpectationIndex,
                'observationExpectationIndex',
              ),
            }),
      };
    });
    if (new Set(evidence.map((item) => item.type)).size !== evidence.length)
      throw new Error('Case evidence types must be unique.');
    const faults = evidence
      .filter(
        (item): item is Exclude<TrialCaseEvidence, { type: 'source-preservation' }> =>
          item.type !== 'source-preservation',
      )
      .map((item) => JSON.stringify(item.fault));
    if (new Set(faults).size > 1) throw new Error('A case may induce only one controlled fault.');
    return evidence;
  }
  function parseValidationContext(value: unknown): TrialPlanValidationContext {
    const raw = record(value, 'Trial Plan validation context');
    if (
      ![1, 2].includes(raw.version as number) ||
      !Array.isArray(raw.obligations) ||
      raw.obligations.some((kind) => !kinds.includes(kind as never)) ||
      new Set(raw.obligations).size !== raw.obligations.length
    )
      throw new Error('Trial Plan validation context is invalid.');
    const tasks = record(raw.tasks, 'Trial Plan tasks') as TrialResilienceTaskEvidence;
    if (
      raw.declaredEnvironmentNames !== undefined &&
      (!Array.isArray(raw.declaredEnvironmentNames) ||
        raw.declaredEnvironmentNames.some(
          (name) => typeof name !== 'string' || name.length === 0,
        ) ||
        new Set(raw.declaredEnvironmentNames).size !== raw.declaredEnvironmentNames.length)
    ) {
      throw new Error('Trial Plan declared environment names are invalid.');
    }
    for (const [id, task] of Object.entries(tasks)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ||
        !task ||
        !Array.isArray(task.dependsOn) ||
        task.dependsOn.some((dep) => !Object.prototype.hasOwnProperty.call(tasks, dep))
      )
        throw new Error('Trial Plan task context is invalid.');
      if (
        raw.version === 2 &&
        (!['command', 'prompt'].includes(task.kind!) ||
          !['ignore', 'skip_downstream', 'stop_all'].includes(task.onFailure!))
      )
        throw new Error('Trial Plan task execution context is incomplete.');
    }
    if (
      raw.intentDigest !== undefined &&
      (typeof raw.intentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.intentDigest))
    )
      throw new Error('Trial Plan intent digest is invalid.');
    if (new TextEncoder().encode(JSON.stringify(raw)).length > 2 * 1024 * 1024)
      throw new Error('Trial Plan validation context exceeds its byte bound.');
    return raw as unknown as TrialPlanValidationContext;
  }
  function validateEnvironmentControls(
    cases: readonly ChatPipelineTrialPlanCase[],
    context: TrialPlanValidationContext,
  ): void {
    // Older retained stages have no declaration snapshot; runtime preflight remains authoritative.
    if (context.declaredEnvironmentNames === undefined) return;
    for (const testCase of cases) {
      const undeclared = (testCase.environment ?? []).filter(
        (item) => !context.declaredEnvironmentNames!.includes(item.name),
      );
      if (undeclared.length)
        throw new Error(
          testCase.id +
            ': environment controls must name declared requirements or secrets: ' +
            undeclared.map((item) => item.name).join(', ') +
            '. Declared names: ' +
            (context.declaredEnvironmentNames.join(', ') || '(none)') +
            '. Correct the case before commit; do not invent an environment binding or change production requirements to satisfy Trial.',
        );
    }
  }
  function closure(ids: readonly string[], tasks?: TrialResilienceTaskEvidence): Set<string> {
    const seen = new Set<string>();
    const pending = [...ids];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(tasks?.[id]?.dependsOn ?? []));
    }
    return seen;
  }
  function status(c: ChatPipelineTrialPlanCase, id: string, expected: string): boolean {
    return c.expectations.some(
      (e) => e.type === 'task-status' && e.taskId === id && e.status === expected,
    );
  }
  function sameInputs(a: ChatPipelineTrialPlanCase, b: ChatPipelineTrialPlanCase): boolean {
    const fixtures = (c: ChatPipelineTrialPlanCase) =>
      JSON.stringify([...c.fixtures].sort((a, b) => a.path.localeCompare(b.path)));
    const env = (c: ChatPipelineTrialPlanCase) =>
      JSON.stringify([...(c.environment ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
    return (
      [...a.targetTaskIds].sort().join('\0') === [...b.targetTaskIds].sort().join('\0') &&
      fixtures(a) === fixtures(b) &&
      env(a) === env(b) &&
      [...(a.generatedInputPaths ?? [])].sort().join('\0') ===
        [...(b.generatedInputPaths ?? [])].sort().join('\0') &&
      [...(a.deniedManualTaskIds ?? [])].sort().join('\0') ===
        [...(b.deniedManualTaskIds ?? [])].sort().join('\0')
    );
  }
  function sameJson(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (
      !left ||
      !right ||
      typeof left !== 'object' ||
      typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)
    )
      return false;
    const a = Object.keys(left).sort(),
      b = Object.keys(right).sort();
    return (
      a.length === b.length &&
      a.every(
        (key, i) =>
          key === b[i] &&
          sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
      )
    );
  }
  function contrasted(
    expectation: ChatPipelineTrialExpectation,
    normal: ChatPipelineTrialPlanCase,
  ): boolean {
    if (expectation.type === 'file-contains')
      return (
        normal.expectations.some((e) => e.type === 'path-exists' && e.path === expectation.path) &&
        normal.expectations.some(
          (e) =>
            e.type === 'file-not-contains' &&
            e.path === expectation.path &&
            e.text === expectation.text,
        )
      );
    if (expectation.type === 'json-pointer-equals')
      return normal.expectations.some(
        (e) =>
          e.type === 'json-pointer-equals' &&
          e.path === expectation.path &&
          e.pointer === expectation.pointer &&
          !sameJson(JSON.parse(e.expectedJson), JSON.parse(expectation.expectedJson)),
      );
    return false;
  }
  function preservedSource(testCase: ChatPipelineTrialPlanCase, sourcePath: string): boolean {
    const source = testCase.fixtures.find(
      (item) => item.path === sourcePath && item.content !== null,
    );
    return (
      !!source &&
      testCase.expectations.some(
        (item) =>
          item.type === 'file-equals' && item.path === sourcePath && item.text === source.content,
      )
    );
  }
  function validateCoreWitness(
    plan: ChatPipelineTrialPlan,
    tasks: TrialResilienceTaskEvidence,
    required = false,
  ): void {
    const witness = plan.evidenceReview?.coreWitness;
    if (!witness) {
      if (required)
        throw new Error('Frozen-intent Trial requires an explicit positive coreWitness.');
      return;
    }
    const core = parseCoreWitness(witness);
    const known = (id: string) => Object.prototype.hasOwnProperty.call(tasks, id);
    if (core.status === 'blocked') {
      if (
        core.taskIds.some((id) => !known(id)) ||
        !plan.findings.some(
          (finding) =>
            finding.severity === 'blocking' &&
            (finding.repairScope === 'diagnostic-only' ||
              finding.repairScope === 'pipeline-artifact'),
        )
      )
        throw new Error(
          'Blocked core witness requires known tasks and an existing blocking pipeline-artifact or diagnostic-only finding; it cannot pass Trial.',
        );
      return;
    }
    const normal = plan.cases.find((c) => c.id === core.normalCaseId);
    if (
      !normal ||
      normal.baselineCaseId ||
      (normal.deniedManualTaskIds?.length ?? 0) > 0 ||
      normal.environment?.some((item) => item.value === null) ||
      normal.evidence?.some((item) => item.type !== 'source-preservation')
    )
      throw new Error('Core normal case must be a distinct executable non-fault positive case.');
    if (normal.targetTaskIds.some((id) => !known(id)))
      throw new Error('Core normal case targets unknown tasks.');
    const executed = closure(normal.targetTaskIds, tasks);
    const taskIds = Object.keys(tasks);
    const dependedOn = new Set(taskIds.flatMap((id) => [...tasks[id]!.dependsOn]));
    if (taskIds.filter((id) => !dependedOn.has(id)).some((id) => !executed.has(id)))
      throw new Error('Core normal case must execute every terminal dependency closure.');
    if (
      core.taskRoles.length !== executed.size ||
      core.taskRoles.some((role) => !executed.has(role.taskId))
    )
      throw new Error(
        'Core witness must explicitly map every executed task; a missing map cannot pass.',
      );
    const rejectCoreFeedback = (message: string, context: Record<string, unknown>): never => {
      const error = new Error(message) as Error & { trialPlanDiagnostic?: unknown };
      error.trialPlanDiagnostic = {
        message,
        missingEvidence: [],
        issues: [],
        rejectionContext: {
          version: 1,
          availability: 'unknown',
          normalCaseId: normal.id,
          ...context,
        },
      };
      throw error;
    };
    const semanticTargets = new Set<string>();
    for (const testCase of plan.cases) {
      for (const [index, expectation] of testCase.expectations.entries()) {
        if (expectation.type !== 'artifact-semantic-review') continue;
        if (testCase.id !== normal.id)
          throw new Error('Semantic review is limited to the positive normal core case.');
        const mapped = core.taskRoles.filter((role) => role.expectationIndices.includes(index));
        const owners = Object.keys(tasks).filter((id) =>
          tasks[id]?.artifactPaths?.includes(expectation.path),
        );
        if (
          mapped.length !== 1 ||
          mapped[0]?.role !== 'content' ||
          mapped[0].taskId !== expectation.taskId ||
          owners.length !== 1 ||
          owners[0] !== expectation.taskId
        )
          rejectCoreFeedback('Semantic review must map to its uniquely owning content task.', {
            expectationIndex: index,
            expectationType: expectation.type,
            path: expectation.path,
            requestedTaskId: expectation.taskId,
            ownerTaskIds: owners.slice(0, 2),
            ownerTaskCount: owners.length,
            ...(owners.length > 2 ? { omittedOwnerTaskCount: owners.length - 2 } : {}),
            mappedRoleTaskIds: mapped.slice(0, 2).map((role) => role.taskId),
            mappedRoleTaskCount: mapped.length,
            ...(mapped.length > 2 ? { omittedMappedRoleTaskCount: mapped.length - 2 } : {}),
            failedConjunct: 'semantic_owner_role_mapping',
            repairHint:
              "Fix this plan mapping: the review target must name its single declared owner and appear once in that owner's content indices. Do not relabel content as execution-only. If YAML lacks a valid ownership declaration, keep core blocked and commit a blocking pipeline-artifact finding; do not edit YAML in this read-only phase.",
          });
        const key = expectation.taskId + '\0' + expectation.path;
        if (semanticTargets.has(key)) throw new Error('Semantic review target is duplicated.');
        semanticTargets.add(key);
      }
    }
    const overlaps = (a: string, b: string) => {
      const x = a.toLowerCase(),
        y = b.toLowerCase();
      return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
    };
    const seeded = (path: string) =>
      normal.fixtures.some((fixture) => fixture.content !== null && overlaps(fixture.path, path));
    const concrete = (value: unknown): boolean =>
      typeof value === 'string'
        ? value.trim().length > 0
        : typeof value === 'number'
          ? Number.isFinite(value)
          : typeof value === 'boolean'
            ? true
            : Array.isArray(value)
              ? value.some(concrete)
              : !!value && typeof value === 'object'
                ? Object.values(value).some(concrete)
                : false;
    const generated = new Set((normal.generatedInputPaths ?? []).map((path) => path.toLowerCase()));
    if (
      core.generatedInputs.length !== generated.size ||
      core.generatedInputs.some((item) => !generated.has(item.path.toLowerCase()))
    )
      rejectCoreFeedback(
        'Core generated-input map must match the normal case declaration exactly.',
        {
          path:
            (normal.generatedInputPaths ?? []).find(
              (path) =>
                !core.generatedInputs.some(
                  (input) => input.path.toLowerCase() === path.toLowerCase(),
                ),
            ) ??
            core.generatedInputs.find((input) => !generated.has(input.path.toLowerCase()))?.path,
          declaredGeneratedInputCount: generated.size,
          mappedGeneratedInputCount: core.generatedInputs.length,
          failedConjunct: 'generated_input_map',
          repairHint:
            'Fix this plan mapping so the core generated-input paths match the normal case exactly, with the real producer and dependent consumer. Do not edit YAML, seed generated answers, invent paths or request artifact repair for a map-only mismatch. Preserve explicit removal and independent content evidence.',
        },
      );
    const rejectCoreCoordinate = (
      message: string,
      expectationIndex: number,
      expectation: ChatPipelineTrialExpectation,
      failedConjunct: string,
      roleTaskId: string | null = null,
    ): never => {
      const error = new Error(message) as Error & { trialPlanDiagnostic?: unknown };
      const bounded = (value: unknown, maximum: number) =>
        typeof value === 'string' && value.length <= maximum ? value : undefined;
      error.trialPlanDiagnostic = {
        message,
        missingEvidence: [],
        issues: [],
        rejectionContext: {
          version: 1,
          availability: 'unknown',
          normalCaseId: normal.id,
          roleTaskId,
          expectationIndex,
          expectationType: expectation.type,
          ...('path' in expectation ? { path: bounded(expectation.path, 240) } : {}),
          ...(expectation.type === 'file-source-text-occurrence'
            ? {
                sourcePath: bounded(expectation.sourcePath, 240),
                sourcePointer: bounded(expectation.sourcePointer, 512),
                producerTaskId: bounded(expectation.producerTaskId, 128),
                consumerTaskId: bounded(expectation.consumerTaskId, 128),
                producerRoleExpectationIndices:
                  core.taskRoles.find((mapped) => mapped.taskId === expectation.producerTaskId)
                    ?.expectationIndices ?? [],
              }
            : {}),
          failedConjunct,
          ...(failedConjunct === 'consumer_role_mapping'
            ? {
                repairHint:
                  'Fix this plan mapping: assign the source-text occurrence index only to its consumer content role, not the producer or an intermediate task. The producer needs its own independent concrete source-content assertion. Keep the valid relation and YAML ownership; do not request artifact repair or weaken content checks for this role-index error.',
              }
            : failedConjunct === 'producer_artifact_ownership' ||
                failedConjunct === 'consumer_artifact_ownership'
              ? {
                  repairHint:
                    'Declare file_exists or json_schema completion at the owning task cwd; command text grants no ownership. If staged YAML omits or miscoordinates it, commit blocked core with a blocking pipeline-artifact finding naming the declaration repair; do not edit YAML in this read-only phase, relabel promised content as execution-only or weaken checks.',
                }
              : {}),
        },
      };
      throw error;
    };
    const independentSourceContent = (path: string, producerTaskId: string) => {
      const producer = core.taskRoles.find((role) => role.taskId === producerTaskId);
      return (
        producer?.role === 'content' &&
        producer.expectationIndices.some((index) => {
          const check = normal.expectations[index];
          return (
            (check?.type === 'json-pointer-equals' &&
              check.path === path &&
              concrete(JSON.parse(check.expectedJson))) ||
            (check?.type === 'artifact-semantic-review' &&
              check.path === path &&
              check.taskId === producerTaskId) ||
            (check?.type === 'file-equals' && check.path === path && check.text.trim().length > 0)
          );
        })
      );
    };
    const ownedSourceRelation = (e: ChatPipelineTrialExpectation) =>
      e.type === 'file-source-text-occurrence' &&
      e.present === true &&
      core.generatedInputs.some(
        (input) =>
          input.path === e.sourcePath &&
          input.producerTaskId === e.producerTaskId &&
          input.consumerTaskId === e.consumerTaskId,
      ) &&
      e.producerTaskId !== e.consumerTaskId &&
      executed.has(e.producerTaskId) &&
      executed.has(e.consumerTaskId) &&
      closure(tasks[e.consumerTaskId]?.dependsOn ?? [], tasks).has(e.producerTaskId) &&
      (tasks[e.producerTaskId]?.artifactPaths ?? []).includes(e.sourcePath) &&
      (tasks[e.consumerTaskId]?.artifactPaths ?? []).includes(e.path) &&
      !seeded(e.path) &&
      !seeded(e.sourcePath) &&
      !overlaps(e.path, e.sourcePath) &&
      independentSourceContent(e.sourcePath, e.producerTaskId);
    const sourceRelationFailure = (e: ChatPipelineTrialExpectation): string => {
      if (e.type !== 'file-source-text-occurrence') return 'relation_type';
      if (e.present !== true) return 'present_true';
      if (
        !core.generatedInputs.some(
          (input) =>
            input.path === e.sourcePath &&
            input.producerTaskId === e.producerTaskId &&
            input.consumerTaskId === e.consumerTaskId,
        )
      )
        return 'generated_input_mapping';
      if (e.producerTaskId === e.consumerTaskId) return 'distinct_tasks';
      if (!executed.has(e.producerTaskId)) return 'executed_producer';
      if (!executed.has(e.consumerTaskId)) return 'executed_consumer';
      if (!closure(tasks[e.consumerTaskId]?.dependsOn ?? [], tasks).has(e.producerTaskId))
        return 'dependency_ancestor';
      if (!(tasks[e.producerTaskId]?.artifactPaths ?? []).includes(e.sourcePath))
        return 'producer_artifact_ownership';
      if (!(tasks[e.consumerTaskId]?.artifactPaths ?? []).includes(e.path))
        return 'consumer_artifact_ownership';
      if (seeded(e.path)) return 'unseeded_output';
      if (seeded(e.sourcePath)) return 'unseeded_source';
      if (overlaps(e.path, e.sourcePath)) return 'distinct_artifact_paths';
      if (!independentSourceContent(e.sourcePath, e.producerTaskId))
        return 'independent_producer_content';
      return 'unknown';
    };
    for (const expectation of normal.expectations) {
      if (expectation.type === 'file-source-text-occurrence' && !ownedSourceRelation(expectation))
        rejectCoreCoordinate(
          'Core source-text relation needs owned generated source, dependency, and independent concrete source content.',
          normal.expectations.indexOf(expectation),
          expectation,
          sourceRelationFailure(expectation),
        );
    }
    for (const input of core.generatedInputs) {
      const failedConjunct =
        input.producerTaskId === input.consumerTaskId
          ? 'producer_consumer_distinct'
          : !executed.has(input.producerTaskId)
            ? 'producer_executed'
            : !executed.has(input.consumerTaskId)
              ? 'consumer_executed'
              : !closure(tasks[input.consumerTaskId]?.dependsOn ?? [], tasks).has(
                    input.producerTaskId,
                  )
                ? 'upstream_dependency'
                : seeded(input.path)
                  ? 'unseeded_source'
                  : !normal.fixtures.some(
                        (fixture) => fixture.path === input.path && fixture.content === null,
                      )
                    ? 'exact_removal_fixture'
                    : !normal.expectations.some(
                          (e) =>
                            (e.type === 'file-equals' &&
                              e.path === input.path &&
                              e.text.length > 0) ||
                            (ownedSourceRelation(e) &&
                              e.type === 'file-source-text-occurrence' &&
                              e.sourcePath === input.path),
                        )
                      ? 'concrete_produced_bytes'
                      : (tasks[input.producerTaskId]?.artifactPaths?.length ?? 0) > 0 &&
                          !tasks[input.producerTaskId]!.artifactPaths!.includes(input.path)
                        ? 'producer_artifact_ownership'
                        : null;
      if (failedConjunct)
        rejectCoreFeedback(
          'Generated core input needs an unseeded exact removal, asserted produced bytes, and an upstream producer/consumer mapping.',
          {
            path: input.path,
            producerTaskId: input.producerTaskId,
            consumerTaskId: input.consumerTaskId,
            failedConjunct,
            repairHint:
              failedConjunct === 'producer_artifact_ownership' ||
              failedConjunct === 'upstream_dependency'
                ? 'Match this plan pair to actual declared ownership and dependencies first. If the staged YAML itself needs a permitted change, keep core blocked and commit a blocking pipeline-artifact finding naming that change. Do not relabel tasks, conceal the gap with fixtures, or edit YAML as the read-only planner.'
                : 'Correct this plan fixture, mapping or content witness. Keep an exact null removal, independently asserted producer bytes and the real upstream dependency. Do not guess values, seed answers, weaken provenance, or edit YAML in this read-only phase. A separate evidenced YAML defect needs blocked core and a blocking pipeline-artifact finding.',
          },
        );
    }
    for (const role of core.taskRoles) {
      if (!status(normal, role.taskId, 'success'))
        throw new Error('Core normal case must assert success for every mapped task.');
      const paths = tasks[role.taskId]?.artifactPaths ?? [];
      if (role.role === 'execution') {
        if (paths.length)
          throw new Error(
            'A declared output artifact needs a content witness, not execution-only exemption.',
          );
        continue;
      }
      const contentPaths = new Set<string>();
      for (const i of role.expectationIndices) {
        const e = normal.expectations[i];
        if (!e || !('path' in e) || seeded(e.path))
          throw new Error('Core content must be a pipeline-produced unseeded output.');
        if (e.type === 'json-pointer-equals') {
          if (!concrete(JSON.parse(e.expectedJson)))
            throw new Error(
              'Core content assertion must be concrete and nonempty, not null or an empty collection.',
            );
        } else if (e.type === 'file-equals' && e.text.trim().length > 0) {
          // Exact produced text still needs the explicit intent-bound semantic rationale.
        } else if (e.type === 'artifact-semantic-review') {
          // Normal-case mapping and unique ownership were checked above. Actual
          // execution and a separate Host model review remain mandatory at runtime.
        } else if (e.type === 'file-source-text-occurrence') {
          if (e.consumerTaskId !== role.taskId || !ownedSourceRelation(e))
            rejectCoreCoordinate(
              'Core source-text relation needs owned generated source, dependency, and independent concrete source content.',
              i,
              e,
              e.consumerTaskId !== role.taskId ? 'consumer_role_mapping' : sourceRelationFailure(e),
              role.taskId,
            );
        } else if (e.type === 'json-pointer-text-occurrence' && e.present === true) {
          const generatedSource =
            core.generatedInputs.some(
              (input) => input.path === e.sourcePath && input.consumerTaskId === role.taskId,
            ) &&
            normal.expectations.some(
              (check) =>
                check.type === 'file-equals' &&
                check.path === e.sourcePath &&
                check.text.length > 0,
            );
          const preservedNonempty =
            preservedSource(normal, e.sourcePath) &&
            normal.fixtures.some(
              (fixture) =>
                fixture.path === e.sourcePath &&
                typeof fixture.content === 'string' &&
                fixture.content.trim().length > 0,
            );
          if (e.path === e.sourcePath || (!preservedNonempty && !generatedSource))
            throw new Error(
              'Core source occurrence needs preserved nonempty input bytes or a mapped genuine upstream generated input.',
            );
        } else
          rejectCoreCoordinate(
            'Core content requires a concrete JSON value, nonempty exact file bytes, or present:true source occurrence; status/existence/schema alone is insufficient.',
            i,
            e,
            'supported_content_shape',
            role.taskId,
          );
        contentPaths.add(e.path);
      }
      const missingArtifact = paths.find((path) => !contentPaths.has(path));
      if (missingArtifact !== undefined)
        rejectCoreFeedback(
          'Every declared core artifact must have a concrete content expectation.',
          {
            roleTaskId: role.taskId,
            path: missingArtifact,
            roleExpectationIndices: [...role.expectationIndices],
            failedConjunct: 'declared_artifact_content',
            repairHint:
              'Add concrete intent-bound content for this declared artifact to its owning content role. Do not invent fixed values, remove declared ownership, relabel content as execution-only, or seed outputs. If YAML needs a permitted change to expose observable content, keep core blocked and commit a blocking pipeline-artifact finding naming that change; the read-only planner must not edit YAML. Keep success, schema and provenance checks.',
          },
        );
    }
    // The normal core has stronger content/mapping checks above. Other cases must
    // still name possible same-run owners before expensive execution can begin.
    for (const testCase of plan.cases) {
      if (testCase.id === normal.id) continue;
      const caseExecuted = closure(testCase.targetTaskIds, tasks);
      for (const [expectationIndex, expectation] of testCase.expectations.entries()) {
        if (expectation.type !== 'file-source-text-occurrence') continue;
        const failedConjunct =
          expectation.producerTaskId === expectation.consumerTaskId
            ? 'distinct_tasks'
            : !known(expectation.producerTaskId)
              ? 'known_producer'
              : !known(expectation.consumerTaskId)
                ? 'known_consumer'
                : !caseExecuted.has(expectation.producerTaskId)
                  ? 'executed_producer'
                  : !caseExecuted.has(expectation.consumerTaskId)
                    ? 'executed_consumer'
                    : !closure(tasks[expectation.consumerTaskId]?.dependsOn ?? [], tasks).has(
                          expectation.producerTaskId,
                        )
                      ? 'dependency_ancestor'
                      : !(tasks[expectation.producerTaskId]?.artifactPaths ?? []).includes(
                            expectation.sourcePath,
                          )
                        ? 'producer_artifact_ownership'
                        : !(tasks[expectation.consumerTaskId]?.artifactPaths ?? []).includes(
                              expectation.path,
                            )
                          ? 'consumer_artifact_ownership'
                          : null;
        if (!failedConjunct) continue;
        const ownerPath = failedConjunct.includes('producer')
          ? expectation.sourcePath
          : expectation.path;
        const owners = Object.keys(tasks).filter((id) =>
          tasks[id]?.artifactPaths?.includes(ownerPath),
        );
        rejectCoreFeedback(
          'Non-core source-text relation has inconsistent declared execution or artifact ownership.',
          {
            caseId: testCase.id,
            expectationIndex,
            expectationType: expectation.type,
            producerTaskId: expectation.producerTaskId,
            consumerTaskId: expectation.consumerTaskId,
            path: expectation.path,
            sourcePath: expectation.sourcePath,
            sourcePointer: expectation.sourcePointer,
            failedConjunct,
            ownerTaskIds: owners.slice(0, 2),
            ownerTaskCount: owners.length,
            ...(owners.length > 2 ? { omittedOwnerTaskCount: owners.length - 2 } : {}),
            repairHint:
              'Correct this plan using declared owners and dependencies; do not relocate business outputs or edit YAML in this read-only step. If a required output genuinely lacks a declaration, use an evidenced blocking pipeline-artifact finding. Runtime source checks remain mandatory.',
          },
        );
      }
    }
  }
  function pointerValue(value: unknown, pointer: string): unknown {
    if (!pointer) return value;
    for (const encoded of pointer.slice(1).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (
        !value ||
        typeof value !== 'object' ||
        (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key)) ||
        !Object.prototype.hasOwnProperty.call(value, key)
      )
        return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }
  function inspectEvidence(
    obligations: readonly ExplicitResilienceObligation[],
    plan: ChatPipelineTrialPlan,
    tasks?: TrialResilienceTaskEvidence,
  ): { missing: ExplicitResilienceObligation[]; issues: TrialEvidenceIssue[] } {
    const issues: TrialEvidenceIssue[] = [];
    const covered = new Set<ExplicitResilienceObligation>();
    for (const c of plan.cases)
      for (const evidence of c.evidence ?? []) {
        const errors: TrialEvidenceIssue[] = [];
        const fail = (
          code: string,
          field: string,
          message: string,
          repairScope: TrialEvidenceIssue['repairScope'] = 'diagnostic-only',
        ) => errors.push({ type: evidence.type, caseId: c.id, code, field, message, repairScope });
        const responsible = plan.evidenceReview?.decisions.find(
          (item) => item.type === evidence.type && item.required,
        )?.taskIds;
        if (tasks && responsible?.some((id) => !Object.prototype.hasOwnProperty.call(tasks, id)))
          fail(
            'review-task-unknown',
            'evidenceReview.decisions.taskIds',
            'The reviewed responsible scope must name known staged tasks.',
          );
        if (evidence.type === 'source-preservation') {
          const e = c.expectations[evidence.preservationExpectationIndex];
          if (
            !e ||
            e.type !== 'file-preserves-lines' ||
            !c.fixtures.some(
              (f) => f.path === e.sourcePath && f.content !== null && f.content === e.text,
            ) ||
            !c.expectations.some(
              (e) =>
                e.type === 'task-status' &&
                e.status === 'success' &&
                (!responsible || responsible.includes(e.taskId)),
            )
          )
            fail(
              'source-relationship-missing',
              'preservationExpectationIndex',
              'Bind ordered source preservation to the exact input fixture and a successful responsible output task.',
            );
        } else {
          const normal = plan.cases.find(
            (n) =>
              n.id === evidence.normalCaseId &&
              n.id !== c.id &&
              !(n.evidence ?? []).some((e) => e.type !== 'source-preservation'),
          );
          if (c.baselineCaseId || normal?.baselineCaseId)
            fail(
              'fault-prerequisite-probe-mixed',
              'baselineCaseId',
              'Keep controlled evidence separate from prerequisite-negative probes.',
            );
          if (!normal)
            fail('normal-case-missing', 'normalCaseId', 'Choose a distinct non-fault normal case.');
          else if (!sameInputs(c, normal))
            fail(
              'normal-inputs-differ',
              'normalCaseId',
              'Normal and controlled cases must share targets, fixtures, and explicit environment values. The Host induces the fault.',
            );
          if (normal && plan.cases.indexOf(normal) >= plan.cases.indexOf(c))
            fail(
              'normal-case-order-invalid',
              'normalCaseId',
              'Run the normal case before its controlled counterpart.',
            );
          if (
            !status(c, evidence.recoveredTaskId, 'success') ||
            (normal && !status(normal, evidence.recoveredTaskId, 'success'))
          )
            fail(
              'recovery-status-missing',
              'recoveredTaskId',
              'Assert that the recovery task succeeds in both cases.',
            );
          const selected = closure(c.targetTaskIds, tasks);
          if (c.runs !== 1 || normal?.runs !== 1)
            fail(
              'fault-run-count-invalid',
              'runs',
              'Controlled evidence uses one fresh run per case; repeats need separate cases.',
            );
          if (responsible && !responsible.includes(evidence.recoveredTaskId))
            fail(
              'recovery-outside-reviewed-scope',
              'recoveredTaskId',
              'Recovery must belong to the intent review responsible task scope.',
            );
          if (!selected.has(evidence.recoveredTaskId))
            fail(
              'recovery-outside-closure',
              'recoveredTaskId',
              'Recovery must be inside the selected task closure.',
            );
          for (const i of evidence.outcomeExpectationIndices) {
            const e = c.expectations[i];
            if (!e || (e.type !== 'file-contains' && e.type !== 'json-pointer-equals'))
              fail(
                'outcome-reference-invalid',
                'outcomeExpectationIndices',
                'Reference a concrete readable or structured output assertion.',
              );
            else if (normal && !contrasted(e, normal))
              fail(
                'normal-outcome-contrast-missing',
                'outcomeExpectationIndices',
                'Add the exact inverse text assertion or a different value at the same JSON pointer in the normal case.',
              );
          }
          const f = evidence.fault;
          if (evidence.type === 'timeout-recovery' || evidence.type === 'failure-recovery') {
            const expected = evidence.type === 'timeout-recovery' ? 'task-timeout' : 'task-exit';
            if (f.type !== expected)
              fail(
                'native-fault-type-mismatch',
                'fault.type',
                'Declare the corresponding Host-owned native subprocess fault.',
              );
            if (f.type !== 'artifact-replace') {
              if (!selected.has(f.taskId) || !tasks?.[f.taskId])
                fail(
                  'fault-task-outside-closure',
                  'fault.taskId',
                  'Select a known task in this closure.',
                );
              if (
                !status(c, f.taskId, f.type === 'task-timeout' ? 'timeout' : 'failed') ||
                (normal && !status(normal, f.taskId, 'success'))
              )
                fail(
                  'native-fault-status-missing',
                  'fault.taskId',
                  'The fault task must have the native failure status; printing fallback text with success is not fault evidence.',
                );
              if (
                f.taskId === evidence.recoveredTaskId ||
                !closure([evidence.recoveredTaskId], tasks).has(f.taskId)
              )
                fail(
                  'recovery-dependency-missing',
                  'recoveredTaskId',
                  'A downstream task must recover from this task boundary.',
                );
              if (
                tasks?.[f.taskId]?.onFailure !== undefined &&
                tasks[f.taskId]!.onFailure !== 'ignore'
              )
                fail(
                  'failure-policy-stops-recovery',
                  'fault.taskId',
                  'The compiled task failure policy prevents downstream recovery; use the production failure-handling path.',
                  'pipeline-artifact',
                );
            }
          } else {
            if (f.type !== 'artifact-replace')
              fail(
                'data-fault-type-mismatch',
                'fault.type',
                'Induce the data edge at a generated artifact boundary, not a success-only environment branch.',
              );
            else {
              if (
                !selected.has(f.producerTaskId) ||
                !selected.has(f.consumerTaskId) ||
                !closure([f.consumerTaskId], tasks).has(f.producerTaskId) ||
                f.producerTaskId === f.consumerTaskId
              )
                fail(
                  'artifact-boundary-invalid',
                  'fault',
                  'Choose a completed producer and its downstream consumer.',
                );
              if (!(tasks?.[f.producerTaskId]?.artifactPaths ?? []).includes(f.path))
                fail(
                  'artifact-producer-unbound',
                  'fault.path',
                  'Bind the generated artifact to the producer completion path.',
                );
              if (c.fixtures.some((item) => item.path === f.path))
                fail(
                  'source-fixture-replacement-forbidden',
                  'fault.path',
                  'Fault injection cannot replace an original source fixture.',
                );
              if (
                !status(c, f.producerTaskId, 'success') ||
                !status(c, f.consumerTaskId, 'success') ||
                (normal &&
                  (!status(normal, f.producerTaskId, 'success') ||
                    !status(normal, f.consumerTaskId, 'success')))
              )
                fail(
                  'artifact-status-missing',
                  'fault',
                  'Assert producer and consumer success in both cases.',
                );
              if (!closure([evidence.recoveredTaskId], tasks).has(f.consumerTaskId))
                fail(
                  'artifact-recovery-dependency-missing',
                  'recoveredTaskId',
                  'Recovery must follow the affected consumer.',
                );
              const observation =
                evidence.observationExpectationIndex === undefined
                  ? undefined
                  : c.expectations[evidence.observationExpectationIndex];
              let replacement: unknown;
              try {
                replacement = JSON.parse(f.content);
              } catch {
                fail(
                  'fault-content-json-invalid',
                  'fault.content',
                  'The declared data fault must contain valid JSON. Correct the plan, not the pipeline.',
                );
              }
              if (
                observation?.type === 'json-pointer-equals' &&
                !sameJson(
                  pointerValue(replacement, observation.pointer),
                  JSON.parse(observation.expectedJson),
                )
              )
                fail(
                  'fault-input-value-mismatch',
                  'fault.content',
                  'The replacement bytes must actually contain the asserted value at the observation pointer.',
                );
              if (observation?.type === 'json-pointer-text-occurrence') {
                const span = pointerValue(replacement, observation.pointer);
                const source = c.fixtures.find(
                  (item) => item.path === observation.sourcePath && item.content !== null,
                )?.content;
                if (
                  typeof span !== 'string' ||
                  span.trim().length === 0 ||
                  typeof source !== 'string' ||
                  source.includes(span)
                )
                  fail(
                    'fault-source-span-invalid',
                    'fault.content',
                    'Provide a nonempty span absent from the exact source fixture at the observation pointer.',
                  );
              }
              if (evidence.type === 'empty-result') {
                if (!observation || observation.type !== 'json-pointer-equals')
                  fail(
                    'empty-observation-missing',
                    'observationExpectationIndex',
                    'Assert the actual empty collection at an explicit JSON pointer.',
                  );
                else {
                  const value = JSON.parse(observation.expectedJson);
                  if (
                    observation.path !== f.path ||
                    !(
                      (Array.isArray(value) && value.length === 0) ||
                      (value && typeof value === 'object' && Object.keys(value).length === 0)
                    )
                  )
                    fail(
                      'empty-observation-invalid',
                      'observationExpectationIndex',
                      'Assert the actual empty collection in the replaced artifact.',
                    );
                  const peer = normal?.expectations.find(
                    (e) =>
                      e.type === 'json-pointer-equals' &&
                      e.path === observation.path &&
                      e.pointer === observation.pointer,
                  );
                  const original =
                    peer?.type === 'json-pointer-equals' ? JSON.parse(peer.expectedJson) : null;
                  const structural = normal?.expectations.some(
                    (e) =>
                      e.type === 'json-pointer-collection' &&
                      e.path === observation.path &&
                      e.pointer === observation.pointer &&
                      e.nonempty &&
                      e.kind === (Array.isArray(value) ? 'array' : 'object'),
                  );
                  if (
                    !structural &&
                    (!original ||
                      typeof original !== 'object' ||
                      Object.keys(original).length === 0 ||
                      Array.isArray(original) !== Array.isArray(value))
                  )
                    fail(
                      'normal-collection-missing',
                      'normalCaseId',
                      'The normal case must assert a nonempty collection of the same type at that pointer.',
                    );
                }
              } else if (
                !observation ||
                observation.type !== 'json-pointer-text-occurrence' ||
                observation.present !== false ||
                observation.path !== f.path ||
                !preservedSource(c, observation.sourcePath) ||
                !normal ||
                !preservedSource(normal, observation.sourcePath) ||
                !c.fixtures.some(
                  (item) => item.path === observation.sourcePath && item.content !== null,
                ) ||
                !normal?.expectations.some(
                  (e) =>
                    e.type === 'json-pointer-text-occurrence' &&
                    e.path === observation.path &&
                    e.pointer === observation.pointer &&
                    e.sourcePath === observation.sourcePath &&
                    e.present,
                )
              )
                fail(
                  'source-relation-missing',
                  'observationExpectationIndex',
                  'Contrast a nonempty produced source span with the exact source fixture in both cases; add file-equals assertions preserving the source fixture bytes.',
                );
            }
          }
        }
        if (!errors.length) covered.add(evidence.type);
        else
          issues.push(
            ...errors.map((item) =>
              errors.some((other) => other.repairScope === 'diagnostic-only')
                ? { ...item, repairScope: 'diagnostic-only' as const }
                : item,
            ),
          );
      }
    const missing = [
      ...new Set([
        ...obligations.filter((kind) => !covered.has(kind)),
        ...issues.map((item) => item.type),
      ]),
    ];
    for (const kind of missing)
      if (!issues.some((item) => item.type === kind))
        issues.push({
          type: kind,
          caseId: null,
          code: 'typed-evidence-missing',
          field: 'cases.evidence',
          message: 'Add explicit structured evidence for this required behavior.',
          repairScope: 'diagnostic-only',
        });
    return { missing, issues };
  }
  function missingExplicitResilienceEvidence(
    obligations: readonly ExplicitResilienceObligation[],
    plan: ChatPipelineTrialPlan,
    tasks?: TrialResilienceTaskEvidence,
  ): ExplicitResilienceObligation[] {
    return inspectEvidence(obligations, plan, tasks).missing;
  }
  return {
    parseReview,
    parseCoreWitness,
    validateCoreWitness,
    parseFault,
    parseCaseEvidence,
    parseValidationContext,
    validateEnvironmentControls,
    inspectEvidence,
    missingExplicitResilienceEvidence,
  };
}
