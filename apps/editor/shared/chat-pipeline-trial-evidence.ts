/**
 * Shared bound for a single stdout/stderr stream captured into Trial evidence.
 *
 * This is the single source of truth for BOTH the producer and the consumer of
 * a bounded trial stream:
 * - The trial-run layer (`buildChatPipelineTrialStreamEvidence`) truncates each
 *   stream to this many BYTES with head+tail preservation.
 * - The repair-prompt layer (`compactChatTrialRepairTask`) accepts at least
 *   this many CHARACTERS so it never re-truncates what the trial already
 *   preserved. Because every character is at least one UTF-8 byte, a stream
 *   bounded to N bytes is at most N characters, so a character ceiling of N is
 *   always sufficient to hold it intact.
 *
 * Keeping the two layers on one constant (rather than two independent magic
 * numbers) guarantees the repair prompt never hides the tail of a diagnostic
 * stream behind a second, tighter truncation.
 */
export const TRIAL_STREAM_EVIDENCE_BYTES = 8 * 1024;
