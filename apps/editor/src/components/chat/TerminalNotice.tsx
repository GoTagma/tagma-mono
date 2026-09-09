import { AlertTriangle } from 'lucide-react';
import type { ChatOperationFeedback } from '../../../shared/chat-operation-feedback';
import type {
  ChatOperationV2OperationDetail,
  ChatOperationV2FailureProjection,
} from '../../api/chat-operations';
import { restoreChatOperationRequest, useChatStore } from '../../store/chat-store';
import {
  chatOperationV2FailurePresentation,
  chatOperationV2TerminalDiscardPresentation,
} from '../../utils/chat-operation-v2-failure';

export function ChatOperationV2TerminalNoticeView({
  terminalOutcome,
  terminalReasonCode = null,
  failure = null,
  feedback = null,
  onEditRequest,
  editRequestDisabled = false,
}: {
  terminalOutcome: 'discarded' | 'failed_terminal';
  terminalReasonCode?: string | null;
  failure?: ChatOperationV2FailureProjection | null;
  feedback?: ChatOperationFeedback | null;
  onEditRequest?: () => void;
  editRequestDisabled?: boolean;
}) {
  const discarded = terminalOutcome === 'discarded';
  const reason = chatOperationV2TerminalDiscardPresentation(terminalReasonCode);
  const providerFailure =
    !terminalReasonCode && failure ? chatOperationV2FailurePresentation(failure) : null;
  const failureStage = failure
    ? {
        classification: 'Understanding the request',
        readonly: 'Preparing the response',
        authoring: 'Writing the pipeline draft',
        repair: 'Repairing the pipeline draft',
        verification: 'Preparing verification',
        operation: 'Processing the request',
      }[failure.stage]
    : null;
  return (
    <section
      aria-label="Chat operation did not complete"
      className="max-w-[90%] self-start border border-tagma-error/35 bg-tagma-surface px-3 py-2"
    >
      <div className="flex items-center gap-2 text-label font-sans text-tagma-text">
        <AlertTriangle size={12} className="shrink-0 text-tagma-error" />
        <span>
          {reason?.title ??
            providerFailure?.title ??
            (discarded ? 'Pipeline update was not published' : 'Chat operation stopped')}
        </span>
      </div>
      <p className="mt-1 text-caption font-sans text-tagma-muted break-words">
        {reason?.detail ??
          'This request ended without publishing a result. Your current pipeline was left unchanged.'}
      </p>
      {providerFailure && (
        <p className="mt-1 text-caption text-tagma-muted">Stage: {failureStage}</p>
      )}
      {feedback ? (
        <div className="mt-2 min-w-0 text-caption text-tagma-muted">
          <div className="font-medium">
            {feedback.stage === 'compile'
              ? 'Compilation'
              : feedback.stage === 'trial_plan'
                ? 'Trial planning'
                : 'Trial verification'}
          </div>
          {feedback.failedTaskIds.length > 0 && (
            <div className="mt-1 break-words font-mono">
              Failed tasks: {feedback.failedTaskIds.join(', ')}
              {feedback.omittedFailedTaskCount > 0
                ? ` · ${feedback.omittedFailedTaskCount} more`
                : ''}
            </div>
          )}
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
            {feedback.details}
          </pre>
        </div>
      ) : terminalReasonCode ? (
        <p className="mt-1 text-caption font-sans text-tagma-muted/80">
          Detailed verification information was not recorded for this operation.
        </p>
      ) : null}
      <p className="mt-1 text-caption font-sans text-tagma-muted/80">
        You can edit this request and send it again.
      </p>
      {terminalReasonCode || providerFailure ? (
        <p className="mt-1 text-caption font-mono text-tagma-muted-dim">
          {`Reason: ${terminalReasonCode ?? failure?.code}`}
        </p>
      ) : null}
      {onEditRequest && (
        <button
          type="button"
          onClick={onEditRequest}
          disabled={editRequestDisabled}
          title={
            editRequestDisabled
              ? 'Keep or clear the current draft before reusing this request.'
              : 'Put this request back in the composer for review; it is not sent automatically.'
          }
          className="mt-2 border border-tagma-border px-2 py-1 text-caption text-tagma-text disabled:opacity-50"
        >
          Edit request
        </button>
      )}
    </section>
  );
}

export function ChatOperationV2TerminalNotice({
  detail,
}: {
  detail: ChatOperationV2OperationDetail;
}) {
  const operation = detail.operation;
  const canEdit = useChatStore(
    (state) =>
      !state.sending && state.composerDraft.length === 0 && state.composerAttachments.length === 0,
  );
  if (
    operation?.executionState !== 'terminal' ||
    (operation.terminalOutcome !== 'discarded' && operation.terminalOutcome !== 'failed_terminal')
  ) {
    return null;
  }
  return (
    <ChatOperationV2TerminalNoticeView
      terminalOutcome={operation.terminalOutcome}
      terminalReasonCode={operation.terminalReasonCode ?? null}
      failure={detail.failure}
      feedback={detail.verificationFeedback ?? null}
      editRequestDisabled={!canEdit}
      onEditRequest={() => {
        restoreChatOperationRequest(detail.userMessage);
      }}
    />
  );
}
