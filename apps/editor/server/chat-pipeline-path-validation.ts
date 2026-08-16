import { posix, win32 } from 'node:path';
import type { RawPipelineConfig } from '@tagma/types';

export interface ChatPipelinePathDiagnostic {
  path: string;
  message: string;
  severity: 'error';
}

export interface ChatPipelinePathValidationOptions {
  workspaceRoot: string;
  /** Portable path relative to the workspace `.tagma/` directory. */
  relativeYamlPath: string;
  platform?: NodeJS.Platform;
}

type PathConfig = Readonly<Record<string, unknown>>;

function portablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function standardPipelineWorkspaceDir(relativeYamlPath: string): string | null {
  const portable = portablePath(relativeYamlPath);
  const pipelineDir = posix.dirname(portable);
  const filename = posix.basename(portable);
  const stem = filename.replace(/\.ya?ml$/i, '');
  if (
    pipelineDir === '.' ||
    pipelineDir.includes('/') ||
    !/\.ya?ml$/i.test(filename) ||
    posix.basename(pipelineDir) !== stem
  ) {
    return null;
  }
  return posix.join('.tagma', pipelineDir);
}

function isExplicitTaskLocalPath(value: string, isWindows: boolean): boolean {
  return value.startsWith('./') || (isWindows && value.startsWith('.\\'));
}

function pathIsWithin(
  pathApi: typeof posix | typeof win32,
  root: string,
  candidate: string,
): boolean {
  const relative = pathApi.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
  );
}

function normalizedLogicalPath(value: string, isWindows: boolean): string {
  const normalized = posix.normalize(isWindows ? portablePath(value) : value);
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

function logicalPathStartsWith(
  candidate: string,
  prefix: string,
  caseInsensitive: boolean,
): boolean {
  const comparedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const comparedPrefix = caseInsensitive ? prefix.toLowerCase() : prefix;
  return comparedCandidate === comparedPrefix || comparedCandidate.startsWith(`${comparedPrefix}/`);
}

export function validateChatPipelinePathCoordinates(
  config: RawPipelineConfig,
  options: ChatPipelinePathValidationOptions,
): ChatPipelinePathDiagnostic[] {
  const pipelineWorkspaceDir = standardPipelineWorkspaceDir(options.relativeYamlPath);
  if (!pipelineWorkspaceDir) return [];

  const isWindows = (options.platform ?? process.platform) === 'win32';
  const pathApi = isWindows ? win32 : posix;
  const caseInsensitive = isWindows;
  const toNative = (value: string): string => (isWindows ? value.replace(/\//g, '\\') : value);
  const workspaceRoot = pathApi.resolve(toNative(options.workspaceRoot));
  const pipelineDir = pathApi.resolve(workspaceRoot, toNative(pipelineWorkspaceDir));
  const diagnostics: ChatPipelinePathDiagnostic[] = [];
  const seen = new Set<string>();

  const validatePathConfig = (
    configPath: string,
    plugin: PathConfig | undefined,
    key: 'path' | 'file',
    expectedTypes: ReadonlySet<string>,
    effectiveCwdValue: unknown,
  ): void => {
    if (!plugin || !expectedTypes.has(plugin.type as string)) return;
    const rawValue = plugin[key];
    if (typeof rawValue !== 'string' || rawValue.length === 0) return;
    if (typeof effectiveCwdValue !== 'string' || effectiveCwdValue.length === 0) return;

    const value = rawValue;
    if (isExplicitTaskLocalPath(value, isWindows)) return;
    const nativeValue = toNative(value);
    if (pathApi.isAbsolute(nativeValue)) return;

    const effectiveCwd = pathApi.resolve(workspaceRoot, toNative(effectiveCwdValue));
    if (!pathIsWithin(pathApi, pipelineDir, effectiveCwd)) return;

    const logicalValue = normalizedLogicalPath(value, isWindows);
    if (!logicalPathStartsWith(logicalValue, pipelineWorkspaceDir, caseInsensitive)) return;

    const cwdDisplay = portablePath(pathApi.relative(workspaceRoot, effectiveCwd)) || '.';
    const resolvedDisplay =
      portablePath(pathApi.relative(workspaceRoot, pathApi.resolve(effectiveCwd, nativeValue))) ||
      '.';
    const suggested =
      logicalPathStartsWith(cwdDisplay, pipelineWorkspaceDir, caseInsensitive) &&
      cwdDisplay.length === pipelineWorkspaceDir.length
        ? logicalValue.slice(pipelineWorkspaceDir.length).replace(/^\//, '')
        : '';
    const diagnosticPath = `${configPath}.${key}`;
    const message =
      `Path "${value}" is resolved relative to effective task cwd "${cwdDisplay}", ` +
      `so repeating the current pipeline prefix "${pipelineWorkspaceDir}" resolves to ` +
      `"${resolvedDisplay}". ` +
      (suggested
        ? `Use "${suggested}" for the pipeline-local target. `
        : 'Choose a path relative to the effective task cwd, or realign the task cwd. ') +
      `Use an explicit "./${pipelineWorkspaceDir}/..." only when that nested directory is intentional.`;
    const identity = `${diagnosticPath}\u0000${cwdDisplay}\u0000${message}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    diagnostics.push({ path: diagnosticPath, message, severity: 'error' });
  };

  const triggerTypes = new Set(['file', 'directory']);
  const completionTypes = new Set(['file_exists']);
  const middlewareTypes = new Set(['static_context']);

  config.tracks.forEach((track, trackIndex) => {
    track.tasks.forEach((task, taskIndex) => {
      const effectiveCwd = task.cwd ?? track.cwd;
      if (typeof task.prompt === 'string') {
        const middlewares = task.middlewares !== undefined ? task.middlewares : track.middlewares;
        const middlewareBasePath =
          task.middlewares !== undefined
            ? `tracks[${trackIndex}].tasks[${taskIndex}].middlewares`
            : `tracks[${trackIndex}].middlewares`;
        middlewares?.forEach((middleware, middlewareIndex) => {
          validatePathConfig(
            `${middlewareBasePath}[${middlewareIndex}]`,
            middleware as PathConfig,
            'file',
            middlewareTypes,
            effectiveCwd,
          );
        });
      }
      validatePathConfig(
        `tracks[${trackIndex}].tasks[${taskIndex}].trigger`,
        task.trigger as PathConfig | undefined,
        'path',
        triggerTypes,
        effectiveCwd,
      );
      validatePathConfig(
        `tracks[${trackIndex}].tasks[${taskIndex}].completion`,
        task.completion as PathConfig | undefined,
        'path',
        completionTypes,
        effectiveCwd,
      );
    });
  });

  return diagnostics;
}
