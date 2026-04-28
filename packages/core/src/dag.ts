import type {
  PipelineConfig,
  RawPipelineConfig,
  RawTaskConfig,
  TaskConfig,
  TrackConfig,
} from './types';
import { buildTaskIndex, qualifyTaskId, resolveTaskRef } from './task-ref';

export interface DagNode {
  readonly taskId: string; // fully qualified: track_id.task_id or just task_id
  readonly task: TaskConfig;
  readonly track: TrackConfig;
  readonly dependsOn: readonly string[];
  /**
   * H1: `task.continue_from` may be written by users as a bare task id
   * (e.g. `review`) or a same-track shorthand. The driver needs the
   * fully-qualified upstream id to look up output/session/normalized maps
   * deterministically — bare lookups race when two tracks happen to share
   * a task name. dag.ts performs the qualification once, here, so the
   * engine never has to.
   */
  readonly resolvedContinueFrom?: string;
}

export interface Dag {
  readonly nodes: ReadonlyMap<string, DagNode>;
  readonly sorted: readonly string[]; // topological order
}

export function buildDag(config: PipelineConfig): Dag {
  const nodes = new Map<string, DagNode>();

  // 1. Register all nodes. Duplicates throw — same-track task-id collisions
  //    would otherwise silently overwrite one another in the DAG.
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyTaskId(track.id, task.id);
      if (nodes.has(qid)) {
        throw new Error(`Duplicate task ID: "${qid}"`);
      }
      nodes.set(qid, {
        taskId: qid,
        task,
        track,
        dependsOn: [], // filled below
      });
    }
  }

  // Shared index for ref resolution — same code path validate-raw uses.
  const index = buildTaskIndex(config);

  function resolveRef(ref: string, fromTrackId: string): string {
    const result = resolveTaskRef(ref, fromTrackId, index);
    if (result.kind === 'ambiguous') {
      throw new Error(
        `Ambiguous task reference "${ref}" exists in multiple tracks. ` +
          `Use "track_id.task_id" format.`,
      );
    }
    if (result.kind === 'not_found') {
      throw new Error(`Task reference "${ref}" not found`);
    }
    return result.qid;
  }

  // 2. Resolve depends_on and continue_from to qualified IDs
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyTaskId(track.id, task.id);
      const deps: string[] = [];
      let resolvedContinueFrom: string | undefined;

      if (task.depends_on) {
        for (const dep of task.depends_on) {
          deps.push(resolveRef(dep, track.id));
        }
      }
      if (task.continue_from) {
        // Preserve the ambiguous-vs-not-found distinction in the user-facing
        // error: rewording "ambiguous" as "no such task found" (the previous
        // behavior) hid the real problem and sent users searching for a
        // missing task that actually existed in two places.
        const result = resolveTaskRef(task.continue_from, track.id, index);
        if (result.kind === 'ambiguous') {
          throw new Error(
            `Task "${qid}": continue_from "${task.continue_from}" is ambiguous — ` +
              `multiple tracks have a task with this id. Use the fully-qualified ` +
              `form "trackId.${task.continue_from}".`,
          );
        }
        if (result.kind === 'not_found') {
          throw new Error(
            `Task "${qid}": continue_from "${task.continue_from}" — no such task found. ` +
              `Use a fully-qualified reference (trackId.taskId) or ensure the target task exists.`,
          );
        }
        resolvedContinueFrom = result.qid;
        if (!deps.includes(result.qid)) {
          deps.push(result.qid); // continue_from implies dependency
        }
      }

      // Replace node with resolved deps + qualified continue_from.
      const node = nodes.get(qid)!;
      nodes.set(qid, { ...node, dependsOn: deps, resolvedContinueFrom });
    }
  }

  // 3. Topological sort + cycle detection (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // parent → children

  for (const [id] of nodes) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const [id, node] of nodes) {
    for (const dep of node.dependsOn) {
      adjacency.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  // D20: deterministic topo order. Kahn's algorithm dequeues in insertion
  // order by default, which depends on map iteration order — itself a
  // function of the (track, task) order in the YAML. Two pipelines that
  // are DAG-equivalent but written in a different order produced different
  // `sorted` arrays, leading to subtle run-to-run non-determinism for
  // parallel tasks with side effects (writing the same file, touching the
  // same repo). Break the tie by qualified id so identical DAG shapes
  // always yield identical schedules across machines and across YAML
  // round-trips.
  const ready: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) ready.push(id);
  }
  ready.sort();

  const sorted: string[] = [];
  let qi = 0;
  while (qi < ready.length) {
    const current = ready[qi++]!;
    sorted.push(current);
    // Collect children whose in-degree hits zero in this step, then push
    // them into the ready bucket in sorted order — keeps each "wave" of
    // parallel-eligible tasks ordered by qid.
    const newlyReady: string[] = [];
    for (const child of adjacency.get(current)!) {
      const newDegree = inDegree.get(child)! - 1;
      inDegree.set(child, newDegree);
      if (newDegree === 0) newlyReady.push(child);
    }
    if (newlyReady.length > 1) newlyReady.sort();
    for (const child of newlyReady) ready.push(child);
  }

  if (sorted.length !== nodes.size) {
    // Only report nodes that are actually part of cycles (in-degree > 0
    // after Kahn's algorithm), not their downstream dependents.
    const sortedSet = new Set(sorted);
    const cycleMembers = [...nodes.keys()].filter(
      (id) => !sortedSet.has(id) && (inDegree.get(id) ?? 0) > 0,
    );
    throw new Error(`Circular dependency detected involving tasks: ${cycleMembers.join(', ')}`);
  }

  return { nodes, sorted };
}

