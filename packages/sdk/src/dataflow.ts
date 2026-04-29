// Sourced from `@tagma/core` (top-level) rather than `@tagma/core/ports`
// for consistency with the rest of the SDK; both subpaths re-export the
// same symbols today, but mixing them across files makes import-graph
// audits noisier than they need to be.
export {
  extractInputReferences,
  extractTaskBindingOutputs,
  extractTaskOutputs,
  inferPromptPorts,
  resolveTaskBindingInputs,
  resolveTaskInputs,
  substituteInputs,
} from '@tagma/core';

export type {
  BindingInputResolution,
  ExtractResult,
  InputResolution,
  PromptDownstreamNeighbor,
  PromptPortConflict,
  PromptPortInference,
  PromptUpstreamNeighbor,
  SubstituteResult,
  UpstreamBindingData,
} from '@tagma/core';
