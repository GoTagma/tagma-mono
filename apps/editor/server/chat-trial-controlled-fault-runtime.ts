import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { RunEventPayload, RunOptions, TaskResult, TagmaRuntime } from '@tagma/types';
import type { TrialControlledFault } from './chat-trial-resilience-rules.js';
import { sameFilesystemPathCoordinate } from '../shared/filesystem-paths.js';

export interface TrialFaultObservation {
  readonly applied: boolean;
  readonly observed: boolean;
  readonly failureKind: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly diagnostic: string | null;
}

/** Run-scoped Host instrumentation. It never inspects prose or authored selector names. */
export function createControlledTrialFaultRuntime(
  base: TagmaRuntime,
  fault: TrialControlledFault,
  scope: {
    readonly workDir: string;
    readonly relativeYamlPath: string;
    readonly artifactPath: string | null;
  },
): {
  runtime: TagmaRuntime;
  observeEvent(event: RunEventPayload): void;
  observed(): TrialFaultObservation;
} {
  const owners = new Map<string, string>();
  const statuses = new Map<string, string>();
  let applied = false;
  let nativeResult: TaskResult | null = null;
  let beforeHash: string | null = null;
  let afterHash: string | null = null;
  let diagnostic: string | null = null;
  if (fault.type === 'artifact-replace') {
    if (!scope.artifactPath)
      throw new Error('Controlled artifact lacks an authenticated case path.');
    const rel = relative(scope.workDir, scope.artifactPath);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
      throw new Error('Controlled artifact is outside the isolated case.');
    try {
      lstatSync(scope.artifactPath);
      diagnostic = 'The controlled artifact was pre-seeded instead of produced in this case.';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  function owner(options?: RunOptions): string | undefined {
    return (
      (options?.stdoutPath ? owners.get(options.stdoutPath) : undefined) ??
      (options?.stderrPath ? owners.get(options.stderrPath) : undefined)
    );
  }
  async function inject(id: string, cwd: string, options: RunOptions): Promise<TaskResult> {
    if (fault.type === 'artifact-replace' || id !== fault.taskId || applied)
      throw new Error('Invalid native fault scope.');
    applied = true;
    // Native shell primitives work in packaged sidecars too; process.execPath
    // can be the compiled editor server and is not an executable Bun CLI.
    const command =
      fault.type === 'task-exit'
        ? `exit ${fault.exitCode}`
        : process.platform === 'win32'
          ? 'Start-Sleep -Seconds 60'
          : 'exec /bin/sleep 60';
    const timeoutMs =
      fault.type === 'task-timeout'
        ? Math.min(
            options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : fault.timeoutMs,
            fault.timeoutMs,
          )
        : options.timeoutMs;
    nativeResult = await base.runCommand(command, cwd, { ...options, timeoutMs });
    return nativeResult;
  }
  const runtime: TagmaRuntime = {
    ...base,
    logStore: {
      openRunLog: (options) => base.logStore.openRunLog(options),
      logsDir: (workDir) => base.logStore.logsDir(workDir),
      ...(base.logStore.prune ? { prune: (options) => base.logStore.prune!(options) } : {}),
      taskOutputPath(options) {
        const path = base.logStore.taskOutputPath(options);
        owners.set(path, options.taskId);
        return path;
      },
    },
    runCommand(command, cwd, options = {}) {
      const id = owner(options);
      beforeConsumerExecution(id);
      return fault.type !== 'artifact-replace' && id === fault.taskId
        ? inject(id, cwd, options)
        : base.runCommand(command, cwd, options);
    },
    runSpawn(spec, driver, options = {}) {
      const id = owner(options);
      return fault.type !== 'artifact-replace' && id === fault.taskId
        ? inject(id, spec.cwd ?? scope.workDir, options)
        : base.runSpawn(spec, driver, options);
    },
  };
  function observeEvent(event: RunEventPayload): void {
    if (event.type === 'task_update') statuses.set(event.taskId, event.status);
  }
  function beforeConsumerExecution(id: string | undefined): void {
    if (fault.type !== 'artifact-replace' || id !== fault.consumerTaskId || applied || diagnostic)
      return;
    try {
      if (statuses.get(fault.producerTaskId) !== 'success')
        throw new Error('The artifact producer did not complete successfully.');
      const path = scope.artifactPath!;
      let ancestor = dirname(path);
      const root = resolve(scope.workDir);
      while (true) {
        const stat = lstatSync(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Controlled artifact parent is not an isolated regular directory.');
        if (ancestor === root) break;
        const parent = dirname(ancestor);
        if (parent === ancestor)
          throw new Error('Controlled artifact parent escaped its case root.');
        ancestor = parent;
      }
      if (
        !sameFilesystemPathCoordinate(
          realpathSync(path),
          resolve(realpathSync(scope.workDir), relative(scope.workDir, path)),
        )
      )
        throw new Error('Controlled artifact resolves through an alias.');
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 2 * 1024 * 1024
      )
        throw new Error('The generated artifact is not a bounded private regular file.');
      const after = Buffer.from(fault.content, 'utf8');
      const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.nlink !== 1 ||
          !opened.isFile()
        )
          throw new Error('Controlled artifact identity changed.');
        const before = readFileSync(fd);
        if (before.equals(after)) throw new Error('The controlled artifact bytes did not change.');
        beforeHash = createHash('sha256').update(before).digest('hex');
        ftruncateSync(fd, 0);
        // readFileSync advanced the descriptor offset; explicit position prevents sparse writes.
        let offset = 0;
        while (offset < after.length)
          offset += writeSync(fd, after, offset, after.length - offset, offset);
        afterHash = createHash('sha256').update(readFileSync(path)).digest('hex');
        if (afterHash !== createHash('sha256').update(after).digest('hex'))
          throw new Error('The controlled artifact write did not retain its bytes.');
      } finally {
        closeSync(fd);
      }
      applied = true;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : 'Controlled artifact failed.';
    }
  }
  function observed(): TrialFaultObservation {
    const observed =
      fault.type === 'artifact-replace'
        ? applied && beforeHash !== null && afterHash !== null && beforeHash !== afterHash
        : applied &&
          nativeResult !== null &&
          !nativeResult.outputDiagnostics?.length &&
          (fault.type === 'task-timeout'
            ? nativeResult.failureKind === 'timeout' && statuses.get(fault.taskId) === 'timeout'
            : nativeResult.failureKind === 'exit_nonzero' &&
              nativeResult.exitCode === fault.exitCode &&
              statuses.get(fault.taskId) === 'failed');
    return {
      applied,
      observed,
      failureKind: nativeResult?.failureKind ?? null,
      beforeHash,
      afterHash,
      diagnostic,
    };
  }
  return { runtime, observeEvent, observed };
}