// ═══ Raw DAG (for visual editor — no workDir required) ═══

export interface RawDagNode {
  readonly taskId: string; // fully qualified: track_id.task_id
  readonly trackId: string;
  readonly rawTask: RawTaskConfig;
  readonly dependsOn: readonly string[]; // fully qualified IDs, best-effort resolved
}

export interface RawDag {
  readonly nodes: ReadonlyMap<string, RawDagNode>;
  /** Directed edges: from → to means "from must complete before to starts" */
  readonly edges: readonly { readonly from: string; readonly to: string }[];
}

/**
 * Build a lightweight DAG from a raw (unresolved) pipeline config.
 * Unlike buildDag, this function:
 *   - Does not require a workDir or resolved PipelineConfig
 *   - Is lenient: missing or ambiguous refs are silently skipped
 *
 * Intended for the visual editor to render the flow graph before a pipeline is run.
 */
export function buildRawDag(config: RawPipelineConfig): RawDag {
  const nodes = new Map<string, RawDagNode>();

  // 1. Register all concrete tasks. Duplicates are skipped (not thrown) so
  //    partially-typed editor state doesn't produce a hard error.
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyTaskId(track.id, task.id);
      if (nodes.has(qid)) continue;
      nodes.set(qid, { taskId: qid, trackId: track.id, rawTask: task, dependsOn: [] });
    }
  }

  const index = buildTaskIndex(config);

  function tryResolve(ref: string, fromTrackId: string): string | null {
    const result = resolveTaskRef(ref, fromTrackId, index);
    return result.kind === 'resolved' ? result.qid : null;
  }

  // 2. Resolve dependency refs leniently (missing / ambiguous refs are skipped)
  const edges: { from: string; to: string }[] = [];

  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyTaskId(track.id, task.id);
      const node = nodes.get(qid);
      if (!node || node.rawTask !== task) continue;
      const deps: string[] = [];

      for (const ref of task.depends_on ?? []) {
        const resolved = tryResolve(ref, track.id);
        if (resolved && !deps.includes(resolved)) {
          deps.push(resolved);
          edges.push({ from: resolved, to: qid });
        }
      }
      if (task.continue_from) {
        const resolved = tryResolve(task.continue_from, track.id);
        if (resolved && !deps.includes(resolved)) {
          deps.push(resolved);
          edges.push({ from: resolved, to: qid });
        }
      }

      nodes.set(qid, { ...node, dependsOn: deps });
    }
  }

  return { nodes, edges };
}
