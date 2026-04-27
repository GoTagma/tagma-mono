export {
  extractInputReferences,
  extractTaskBindingOutputs,
  extractTaskOutputs,
  inferPromptPorts,
  resolveTaskBindingInputs,
  resolveTaskInputs,
  substituteInputs,
} from '@tagma/core/ports';

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
} from '@tagma/core/ports';
