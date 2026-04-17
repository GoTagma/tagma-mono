import type {
  PipelineConfig,
  RawPipelineConfig,
  RawTaskConfig,
  TaskConfig,
  TrackConfig,
} from './types';

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

// Build a global task ID: for cross-track refs we use "track_id.task_id"
// Within a track, bare "task_id" is also valid
function qualifyId(trackId: string, taskId: string): string {
  return `${trackId}.${taskId}`;
}

export function buildDag(config: PipelineConfig): Dag {
  const nodes = new Map<string, DagNode>();
  // Map bare task IDs to qualified IDs (for resolving unqualified refs)
  const bareToQualified = new Map<string, string>();

  // 1. Register all nodes
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyId(track.id, task.id);

      if (nodes.has(qid)) {
        throw new Error(`Duplicate task ID: "${qid}"`);
      }

      // Track bare ID → qualified. If same bare ID in multiple tracks, mark ambiguous
      if (bareToQualified.has(task.id)) {
        bareToQualified.set(task.id, '__ambiguous__');
      } else {
        bareToQualified.set(task.id, qid);
      }

      nodes.set(qid, {
        taskId: qid,
        task,
        track,
        dependsOn: [], // filled below
      });
    }
  }

  // Helper to resolve a dependency ref to a qualified ID
  function resolveRef(ref: string, fromTrackId: string): string {
    // Already qualified (contains dot)
    if (ref.includes('.')) {
      if (!nodes.has(ref)) {
        throw new Error(`Task reference "${ref}" not found`);
      }
      return ref;
    }
    // Try within same track first
    const sameTrack = qualifyId(fromTrackId, ref);
    if (nodes.has(sameTrack)) return sameTrack;
    // Try global bare lookup
    const global = bareToQualified.get(ref);
    if (global && global !== '__ambiguous__') return global;
    if (global === '__ambiguous__') {
      throw new Error(
        `Ambiguous task reference "${ref}" exists in multiple tracks. ` +
          `Use "track_id.task_id" format.`,
      );
    }
    throw new Error(`Task reference "${ref}" not found`);
  }

  // 2. Resolve depends_on and continue_from to qualified IDs
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = qualifyId(track.id, task.id);
      const deps: string[] = [];
      let resolvedContinueFrom: string | undefined;

      if (task.depends_on) {
        for (const dep of task.depends_on) {
          deps.push(resolveRef(dep, track.id));
        }
      }
      if (task.continue_from) {
        let resolved: string;
        try {
          resolved = resolveRef(task.continue_from, track.id);
        } catch {
          throw new Error(
            `Task "${qid}": continue_from "${task.continue_from}" — no such task found. ` +
              `Use a fully-qualified reference (trackId.taskId) or ensure the target task exists.`,
          );
        }
        resolvedContinueFrom = resolved;
        if (!deps.includes(resolved)) {
          deps.push(resolved); // continue_from implies dependency
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

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  // Use an index pointer instead of shift() to avoid O(n) per dequeue.
  let qi = 0;
  while (qi < queue.length) {
    const current = queue[qi++]!;
    sorted.push(current);
    for (const child of adjacency.get(current)!) {
      const newDegree = inDegree.get(child)! - 1;
      inDegree.set(child, newDegree);
      if (newDegree === 0) queue.push(child);
    }
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
  const bareToQualified = new Map<string, string>();

  // 1. Register all concrete tasks
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = `${track.id}.${task.id}`;
      if (nodes.has(qid)) continue; // skip duplicates silently

      if (bareToQualified.has(task.id)) {
        bareToQualified.set(task.id, '__ambiguous__');
      } else {
        bareToQualified.set(task.id, qid);
      }
      nodes.set(qid, { taskId: qid, trackId: track.id, rawTask: task, dependsOn: [] });
    }
  }

  // 2. Resolve dependency refs leniently (missing / ambiguous refs are skipped)
  function tryResolve(ref: string, fromTrackId: string): string | null {
    if (ref.includes('.')) return nodes.has(ref) ? ref : null;
    const sameTrack = `${fromTrackId}.${ref}`;
    if (nodes.has(sameTrack)) return sameTrack;
    const global = bareToQualified.get(ref);
    if (global && global !== '__ambiguous__') return global;
    return null;
  }

  const edges: { from: string; to: string }[] = [];

  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = `${track.id}.${task.id}`;
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

      const node = nodes.get(qid)!;
      nodes.set(qid, { ...node, dependsOn: deps });
    }
  }

  return { nodes, edges };
}
