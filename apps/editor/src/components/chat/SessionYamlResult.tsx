/**
 * Pipeline result presentation for chat turns.
 *
 * A chat turn that authors or verifies a YAML pipeline ends with a
 * `ChatYamlSessionResult`. Anchored results render fused into the bottom of
 * the owning assistant bubble (`SessionYamlResultFooter` — the result reads
 * as the bubble's outcome strip, not a separate card); results that arrive
 * without an anchor message keep the original standalone card
 * (`SessionYamlResultBubble`).
 *
 * The shared body (status row, summary, telemetry, open action, target
 * warning) is factored into `SessionYamlResultBody` so the two containers
 * can never drift apart.
 */
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import type { ChatYamlSessionResult } from '../../store/chat-store';
import {
  chatPipelineDeploymentTarget,
  chatPipelineDisplayName,
  chatPipelineTargetInvalidReason,
  useChatPipelineTargetAvailability,
  useOpenChatPipelineTarget,
} from './chat-pipeline-link';
import { formatTokens } from './StructuredParts';

export function describeSessionYamlResult(result: ChatYamlSessionResult): {
  verb: string;
  outcome: string;
  detail: string | null;
} {
  const name = chatPipelineDisplayName(result);
  const attempts = Math.max(0, Math.trunc(result.repairAttempts ?? 0));
  const attemptLabel = `${attempts} cycle${attempts === 1 ? '' : 's'}`;
  const detail = result.trial?.summary || result.compile.summary || null;

  if (result.status === 'ready') {
    const passed = result.trial
      ? result.trial.kind === 'passed-with-warnings'
        ? 'Compile passed; trial run passed with warnings.'
        : 'Compile and trial run passed.'
      : 'Compile passed.';
    const outcome =
      attempts > 0 ? `Pipeline repair succeeded after ${attemptLabel}. ${passed}` : passed;
    const verb =
      result.reconcile?.outcome === 'unchanged'
        ? 'Pipeline unchanged'
        : result.reconcile?.outcome === 'forked'
          ? 'Saved pipeline copy'
          : result.kind === 'open-created'
            ? 'Created pipeline'
            : 'Updated pipeline';
    return { verb, outcome, detail };
  }

  if (result.status === 'blocked') {
    const verb =
      result.reconcile?.outcome === 'created'
        ? 'Created pipeline'
        : result.reconcile?.outcome === 'forked'
          ? 'Saved pipeline copy'
          : 'Updated pipeline';
    return {
      verb,
      outcome: `Pipeline compilation passed, but Trial could not start because runtime prerequisites are unavailable. ${result.reconcile?.outcome === 'forked' ? 'The host kept the final copy in place' : 'The pipeline was kept in place without creating a copy'}; add the listed prerequisites and run it again.`,
      detail,
    };
  }

  const failed =
    attempts > 0
      ? `Pipeline repair did not succeed after ${attemptLabel}.`
      : 'Pipeline verification failed.';
  const failedHint =
    result.trial?.repairAuthorization === 'diagnostic-only'
      ? ' The failure is a non-pipeline limitation (unavailable driver, credential, environment, or a harness observation limit); check the environment and retry.'
      : ' Open the saved copy to inspect the remaining pipeline defects.';
  if (result.reconcile?.outcome === 'forked') {
    return {
      verb: 'Saved failed draft',
      outcome: `${failed}${failedHint} No live pipeline was overwritten. The unverified draft was saved as ${name}.`,
      detail,
    };
  }
  if (chatPipelineDeploymentTarget(result)) {
    return {
      verb:
        result.reconcile?.outcome === 'created' ? 'Created failed draft' : 'Updated failed draft',
      outcome: `${failed}${failedHint} The host kept the final pipeline at ${name} for inspection.`,
      detail,
    };
  }
  return {
    verb: 'Pipeline verification failed',
    outcome: `${failed}${failedHint} No pipeline changes were published.`,
    detail,
  };
}

/**
 * Status row + summary + telemetry + open action + target warning. Shared by
 * the fused bubble footer and the standalone card so the two presentations
 * of the same result can never drift apart.
 */
