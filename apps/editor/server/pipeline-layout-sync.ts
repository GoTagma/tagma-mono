import { existsSync, lstatSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { computeTagmaPlacement, type PlacementTrack } from './opencode-placement.js';
import { atomicWriteFileSync } from './path-utils.js';
import { pipelineLayoutPath } from './pipeline-paths.js';
import type { EditorLayout, LayoutTaskPosition, TrackFolder } from './workspace-state.js';

interface ParsedTask {
  id?: unknown;
  depends_on?: unknown;
  continue_from?: unknown;
}

interface ParsedTrack {
  id?: unknown;
  tasks?: unknown;
}

function placementTracksFromYaml(yamlPath: string): PlacementTrack[] | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(yamlPath, 'utf8'));
  } catch {
    return null;
  }
  const pipeline = (parsed as { pipeline?: { tracks?: unknown } } | null)?.pipeline;
  if (!pipeline || !Array.isArray(pipeline.tracks)) return null;

  const tracks: PlacementTrack[] = [];
  for (const rawTrack of pipeline.tracks) {
    if (!rawTrack || typeof rawTrack !== 'object' || Array.isArray(rawTrack)) return null;
    const track = rawTrack as ParsedTrack;
    if (typeof track.id !== 'string' || !track.id || !Array.isArray(track.tasks)) return null;
    const tasks: PlacementTrack['tasks'] = [];
    for (const rawTask of track.tasks) {
      if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) return null;
      const task = rawTask as ParsedTask;
      if (typeof task.id !== 'string' || !task.id) return null;
      const dependsOn = Array.isArray(task.depends_on)
        ? task.depends_on.filter((item): item is string => typeof item === 'string')
        : undefined;
      tasks.push({
        id: task.id,
        ...(dependsOn?.length ? { depends_on: dependsOn } : {}),
        ...(typeof task.continue_from === 'string' && task.continue_from
          ? { continue_from: task.continue_from }
          : {}),
      });
    }
    tracks.push({ id: track.id, tasks });
  }
  return tracks;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readExistingLayout(path: string): EditorLayout | null {
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as unknown as EditorLayout;
  } catch {
    return null;
  }
}

function preservedTaskY(layout: EditorLayout | null, taskId: string): number | undefined {
  const position = layout?.positions?.[taskId] as LayoutTaskPosition | undefined;
  return finiteNumber(position?.y) ? position.y : undefined;
}

function preservedFolders(
  layout: EditorLayout | null,
  validTrackIds: ReadonlySet<string>,
): TrackFolder[] {
  if (!Array.isArray(layout?.folders)) return [];
  return layout.folders
    .flatMap((rawFolder) => {
      if (!rawFolder || typeof rawFolder !== 'object' || Array.isArray(rawFolder)) return [];
      const folder = rawFolder as TrackFolder;
      if (
        typeof folder.id !== 'string' ||
        typeof folder.name !== 'string' ||
        typeof folder.collapsed !== 'boolean' ||
        !Array.isArray(folder.trackIds)
      ) {
        return [];
      }
      return [
        {
          ...folder,
          trackIds: folder.trackIds.filter(
            (trackId): trackId is string =>
              typeof trackId === 'string' && validTrackIds.has(trackId),
          ),
        },
      ];
    })
    .filter((folder) => folder.trackIds.length > 0);
}

function preservedTrackHeights(
  layout: EditorLayout | null,
  validTrackIds: ReadonlySet<string>,
): Record<string, number> {
  const heights: Record<string, number> = {};
  if (!layout?.trackHeights || typeof layout.trackHeights !== 'object') return heights;
  for (const [trackId, height] of Object.entries(layout.trackHeights)) {
    if (validTrackIds.has(trackId) && finiteNumber(height)) heights[trackId] = height;
  }
  return heights;
}

/**
 * Regenerate the mechanical layout owned by a Host-authenticated create/fill
 * turn while preserving surviving editor-owned y offsets, folders, and lane
 * heights. Invalid YAML or unresolved dependency coordinates leave the prior
 * layout untouched; compile diagnostics remain authoritative.
 */
export function runPipelineLayoutSync(yamlPath: string): EditorLayout | null {
  const tracks = placementTracksFromYaml(yamlPath);
  if (!tracks) return null;
  const placement = computeTagmaPlacement({ tracks });
  if (placement.warnings.length > 0) return null;

  const targetPath = pipelineLayoutPath(yamlPath);
  const existing = readExistingLayout(targetPath);
  const positions: Record<string, LayoutTaskPosition> = {};
  for (const [taskId, position] of Object.entries(placement.positions)) {
    const y = preservedTaskY(existing, taskId);
    positions[taskId] = y === undefined ? position : { ...position, y };
  }
  const validTrackIds = new Set(tracks.map((track) => track.id));
  const trackHeights = preservedTrackHeights(existing, validTrackIds);
  const layout: EditorLayout = {
    positions,
    folders: preservedFolders(existing, validTrackIds),
    ...(Object.keys(trackHeights).length > 0 ? { trackHeights } : {}),
  };

  try {
    atomicWriteFileSync(targetPath, `${JSON.stringify(layout, null, 2)}\n`);
    return layout;
  } catch (error) {
    console.warn(`[pipeline-layout] failed to write ${targetPath}:`, error);
    return null;
  }
}
