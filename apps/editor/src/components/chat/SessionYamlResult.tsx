/**
 * Pipeline result presentation for chat turns.
 *
 * A chat turn that authors or verifies a YAML pipeline ends with a
 * `ChatYamlSessionResult`. Anchored results render an informational footer in
 * the owning assistant bubble, while the standalone conversation-tail card
 * owns the sole Open pipeline action.
 *
 * The shared body keeps status/summary presentation aligned, while only the
 * standalone conversation-tail card owns the open action.
 */
import { useEffect, useState } from 'react';
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
import { canonicalizeTrialSummaryForStatus } from '../../utils/chat-trial-summary';

export function describeSessionYamlResult(result: ChatYamlSessionResult): {
  verb: string;
  outcome: string;
  detail: string | null;
} {
  const name = chatPipelineDisplayName(result);
  const attempts = Math.max(0, Math.trunc(result.repairAttempts ?? 0));
  const attemptLabel = `${attempts} cycle${attempts === 1 ? '' : 's'}`;
  const detail = result.trial?.summary
    ? canonicalizeTrialSummaryForStatus(result.status, result.trial.summary)
    : result.compile.summary || null;

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
 * Status row + summary + telemetry + target warning. The conversation-tail
 * card owns the sole open action; anchored summaries remain informational so
 * a later Host continuation cannot strand the action in the transcript middle.
 */
function SessionYamlResultBody({
  result,
  showOpenAction,
}: {
  result: ChatYamlSessionResult;
  showOpenAction: boolean;
}) {
  const name = chatPipelineDisplayName(result);
  const ok = result.status === 'ready';
  const blocked = result.status === 'blocked';
  const passedWithWarnings = ok && result.trial?.kind === 'passed-with-warnings';
  const presentation = describeSessionYamlResult(result);
  const verb = presentation.verb;
  const summary =
    presentation.detail && presentation.detail !== presentation.outcome
      ? `${presentation.outcome} ${presentation.detail}`
      : presentation.outcome;

  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        {ok ? (
          <CheckCircle2
            size={12}
            className={`${passedWithWarnings ? 'text-tagma-warning' : 'text-tagma-ready'} shrink-0`}
          />
        ) : (
          <AlertTriangle
            size={12}
            className={`${blocked ? 'text-tagma-warning' : 'text-tagma-error'} shrink-0`}
          />
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
      {showOpenAction && <SessionYamlOpenAction result={result} name={name} />}
    </>
  );
}

function SessionYamlOpenAction({ result, name }: { result: ChatYamlSessionResult; name: string }) {
  const openTarget = useOpenChatPipelineTarget();
  const deploymentTarget = chatPipelineDeploymentTarget(result);
  const invalidTargetReason = chatPipelineTargetInvalidReason(result);
  const { availability } = useChatPipelineTargetAvailability(deploymentTarget);
  const openableTarget = deploymentTarget;
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const unavailableReason =
    openFailure ??
    invalidTargetReason ??
    (deploymentTarget && !availability.available ? availability.reason : null);

  useEffect(() => {
    setOpenFailure(null);
  }, [deploymentTarget?.path]);

  return (
    <>
      {(deploymentTarget || invalidTargetReason) && (
        <button
          type="button"
          disabled={!openableTarget || opening}
          aria-busy={opening || undefined}
          onClick={() => {
            if (!openableTarget || opening) return;
            setOpening(true);
            setOpenFailure(null);
            void openTarget(openableTarget)
              .then((outcome) => {
                if (!outcome.handled) setOpenFailure(outcome.reason);
              })
              .catch(() => setOpenFailure('The final pipeline could not be opened.'))
              .finally(() => setOpening(false));
          }}
          className="self-start flex items-center gap-1 px-2 py-1 border border-tagma-border text-caption text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
          title={`Open ${name}`}
        >
          <FileText size={11} />
          <span>{opening ? 'Opening…' : 'Open pipeline'}</span>
        </button>
      )}
      {unavailableReason && (
        <div
          role={openFailure ? 'alert' : 'status'}
          className={'select-text text-tiny text-tagma-warning break-words'}
        >
          {unavailableReason}
        </div>
      )}
    </>
  );
}

/**
 * Standalone session result card. ChatMessages places this at the conversation
 * tail even when the same result also has an anchored informational summary.
 */
export function SessionYamlResultBubble({
  result,
  showOpenAction = true,
}: {
  result: ChatYamlSessionResult;
  showOpenAction?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="section-label">pipeline result</div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-2 px-2.5 py-2 text-caption font-mono border border-tagma-border bg-tagma-bg text-tagma-muted">
        <SessionYamlResultBody result={result} showOpenAction={showOpenAction} />
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
          <SessionYamlResultBody result={result} showOpenAction={false} />
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
