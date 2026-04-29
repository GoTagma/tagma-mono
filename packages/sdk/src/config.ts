export {
  createEmptyPipeline,
  setPipelineField,
  upsertTrack,
  removeTrack,
  moveTrack,
  updateTrack,
  upsertTask,
  removeTask,
  moveTask,
  transferTask,
} from './config-ops';
export { validateRaw } from './validate-raw';
export type { ValidationError, KnownPluginTypes, KnownPluginSchemas } from './validate-raw';
// `validateConfig` is the resolved-config counterpart of `validateRaw`;
// historically only exposed under `./yaml` for parse-and-validate flows,
// but config editors that resolve a raw config in-process also want it.
// Re-exported here so callers can stay on the `./config` subpath without
// reaching into `./yaml` for a non-YAML concern.
export { validateConfig, PipelineValidationError } from './schema';
export { buildDag, buildRawDag } from '@tagma/core';
export type { Dag, DagNode, RawDag, RawDagNode } from '@tagma/core';
export {
  TASK_ID_RE,
  isValidTaskId,
  qualifyTaskId,
  isQualifiedRef,
  buildTaskIndex,
  resolveTaskRef,
  AMBIGUOUS,
} from '@tagma/core';
export type { TaskIndex, RefResolution } from '@tagma/core';
