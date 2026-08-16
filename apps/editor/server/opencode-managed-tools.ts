/**
 * Stable identity for every custom tool owned by the embedded Tagma runtime.
 *
 * Keep deployment, legacy migration, and lifecycle readiness on this single
 * contract so a tool cannot be moved or renamed in one layer while another
 * layer continues to report the runtime as ready.
 */
export const TAGMA_MANAGED_OPENCODE_TOOLS = [
  { id: 'tagma_yaml_skeleton', filename: 'tagma_yaml_skeleton.ts' },
  { id: 'tagma_placement_plan', filename: 'tagma_placement_plan.ts' },
  { id: 'tagma_trial_plan', filename: 'tagma_trial_plan.ts' },
] as const;

export const TAGMA_MANAGED_OPENCODE_TOOL_IDS = TAGMA_MANAGED_OPENCODE_TOOLS.map(({ id }) => id);