function SessionYamlResultBody({ result }: { result: ChatYamlSessionResult }) {
  const openTarget = useOpenChatPipelineTarget();
  const name = chatPipelineDisplayName(result);
  const deploymentTarget = chatPipelineDeploymentTarget(result);
  const invalidTargetReason = chatPipelineTargetInvalidReason(result);
  const { availability, revalidate } = useChatPipelineTargetAvailability(deploymentTarget);
  const openableTarget = availability.available ? availability.target : null;
  const unavailableReason =
    invalidTargetReason ??
    (deploymentTarget && !availability.available ? availability.reason : null);
  const ok = result.status === 'ready';
  const warning =
    result.status === 'blocked' || (ok && result.trial?.kind === 'passed-with-warnings');
  const presentation = describeSessionYamlResult(result);
  const verb = presentation.verb;
  const summary =
    presentation.detail && presentation.detail !== presentation.outcome
      ? `${presentation.outcome} ${presentation.detail}`
      : presentation.outcome;

  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        {warning ? (
          <AlertTriangle size={12} className="text-tagma-warning shrink-0" />
        ) : ok ? (
          <CheckCircle2 size={12} className="text-tagma-ready shrink-0" />
        ) : (
          <AlertTriangle size={12} className="text-tagma-error shrink-0" />
        )}
        <span className="shrink-0 text-tagma-muted/80">{verb}</span>
        <span className="truncate text-tagma-text" title={name}>
          {name}
        </span>
      </div>
      <div className="select-text text-tagma-muted/80 break-words">{summary}</div>
      {result.planningTelemetry && (
        <TrialPlanningTelemetryDetails telemetry={result.planningTelemetry} />
      )}
      {(deploymentTarget || invalidTargetReason) && (
        <button
          type="button"
          disabled={!openableTarget}
          onClick={() => {
            void revalidate().then((latest) => {
              if (latest.available) void openTarget(latest.target);
            });
          }}
          className="self-start flex items-center gap-1 px-2 py-1 border border-tagma-border text-caption text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
          title={`Open ${name}`}
        >
          <FileText size={11} />
          <span>Open pipeline</span>
        </button>
      )}
      {unavailableReason && (
        <div role={'status'} className={'select-text text-tiny text-tagma-warning break-words'}>
          {unavailableReason}
        </div>
      )}
    </>
  );
}

/**
 * Standalone result card. Used for the session-level result whose anchoring
 * assistant message is no longer visible (or never existed) — fused results
 * go through SessionYamlResultFooter instead.
 */
export function SessionYamlResultBubble({ result }: { result: ChatYamlSessionResult }) {
  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="section-label">pipeline result</div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-2 px-2.5 py-2 text-caption font-mono border border-tagma-border bg-tagma-bg text-tagma-muted">
        <SessionYamlResultBody result={result} />
      </div>
    </div>
  );
}

/**
 * Result strip fused into the bottom of the owning assistant bubble. Sits
 * inside the bubble card below a hairline divider on a slightly recessed
 * tint, so the outcome reads as the bubble's own footer rather than a
 * separate card trailing the conversation.
 */
export function SessionYamlResultFooter({
  results,
}: {
  results: readonly ChatYamlSessionResult[];
}) {
  return (
    // Self-framed strip: the assistant message itself is box-free, so the
    // fused footer carries its own quiet frame instead of the old in-card
    // divider. It still renders inside the owning message's flow.
    <div className="mt-1.5 border border-tagma-border/50 bg-tagma-surface px-3 py-2 text-caption font-mono text-tagma-muted flex flex-col gap-1.5">
      <div className="text-micro uppercase tracking-widest text-tagma-muted-dim">
        pipeline result
      </div>
      {results.map((result, index) => (
        <div
          key={result.resultId ?? result.completedAt}
          className={
            index > 0
              ? 'flex flex-col gap-1.5 border-t border-tagma-border/30 pt-2'
              : 'flex flex-col gap-1.5'
          }
        >
          <SessionYamlResultBody result={result} />
        </div>
      ))}
    </div>
  );
}

function TrialPlanningTelemetryDetails({
  telemetry,
}: {
  telemetry: NonNullable<ChatYamlSessionResult['planningTelemetry']>;
}) {
  const prompts = `${telemetry.promptCount} prompt${telemetry.promptCount === 1 ? '' : 's'}`;
  const toolAttempts = `${telemetry.toolAttemptCount} tool attempt${telemetry.toolAttemptCount === 1 ? '' : 's'}`;
  const rejections = `${telemetry.validationRejectionCount} validation rejection${telemetry.validationRejectionCount === 1 ? '' : 's'}`;
  const inputTokens =
    telemetry.inputTokens + telemetry.cacheReadTokens + telemetry.cacheWriteTokens;
  const outputTokens = telemetry.outputTokens + telemetry.reasoningTokens;
  return (
    <details className="select-text border-t border-tagma-border/60 pt-1.5 text-tiny">
      <summary className="cursor-pointer text-tagma-muted/80">
        Trial planning: {prompts} / {toolAttempts} / {rejections}
      </summary>
      <div className="mt-1 text-tagma-muted/70">
        {formatTokens(inputTokens)} input tokens / {formatTokens(outputTokens)} output tokens /{' '}
        {(telemetry.elapsedMs / 1_000).toFixed(1)}s
        {telemetry.repeatedValidationRejectionCount > 0
          ? ` / ${telemetry.repeatedValidationRejectionCount} repeated rejection${telemetry.repeatedValidationRejectionCount === 1 ? '' : 's'}`
          : ''}
      </div>
    </details>
  );
}
