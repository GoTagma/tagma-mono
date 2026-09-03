import { AlertTriangle, CheckCircle2, CircleMinus, XCircle } from 'lucide-react';

import type {
  ChatPublicationStatus,
  ChatVerificationOutcome,
} from '../../../shared/chat-verification-outcome';
import { CopyButton } from '../run/CopyButton';

type OutcomeStatus =
  ChatVerificationOutcome['sandbox']['status'] | ChatVerificationOutcome['liveSmoke']['status'];

const STATUS_LABELS: Record<OutcomeStatus, string> = {
  passed: 'Passed',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
  not_enabled: 'Not enabled',
};

function StatusIcon({ status }: { status: OutcomeStatus }) {
  if (status === 'passed') return <CheckCircle2 size={11} className="text-tagma-ready" />;
  if (status === 'failed') return <XCircle size={11} className="text-tagma-error" />;
  if (status === 'partial') return <AlertTriangle size={11} className="text-tagma-warning" />;
  return <CircleMinus size={11} className="text-tagma-muted/70" />;
}

function humanizeReason(code: string): string {
  const known: Record<string, string> = {
    trial_blocked: 'Trial was blocked by a safety or runtime prerequisite.',
    trial_failed: 'Trial execution did not pass.',
    trial_timed_out: 'Trial reached its configured lifecycle timeout.',
    trial_passed_with_warnings: 'Trial passed with verification warnings.',
  };
  return known[code] ?? code.replace(/_/g, ' ');
}

function publicationLabel(publication: ChatPublicationStatus): string {
  if (publication === 'published') return 'Pipeline published';
  if (publication === 'forked') return 'Pipeline preserved as an independent fork';
  return 'Pipeline not published';
}

export function ChatVerificationOutcomeView({
  outcome,
  publication,
}: {
  outcome: ChatVerificationOutcome;
  publication: ChatPublicationStatus;
}) {
  const tasks = Object.entries(outcome.sandbox.taskStatusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  const sandboxCounts = `${outcome.sandbox.passedCaseCount}/${outcome.sandbox.plannedCaseCount} cases passed`;
  const borderTone =
    outcome.sandbox.status === 'failed' || outcome.liveSmoke.status === 'failed'
      ? 'border-tagma-error/50'
      : outcome.sandbox.status === 'partial' || outcome.sandbox.status === 'skipped'
        ? 'border-tagma-warning/50'
        : 'border-tagma-ready/50';

  return (
    <section
      className={`min-w-0 border-l-2 pl-2 text-caption font-mono text-tagma-muted ${borderTone}`}
      aria-label="Pipeline verification outcome"
    >
      <div className="mb-1 text-label font-medium text-tagma-text">
        {publicationLabel(publication)}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>Sandbox Trial</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-tagma-text">
          <StatusIcon status={outcome.sandbox.status} />
          <span>{STATUS_LABELS[outcome.sandbox.status]}</span>
          <span className="text-tagma-muted">· {sandboxCounts}</span>
          {outcome.sandbox.notRunCaseCount > 0 && (
            <span className="text-tagma-warning">· {outcome.sandbox.notRunCaseCount} not run</span>
          )}
        </dd>
        <dt>Live Smoke</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-tagma-text">
          <StatusIcon status={outcome.liveSmoke.status} />
          {STATUS_LABELS[outcome.liveSmoke.status]}
        </dd>
      </dl>
      {tasks && <div className="mt-1 break-words text-tagma-muted/80">Tasks: {tasks}</div>}
      {outcome.reasonCode && (
        <div className="mt-1 break-words text-tagma-warning">
          {humanizeReason(outcome.reasonCode)}
        </div>
      )}
      {outcome.details && (
        <details className="chat-disclosure mt-1.5">
          <summary className="cursor-pointer select-none text-tagma-muted hover:text-tagma-text">
            Verification details
          </summary>
          <div className="mt-1 flex items-start gap-2">
            <pre className="max-h-64 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-caption text-tagma-muted">
              {outcome.details}
            </pre>
            <CopyButton value={outcome.details} title="Copy verification details" />
          </div>
        </details>
      )}
    </section>
  );
}
