export interface ChatPipelineTrialPrerequisiteControls {
  /** A negative case changes one prerequisite of this positive case. */
  baselineCaseId?: string;
  /** null removes a declared test input; strings supply non-production defaults. */
  environment?: Array<{ name: string; value: string | null }>;
  deniedManualTaskIds?: string[];
}

/**
 * Self-contained on purpose: the same validator is embedded in the managed
 * OpenCode tool, which cannot import the sidecar's module graph.
 */
export function normalizeTrialPrerequisiteCases<T extends object>(
  cases: T[],
  complete = true,
): Array<T & ChatPipelineTrialPrerequisiteControls> {
  const normalized = cases.map((testCase) => {
    const raw = testCase as Record<string, unknown>;
    const label = `Case ${String(raw.id)}`;
    const environment: Array<{ name: string; value: string | null }> = [];
    const names = new Set<string>();
    if (raw.environment !== undefined) {
      if (!Array.isArray(raw.environment) || raw.environment.length > 32) {
        throw new Error(`${label}.environment must contain at most 32 test inputs.`);
      }
      for (const item of raw.environment) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`${label}.environment entries must be objects.`);
        }
        const { name, value } = item as Record<string, unknown>;
        if (
          typeof name !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
          /^(?:PATH|PATHEXT|HOME|USER|USERNAME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|SHELL|PIPELINE_SHELL|__proto__|constructor|prototype)$/i.test(
            name,
          ) ||
          /^(?:OPENCODE_|NODE_|BUN_|LD_|DYLD_|PYTHON|TAGMA_TRIAL_|TAGMA_WORKSPACE_RUNTIME)/i.test(
            name,
          ) ||
          names.has(name.toUpperCase())
        ) {
          throw new Error(`${label}.environment contains a reserved, invalid, or duplicate name.`);
        }
        if (
          value !== null &&
          (typeof value !== 'string' ||
            value.includes('\0') ||
            new TextEncoder().encode(value).length > 4096)
        ) {
          throw new Error(`${label}.environment values must be bounded strings or null.`);
        }
        names.add(name.toUpperCase());
        environment.push({ name, value: value as string | null });
      }
    }
    const denied = raw.deniedManualTaskIds ?? [];
    if (
      !Array.isArray(denied) ||
      denied.length > 1 ||
      denied.some(
        (id) =>
          typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(id),
      )
    ) {
      throw new Error(`${label} may deny only one prerequisite manual task.`);
    }
    const faultCount = denied.length + environment.filter((item) => item.value === null).length;
    const baselineCaseId = raw.baselineCaseId;
    if (
      baselineCaseId !== undefined &&
      (typeof baselineCaseId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(baselineCaseId))
    ) {
      throw new Error(`${label}.baselineCaseId is invalid.`);
    }
    if (faultCount > 1 || (baselineCaseId !== undefined && faultCount !== 1)) {
      throw new Error(`${label} must change exactly one prerequisite from its positive baseline.`);
    }
    if (faultCount === 1 && baselineCaseId === undefined) {
      throw new Error(`${label} requires a positive baselineCaseId.`);
    }
    return {
      ...testCase,
      ...(baselineCaseId !== undefined ? { baselineCaseId: baselineCaseId as string } : {}),
      ...(raw.environment !== undefined ? { environment } : {}),
      ...(raw.deniedManualTaskIds !== undefined ? { deniedManualTaskIds: denied as string[] } : {}),
    } as T & ChatPipelineTrialPrerequisiteControls;
  });
  if (!complete) return normalized;
  const byId = new Map(
    normalized.map((testCase) => [(testCase as Record<string, unknown>).id, testCase]),
  );
  const sameList = (left: unknown, right: unknown) =>
    JSON.stringify(Array.isArray(left) ? left.map((item) => JSON.stringify(item)).sort() : []) ===
    JSON.stringify(Array.isArray(right) ? right.map((item) => JSON.stringify(item)).sort() : []);
  for (const testCase of normalized) {
    if (!testCase.baselineCaseId) continue;
    const raw = testCase as Record<string, unknown>;
    const baseline = byId.get(testCase.baselineCaseId);
    if (!baseline || baseline.baselineCaseId)
      throw new Error(`Case ${String(raw.id)} needs an existing positive baseline.`);
    const base = baseline as Record<string, unknown>;
    if (
      !sameList(raw.targetTaskIds, base.targetTaskIds) ||
      !sameList(raw.fixtures, base.fixtures) ||
      !sameList(raw.generatedInputPaths, base.generatedInputPaths)
    ) {
      throw new Error(
        `Case ${String(raw.id)} must retain its baseline targets and fixtures; change only one prerequisite.`,
      );
    }
    const targets = raw.targetTaskIds as string[];
    const expectations = raw.expectations as Array<Record<string, unknown>>;
    const baseExpectations = base.expectations as Array<Record<string, unknown>>;
    for (const taskId of targets) {
      if (
        !baseExpectations.some(
          (item) =>
            item.type === 'task-status' && item.taskId === taskId && item.status === 'success',
        )
      ) {
        throw new Error(
          `Positive baseline ${testCase.baselineCaseId} must expect success for ${taskId}.`,
        );
      }
      if (!expectations.some((item) => item.type === 'task-status' && item.taskId === taskId)) {
        throw new Error(
          `Negative case ${String(raw.id)} must declare the expected outcome for ${taskId}.`,
        );
      }
    }
    for (const taskId of testCase.deniedManualTaskIds ?? []) {
      if (
        !expectations.some(
          (item) =>
            item.type === 'task-status' && item.taskId === taskId && item.status === 'blocked',
        )
      ) {
        throw new Error(
          `Negative case ${String(raw.id)} must expect blocked for denied manual task ${taskId}.`,
        );
      }
    }
    for (const item of testCase.environment ?? []) {
      if (
        item.value !== null &&
        !baseline.environment?.some(
          (baseItem) => baseItem.name === item.name && baseItem.value === item.value,
        )
      ) {
        throw new Error(
          `Negative case ${String(raw.id)} must change only one prerequisite; inherit other environment defaults.`,
        );
      }
    }
  }
  return normalized.sort(
    (left, right) => Number(Boolean(left.baselineCaseId)) - Number(Boolean(right.baselineCaseId)),
  );
}
