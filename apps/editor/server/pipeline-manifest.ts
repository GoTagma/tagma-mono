import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './path-utils.js';

export type PipelineManifestSectionType = 'pipeline' | 'track' | 'command' | 'prompt' | 'unknown';

export interface PipelineManifestSection {
  readonly id: string;
  readonly type: PipelineManifestSectionType;
  readonly summary: string;
  readonly yamlPath: string;
  readonly track?: string;
  readonly task?: string;
  readonly tasks?: readonly string[];
  readonly depends_on?: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
}

export interface PipelineManifest {
  readonly schemaVersion: 1;
  readonly kind: 'tagma-pipeline-manifest';
  readonly generatedFor: string;
  readonly generatedAt: string;
  readonly pipeline: {
    readonly name: string;
    readonly yaml: string;
  };
  readonly sections: readonly PipelineManifestSection[];
  readonly editPolicy: {
    readonly defaultScope: 'single-section';
    readonly preserveUnselectedSections: true;
    readonly manifestOwner: 'editor';
    readonly updateWhen: readonly string[];
    readonly bypassWhen: readonly string[];
  };
}

interface BuildPipelineManifestOptions {
  readonly yamlBasename: string;
  readonly generatedAt?: string;
}

interface ParsedPipeline {
  readonly name?: unknown;
  readonly tracks?: readonly ParsedTrack[];
}

interface ParsedTrack {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly tasks?: readonly ParsedTask[];
}

interface ParsedTask {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly command?: unknown;
  readonly prompt?: unknown;
  readonly depends_on?: unknown;
  readonly inputs?: unknown;
  readonly outputs?: unknown;
}

export function pipelineManifestPath(yamlPath: string): string {
  const stem = basename(yamlPath).replace(/\.ya?ml$/i, '');
  return join(dirname(yamlPath), `${stem}.manifest.json`);
}

export function buildPipelineManifestFromYaml(
  content: string,
  options: BuildPipelineManifestOptions,
): PipelineManifest {
  const parsed = yaml.load(content);
  const root = asRecord(parsed);
  const pipeline = asRecord(root?.pipeline) as ParsedPipeline | null;
  if (!pipeline) {
    throw new Error('YAML must contain a top-level pipeline object');
  }

  const pipelineName = stringOrDefault(pipeline.name, 'Untitled Pipeline');
  const sections: PipelineManifestSection[] = [
    {
      id: 'pipeline',
      type: 'pipeline',
      summary: pipelineName,
      yamlPath: 'pipeline',
    },
  ];

  const tracks = Array.isArray(pipeline.tracks) ? pipeline.tracks : [];
  tracks.forEach((rawTrack, trackIndex) => {
    const track = asRecord(rawTrack) as ParsedTrack | null;
    if (!track) return;
    const trackId = stringOrDefault(track.id, `track_${trackIndex + 1}`);
    const trackName = stringOrDefault(track.name, trackId);
    const tasks = Array.isArray(track.tasks) ? track.tasks : [];
    const taskRefs = tasks
      .map((rawTask, taskIndex) => {
        const task = asRecord(rawTask) as ParsedTask | null;
        if (!task) return null;
        const taskId = stringOrDefault(task.id, `task_${taskIndex + 1}`);
        return `${trackId}.${taskId}`;
      })
      .filter((taskRef): taskRef is string => taskRef !== null);

    sections.push({
      id: `track:${trackId}`,
      type: 'track',
      summary: trackName,
      yamlPath: `pipeline.tracks[${trackIndex}]`,
      track: trackId,
      tasks: taskRefs,
    });

    tasks.forEach((rawTask, taskIndex) => {
      const task = asRecord(rawTask) as ParsedTask | null;
      if (!task) return;
      const taskId = stringOrDefault(task.id, `task_${taskIndex + 1}`);
      const section: PipelineManifestSection = {
        id: `task:${trackId}.${taskId}`,
        type: taskType(task),
        summary: taskSummary(task, taskId),
        yamlPath: `pipeline.tracks[${trackIndex}].tasks[${taskIndex}]`,
        track: trackId,
        task: taskId,
        depends_on: stringList(task.depends_on),
        inputs: bindingNames(task.inputs),
        outputs: bindingNames(task.outputs),
      };
      sections.push(stripEmptySectionFields(section));
    });
  });

  return {
    schemaVersion: 1,
    kind: 'tagma-pipeline-manifest',
    generatedFor: options.yamlBasename,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    pipeline: {
      name: pipelineName,
      yaml: options.yamlBasename,
    },
    sections,
    editPolicy: {
      defaultScope: 'single-section',
      preserveUnselectedSections: true,
      manifestOwner: 'editor',
      updateWhen: [
        'YAML pipeline topology changes',
        'task names, dependencies, inputs, outputs, prompt/command type, or track names change',
        'a new pipeline is created before detailed YAML authoring starts',
      ],
      bypassWhen: [
        'manifest file is missing, unreadable, stale, or contradicts the YAML',
        'the user explicitly requests a whole-pipeline refactor or rename',
        'the user is creating the initial manifest/YAML pair for a new pipeline',
      ],
    },
  };
}

