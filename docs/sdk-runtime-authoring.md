# SDK Runtime Authoring

Date: 2026-04-26

`TagmaRuntime` is the boundary between SDK orchestration and host/runtime-specific behavior. The default `bunRuntime()` implements it with Bun process APIs, chokidar file watching, and filesystem-backed logs.

## Interface Responsibilities

A runtime provides:

- `runSpawn(spec, driver, options?)`
- `runCommand(command, cwd, options?)`
- `ensureDir(path)`
- `fileExists(path)`
- `watch(path, options?)`
- `logStore`
- `now()`
- `sleep(ms, signal?)`

The engine and built-in file trigger should use only this interface for process execution, file watching, log placement, and time.

## Log Store

`runtime.logStore` owns run log and artifact paths:

- `openRunLog({ workDir, runId, header })` returns a sink with `path`, `dir`, `append()`, and `close()`.
- `taskOutputPath({ workDir, runId, taskId, stream })` returns stdout/stderr artifact paths.
- `logsDir(workDir)` returns the root log directory.
- `prune({ workDir, keep, excludeRunId })` is optional cleanup.

Custom runtimes can write logs to memory, remote storage, or a different filesystem layout while preserving `TaskResult.stdoutPath` / `stderrPath`.

## Watch Contract

`watch(path, options)` returns an async iterable of:

- `{ type: 'ready', path }`
- `{ type: 'add', path }`
- `{ type: 'change', path }`
- `{ type: 'unlink', path }`

When `options.cwd` is set, event paths may be relative to that cwd. Consumers should resolve paths before comparing.

## Minimal Test Runtime

```ts
import type { TagmaRuntime } from '@tagma/sdk';

export function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand(_command, _cwd, options) {
      return {
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        stdoutPath: options?.stdoutPath ?? null,
        stderrPath: options?.stderrPath ?? null,
        durationMs: 1,
        sessionId: null,
        normalizedOutput: null,
        failureKind: null,
      };
    },
    async runSpawn() {
      throw new Error('not implemented');
    },
    async ensureDir() {},
    async fileExists() {
      return false;
    },
    async *watch() {},
    logStore: {
      openRunLog() {
        return { path: 'mem://pipeline.log', dir: 'mem://run', append() {}, close() {} };
      },
      taskOutputPath({ taskId, stream }) {
        return `mem://${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
    },
    now: () => new Date(),
    sleep: () => Promise.resolve(),
  };
}
```
