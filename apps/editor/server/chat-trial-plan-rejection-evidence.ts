import type { TrialEvidenceIssue } from './chat-trial-resilience-rules.js';

/** Host-private native validator evidence; never a public telemetry summary. */
export interface ChatPipelineTrialPlanRejectionEvidence {
  readonly version: 1;
  readonly stageId: string;
  readonly yamlHash: string;
  readonly relativeYamlPath: string;
  readonly attemptId: string;
  readonly submissionConsumed: boolean;
  readonly toolAttemptCount: number;
  readonly validationRejectionCount: number;
  readonly successfulWriteCount: number;
  readonly recordedAt: number;
  readonly hash: string;
  readonly byteLength: number;
  readonly text: string;
}

export interface TrialPlanCompleteDiagnostic {
  readonly message: string;
  readonly missingEvidence: readonly string[];
  readonly issues: readonly TrialEvidenceIssue[];
}

interface RejectionEvidenceDependencies {
  readonly createHash: typeof import('node:crypto').createHash;
  readonly randomUUID: typeof import('node:crypto').randomUUID;
  readonly basename: typeof import('node:path').basename;
  readonly dirname: typeof import('node:path').dirname;
  readonly join: typeof import('node:path').join;
  readonly constants: typeof import('node:fs').constants;
  readonly closeSync: typeof import('node:fs').closeSync;
  readonly fstatSync: typeof import('node:fs').fstatSync;
  readonly lstatSync: typeof import('node:fs').lstatSync;
  readonly mkdirSync: typeof import('node:fs').mkdirSync;
  readonly openSync: typeof import('node:fs').openSync;
  readonly readFileSync: typeof import('node:fs').readFileSync;
  readonly renameSync: typeof import('node:fs').renameSync;
  readonly rmSync: typeof import('node:fs').rmSync;
  readonly writeFileSync: typeof import('node:fs').writeFileSync;
}

interface RejectionBinding {
  readonly stageRoot: string;
  readonly yamlHash: string;
  readonly relativeYamlPath: string;
  readonly attemptId: string;
  readonly toolAttemptCount: number;
  readonly validationRejectionCount: number;
  readonly successfulWriteCount: number;
}

/** Keep all bindings inside this factory: the generated native tool serializes it. */
export function createTrialPlanRejectionEvidenceRules({
  createHash,
  randomUUID,
  basename,
  dirname,
  join,
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
}: RejectionEvidenceDependencies) {
  // Match the existing private repair-evidence store's 64 MiB bound. Never clip.
  const maxBytes = 64 * 1024 * 1024;
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const evidencePath = (binding: RejectionBinding) => {
    const key = sha256(binding.relativeYamlPath + String.fromCharCode(0) + binding.yamlHash);
    return join(binding.stageRoot, '.trial-plan-rejections', `${key}.json`);
  };
  const privateDirectory = (path: string) => {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('Trial plan rejection evidence directory must be private and regular.');
  };
  const privateFile = (stat: import('node:fs').Stats) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.size > 0 &&
    stat.size <= maxBytes &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
  const sameFile = (left: import('node:fs').Stats, right: import('node:fs').Stats) =>
    privateFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink &&
    left.mode === right.mode;
  const completeDiagnostic = (value: unknown): value is TrialPlanCompleteDiagnostic => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const raw = value as Partial<TrialPlanCompleteDiagnostic>;
    return (
      typeof raw.message === 'string' &&
      Array.isArray(raw.missingEvidence) &&
      raw.missingEvidence.every((kind) => typeof kind === 'string') &&
      Array.isArray(raw.issues) &&
      raw.issues.every(
        (issue) =>
          issue &&
          typeof issue === 'object' &&
          !Array.isArray(issue) &&
          typeof issue.type === 'string' &&
          (issue.caseId === null || typeof issue.caseId === 'string') &&
          typeof issue.code === 'string' &&
          typeof issue.field === 'string' &&
          typeof issue.message === 'string' &&
          (issue.repairScope === 'diagnostic-only' || issue.repairScope === 'pipeline-artifact'),
      )
    );
  };

  function write(
    binding: RejectionBinding,
    diagnostic: TrialPlanCompleteDiagnostic,
    submissionConsumed: boolean,
  ): ChatPipelineTrialPlanRejectionEvidence {
    if (!completeDiagnostic(diagnostic)) throw new Error('Complete Trial rejection is invalid.');
    const text = JSON.stringify(diagnostic);
    const evidence: ChatPipelineTrialPlanRejectionEvidence = {
      version: 1,
      stageId: basename(binding.stageRoot),
      yamlHash: binding.yamlHash,
      relativeYamlPath: binding.relativeYamlPath,
      attemptId: binding.attemptId,
      submissionConsumed,
      toolAttemptCount: binding.toolAttemptCount,
      validationRejectionCount: binding.validationRejectionCount,
      successfulWriteCount: binding.successfulWriteCount,
      recordedAt: Date.now(),
      hash: sha256(text),
      byteLength: Buffer.byteLength(text, 'utf8'),
      text,
    };
    const encoded = JSON.stringify(evidence);
    const path = evidencePath(binding);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    privateDirectory(dirname(path));
    try {
      if (!privateFile(lstatSync(path)))
        throw new Error('Trial plan rejection evidence must be a private regular file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Remove the previous record before publication: a failed new write must not
    // leave an older uncounted validation looking like the latest complete error.
    rmSync(path, { force: true });
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes)
      throw new Error('Complete Trial rejection exceeds the private evidence store limit.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, encoded, 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
    return evidence;
  }

  function read(binding: RejectionBinding): ChatPipelineTrialPlanRejectionEvidence | null {
    let descriptor: number | undefined;
    try {
      const path = evidencePath(binding);
      privateDirectory(dirname(path));
      const before = lstatSync(path);
      if (!privateFile(before)) return null;
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!sameFile(before, opened)) return null;
      const encoded = readFileSync(descriptor, 'utf8');
      // The descriptor may still reference an unlinked original, or the same
      // inode may change during the read. Neither can authorize a later attempt.
      const afterRead = fstatSync(descriptor);
      const currentPath = lstatSync(path);
      if (
        Buffer.byteLength(encoded, 'utf8') !== opened.size ||
        !sameFile(opened, afterRead) ||
        !sameFile(afterRead, currentPath)
      )
        return null;
      const raw = JSON.parse(encoded) as ChatPipelineTrialPlanRejectionEvidence;
      if (
        raw.version !== 1 ||
        raw.stageId !== basename(binding.stageRoot) ||
        raw.yamlHash !== binding.yamlHash ||
        raw.relativeYamlPath !== binding.relativeYamlPath ||
        raw.attemptId !== binding.attemptId ||
        typeof raw.submissionConsumed !== 'boolean' ||
        raw.toolAttemptCount !== binding.toolAttemptCount ||
        raw.validationRejectionCount !== binding.validationRejectionCount ||
        raw.successfulWriteCount !== binding.successfulWriteCount ||
        !Number.isSafeInteger(raw.recordedAt) ||
        raw.recordedAt <= 0 ||
        typeof raw.text !== 'string' ||
        raw.byteLength !== Buffer.byteLength(raw.text, 'utf8') ||
        raw.hash !== sha256(raw.text) ||
        !completeDiagnostic(JSON.parse(raw.text))
      )
        return null;
      return raw;
    } catch {
      // A missing, stale or unreadable complete record is not a complete error.
      return null;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return { read, write };
}
