export const CREATE_NEW_PIPELINE_ACTION_KIND = 'create-new-pipeline';
export const FILL_MANUAL_NEW_PIPELINE_ACTION_KIND = 'fill-manual-new-pipeline';

export type PipelineRequestedActionKind =
  typeof CREATE_NEW_PIPELINE_ACTION_KIND | typeof FILL_MANUAL_NEW_PIPELINE_ACTION_KIND;

export type ChatPipelineRouteIntent = 'create' | 'edit';

export function isChatPipelineRouteIntent(value: unknown): value is ChatPipelineRouteIntent {
  return value === 'create' || value === 'edit';
}

export interface HostPipelineRequestState {
  currentPipelineIsManualNewDraft?: boolean;
  /** Explicit structured UI/Host action. Presence, including null, suppresses state derivation. */
  explicitAction?: PipelineRequestedActionKind | null;
}

export function requestedActionLines(action: PipelineRequestedActionKind): string[] {
  if (action === FILL_MANUAL_NEW_PIPELINE_ACTION_KIND) {
    return [
      `  <requested-action kind="${FILL_MANUAL_NEW_PIPELINE_ACTION_KIND}">`,
      '    <target>current-file</target>',
      '    <reason>current file is the editor-created manual new pipeline draft</reason>',
      '  </requested-action>',
    ];
  }
  return [
    `  <requested-action kind="${CREATE_NEW_PIPELINE_ACTION_KIND}">`,
    '    <collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
    '  </requested-action>',
  ];
}

/**
 * Resolve only authenticated editor/Host state. Natural-language intent remains
 * the model router's responsibility and must never be inferred with a phrase list;
 * no-marker mutations bind that classification separately to their stage id.
 */
export function resolveHostPipelineRequestedAction(
  state: HostPipelineRequestState,
): PipelineRequestedActionKind | null {
  if (Object.prototype.hasOwnProperty.call(state, 'explicitAction')) {
    return isPipelineRequestedActionKind(state.explicitAction) ? state.explicitAction : null;
  }
  return state.currentPipelineIsManualNewDraft === true
    ? FILL_MANUAL_NEW_PIPELINE_ACTION_KIND
    : null;
}

export function isCreateNewPipelineRequestedAction(value: unknown): boolean {
  if (value === CREATE_NEW_PIPELINE_ACTION_KIND) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { kind?: unknown }).kind === CREATE_NEW_PIPELINE_ACTION_KIND;
}

export function isPipelineRequestedActionKind(
  value: unknown,
): value is PipelineRequestedActionKind {
  return (
    value === CREATE_NEW_PIPELINE_ACTION_KIND || value === FILL_MANUAL_NEW_PIPELINE_ACTION_KIND
  );
}