export function runPipelineManifestSync(yamlPath: string): PipelineManifest | null {
  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    console.warn(`[pipeline-manifest] failed to read ${yamlPath}:`, err);
    removeManifestIfPresent(yamlPath);
    return null;
  }

  let manifest: PipelineManifest;
  try {
    manifest = buildPipelineManifestFromYaml(content, {
      yamlBasename: basename(yamlPath),
    });
  } catch (err) {
    console.warn(`[pipeline-manifest] yaml parse failed, skipping sync for ${yamlPath}:`, err);
    removeManifestIfPresent(yamlPath);
    return null;
  }

  const targetPath = pipelineManifestPath(yamlPath);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (err) {
    console.warn(`[pipeline-manifest] failed to write ${targetPath}:`, err);
    return null;
  }
}

/**
 * Generate a minimal valid YAML pipeline skeleton from a manifest.
 * Used in the manifest-first creation flow: the chat agent writes a
 * manifest describing the desired structure (tracks, tasks, topology),
 * and this function produces the corresponding YAML with placeholder
 * task content that the agent then fills in.
 *
 * The skeleton preserves the full topology (tracks, tasks, depends_on,
 * inputs, outputs) so the agent can focus on filling in task content
 * without having to reconstruct the graph.
 */
export function buildYamlSkeletonFromManifest(manifest: PipelineManifest): string {
  const pipelineName = manifest.pipeline.name || 'Untitled Pipeline';

  // Extract track sections (preserve order from manifest)
  const trackSections = manifest.sections.filter((s) => s.type === 'track');

  // Build task index by track
  const tasksByTrack = new Map<string, PipelineManifestSection[]>();
  for (const section of manifest.sections) {
    if (section.type === 'command' || section.type === 'prompt' || section.type === 'unknown') {
      const trackId = section.track;
      if (!trackId) continue;
      const list = tasksByTrack.get(trackId) ?? [];
      list.push(section);
      tasksByTrack.set(trackId, list);
    }
  }

  const tracks = trackSections.map((trackSection) => {
    const trackId = trackSection.track ?? trackSection.id.replace(/^track:/, '');
    const trackName = trackSection.summary || trackId;
    const taskSections = tasksByTrack.get(trackId) ?? [];

    const tasks = taskSections.map((taskSection) => {
      const taskId = taskSection.task ?? taskSection.id.replace(/^task:/, '');
      const isCommand = taskSection.type === 'command';
      const defaultPrompt =
        taskSection.summary && taskSection.summary !== taskId
          ? taskSection.summary
          : `TODO: define ${isCommand ? 'command' : 'prompt'} for ${taskId}`;

      const task: Record<string, unknown> = { id: taskId };
      if (taskSection.summary && taskSection.summary !== taskId) {
        task.name = taskSection.summary;
      }
      if (isCommand) {
        task.command = defaultPrompt;
      } else {
        task.prompt = defaultPrompt;
      }
      if (taskSection.depends_on && taskSection.depends_on.length > 0) {
        task.depends_on = [...taskSection.depends_on];
      }
      if (taskSection.inputs && taskSection.inputs.length > 0) {
        task.inputs = Object.fromEntries(taskSection.inputs.map((name) => [name, {}]));
      }
      if (taskSection.outputs && taskSection.outputs.length > 0) {
        task.outputs = Object.fromEntries(taskSection.outputs.map((name) => [name, {}]));
      }
      return task;
    });

    return {
      id: trackId,
      name: trackName,
      tasks: tasks.length > 0 ? tasks : [{ id: 'placeholder', prompt: 'TODO: add tasks' }],
    };
  });

  const pipelineObj: Record<string, unknown> = { name: pipelineName };
  if (tracks.length > 0) {
    pipelineObj.tracks = tracks;
  } else {
    pipelineObj.tracks = [
      { id: 'main', name: 'Main', tasks: [{ id: 'placeholder', prompt: 'TODO: add tasks' }] },
    ];
  }

  const dumpOptions: NonNullable<Parameters<typeof yaml.dump>[1]> & { noRefs: boolean } = {
    lineWidth: -1,
    noRefs: true,
  };
  return yaml.dump({ pipeline: pipelineObj }, dumpOptions);
}

function removeManifestIfPresent(yamlPath: string): void {
  const targetPath = pipelineManifestPath(yamlPath);
  try {
    if (existsSync(targetPath)) rmSync(targetPath, { force: true });
  } catch (err) {
    console.warn(`[pipeline-manifest] failed to remove stale ${targetPath}:`, err);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function taskType(task: ParsedTask): PipelineManifestSectionType {
  if (task.command !== undefined) return 'command';
  if (task.prompt !== undefined) return 'prompt';
  return 'unknown';
}

function taskSummary(task: ParsedTask, fallback: string): string {
  if (typeof task.name === 'string' && task.name.trim()) return task.name.trim();
  const body = task.command ?? task.prompt;
  if (typeof body === 'string' && body.trim()) {
    return clip(body.trim().split(/\r?\n/)[0] ?? fallback);
  }
  return fallback;
}

function clip(value: string): string {
  return value.length > 96 ? `${value.slice(0, 93)}...` : value;
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function bindingNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record).filter((key) => key.trim().length > 0);
}

function stripEmptySectionFields(section: PipelineManifestSection): PipelineManifestSection {
  return Object.fromEntries(
    Object.entries(section).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as unknown as PipelineManifestSection;
}
