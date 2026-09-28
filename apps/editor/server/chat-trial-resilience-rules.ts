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
export interface TrialEvidenceReview {
  readonly version: 1;
  readonly intentDigest: string;
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
  function keys(raw: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(raw).some((key) => !allowed.includes(key)))
      throw new Error('Unknown structured evidence field.');
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
    keys(raw, ['version', 'intentDigest', 'decisions']);
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
      keys(item, ['type', 'required', 'taskIds', 'rationale']);
      if (!kinds.includes(item.type as never) || typeof item.required !== 'boolean')
        throw new Error('Evidence review disposition is invalid.');
      if (
        !Array.isArray(item.taskIds) ||
        item.taskIds.length > 32 ||
        (item.required && item.taskIds.length === 0) ||
        (!item.required && item.taskIds.length > 0) ||
        item.taskIds.some(
          (id) =>
            typeof id !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(id),
        ) ||
        new Set(item.taskIds).size !== item.taskIds.length
      )
        throw new Error('Required evidence must name its bounded responsible task scope.');
      return {
        type: item.type as ExplicitResilienceObligation,
        required: item.required,
        taskIds: item.taskIds as string[],
        rationale: text(item.rationale, 'evidence review rationale', 1000),
      };
    });
    if (new Set(decisions.map((item) => item.type)).size !== kinds.length)
      throw new Error('Evidence review kinds must not be duplicated.');
    return { version: 1, intentDigest: raw.intentDigest, decisions };
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
                  if (
                    !original ||
                    typeof original !== 'object' ||
                    Object.keys(original).length === 0 ||
                    Array.isArray(original) !== Array.isArray(value)
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
    parseFault,
    parseCaseEvidence,
    parseValidationContext,
    inspectEvidence,
    missingExplicitResilienceEvidence,
  };
}
