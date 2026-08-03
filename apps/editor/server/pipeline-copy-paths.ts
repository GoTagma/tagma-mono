import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { isPathWithin } from './path-utils.js';
import { withDefaultTrackColors } from './state.js';

interface PipelineCopyPathRelocation {
  sourcePipelineDir: string;
  sourceContentDir: string;
  destinationPipelineDir: string;
  sourceCwd: string;
  destinationCwd: string;
}

export interface RewriteCopiedPipelineYamlOptions {
  workDir: string;
  sourceContentPath: string;
  sourceIdentityPath: string;
  destinationYamlPath: string;
  pipelineName: string;
}

const RELOCATABLE_TRIGGER_TYPES = new Set(['file', 'directory']);
const RELOCATABLE_COMPLETION_TYPES = new Set(['file_exists']);
const RELOCATABLE_MIDDLEWARE_TYPES = new Set(['static_context']);

function portableRelative(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}

function relocatePipelineLocalPath(
  value: unknown,
  options: PipelineCopyPathRelocation,
): unknown {
  if (typeof value !== 'string' || value.trim().length === 0) return value;
  const raw = value.trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(options.sourceCwd, raw);
  const sourceRoot = isPathWithin(absolute, options.sourceContentDir)
    ? options.sourceContentDir
    : isPathWithin(absolute, options.sourcePipelineDir)
      ? options.sourcePipelineDir
      : null;
  if (!sourceRoot) return value;
  const relocated = resolve(options.destinationPipelineDir, relative(sourceRoot, absolute));
  return isAbsolute(raw)
    ? relocated
    : portableRelative(options.destinationCwd, relocated) || '.';
}

function rewriteTypedPluginPath<T extends Record<string, unknown>>(
  config: T | undefined,
  expectedTypes: ReadonlySet<string>,
  key: 'path' | 'file',
  options: PipelineCopyPathRelocation,
): T | undefined {
  if (!config || !expectedTypes.has(config.type as string)) return config;
  const relocated = relocatePipelineLocalPath(config[key], options);
  return relocated === config[key] ? config : ({ ...config, [key]: relocated } as T);
}

export function rewriteCopiedPipelineYaml(
  content: string,
  options: RewriteCopiedPipelineYamlOptions,
): string {
  const config = withDefaultTrackColors(parseYaml(content));
  const sourcePipelineDir = dirname(options.sourceIdentityPath);
  const sourceContentDir = dirname(options.sourceContentPath);
  const destinationPipelineDir = dirname(options.destinationYamlPath);
  const pathOptions = (
    sourceCwd: string,
    destinationCwd: string,
  ): PipelineCopyPathRelocation => ({
    sourcePipelineDir,
    sourceContentDir,
    destinationPipelineDir,
    sourceCwd,
    destinationCwd,
  });
  const resolveCwd = (cwd: string | undefined): string =>
    cwd && isAbsolute(cwd) ? resolve(cwd) : resolve(options.workDir, cwd ?? '.');
  const rewriteCwd = (cwd: string | undefined): string | undefined => {
    if (!cwd) return cwd;
    const rewritten = relocatePipelineLocalPath(
      cwd,
      pathOptions(options.workDir, options.workDir),
    );
    return typeof rewritten === 'string' ? rewritten : cwd;
  };

  return serializePipeline({
    ...config,
    name: options.pipelineName,
    tracks: config.tracks.map((track) => {
      const nextTrackCwd = rewriteCwd(track.cwd);
      const sourceTrackCwd = resolveCwd(track.cwd);
      const destinationTrackCwd = resolveCwd(nextTrackCwd);
      const trackPathOptions = pathOptions(sourceTrackCwd, destinationTrackCwd);
      return {
        ...track,
        cwd: nextTrackCwd,
        middlewares: track.middlewares?.map((middleware) =>
          rewriteTypedPluginPath(
            middleware,
            RELOCATABLE_MIDDLEWARE_TYPES,
            'file',
            trackPathOptions,
          )!,
        ),
        tasks: track.tasks.map((task) => {
          const nextTaskCwd = rewriteCwd(task.cwd);
          const sourceTaskCwd = task.cwd ? resolveCwd(task.cwd) : sourceTrackCwd;
          const destinationTaskCwd = nextTaskCwd
            ? resolveCwd(nextTaskCwd)
            : destinationTrackCwd;
          const taskPathOptions = pathOptions(sourceTaskCwd, destinationTaskCwd);
          return {
            ...task,
            cwd: nextTaskCwd,
            trigger: rewriteTypedPluginPath(
              task.trigger,
              RELOCATABLE_TRIGGER_TYPES,
              'path',
              taskPathOptions,
            ),
            completion: rewriteTypedPluginPath(
              task.completion,
              RELOCATABLE_COMPLETION_TYPES,
              'path',
              taskPathOptions,
            ),
            middlewares: task.middlewares?.map((middleware) =>
              rewriteTypedPluginPath(
                middleware,
                RELOCATABLE_MIDDLEWARE_TYPES,
                'file',
                taskPathOptions,
              )!,
            ),
          };
        }),
      };
    }),
  });
}
