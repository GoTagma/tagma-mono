export type ChatPipelineTerminalStatus = 'ready' | 'blocked' | 'failed';

const FAILED_TRIAL_SUMMARY_LABEL = /(^|\s)Trial run failed(?=\s*(?:\([^\r\n)]*\)|[:.]))/g;

/** Keep persisted Trial detail aligned with the canonical terminal pipeline status. */
export function canonicalizeTrialSummaryForStatus(
  status: ChatPipelineTerminalStatus,
  summary: string,
): string {
  if (status !== 'blocked') return summary;
  return summary.replace(FAILED_TRIAL_SUMMARY_LABEL, '$1Trial run blocked by prerequisites');
}
