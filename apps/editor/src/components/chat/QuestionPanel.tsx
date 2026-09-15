import { useId, useRef, useState } from 'react';
import type { ChatOperationV2QuestionPending } from '../../api/chat-operations';
import { useChatStore } from '../../store/chat-store';
import { shouldSubmitChatComposerKey } from '../../utils/chat-composer-key';
import {
  buildQuestionAnswers,
  chatOperationActionKey,
  performChatOperationAction,
} from '../../chat-actions/operation';
export { buildQuestionAnswers } from '../../chat-actions/operation';

type QuestionContent = ChatOperationV2QuestionPending['content'];

export function QuestionForm({
  content,
  onReply,
  onStop,
  externalPending = false,
  stopping = false,
}: {
  content: QuestionContent;
  onReply: (choice: 'reply' | 'reject', answers: readonly string[]) => Promise<boolean>;
  onStop?: () => Promise<unknown>;
  externalPending?: boolean;
  stopping?: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState<number[]>([]);
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submit = async (choice: 'reply' | 'reject') => {
    if (inFlight.current || externalPending) return;
    let answers: string[];
    try {
      answers = choice === 'reject' ? [] : buildQuestionAnswers(content, selected, custom);
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onReply(choice, answers);
    } catch {
      setError('Could not submit the answer. Please try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <form
      aria-labelledby={`${id}-question`}
      className="chat-question-form min-w-0 border-t border-tagma-border px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit('reply');
      }}
    >
      <fieldset disabled={pending || externalPending} className="min-w-0">
        <legend className="text-label font-medium text-tagma-text">
          {content.header || 'Question'}
        </legend>
        <p id={`${id}-question`} className="mt-1 text-label text-tagma-text break-words">
          {content.question}
        </p>
        {content.multiple && (
          <p className="mt-1 text-caption text-tagma-muted">Select all that apply.</p>
        )}
        <div className="mt-2 flex flex-col gap-1">
          {content.options.map((option, index) => (
            <label
              key={`${index}:${option.label}`}
              className="flex min-w-0 cursor-pointer items-start gap-2 border border-tagma-border px-2 py-1.5 hover:bg-tagma-surface"
            >
              <input
                type={content.multiple ? 'checkbox' : 'radio'}
                name={`${id}-options`}
                checked={selected.includes(index)}
                onChange={() => {
                  setError(null);
                  setSelected((previous) =>
                    content.multiple
                      ? previous.includes(index)
                        ? previous.filter((value) => value !== index)
                        : [...previous, index]
                      : [index],
                  );
                  if (!content.multiple) setCustom('');
                }}
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0 break-words text-body text-tagma-text">
                <span className="block">{option.label}</span>
                {option.description && (
                  <span className="block text-caption text-tagma-muted">{option.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        <label className="mt-2 block text-caption text-tagma-muted" htmlFor={`${id}-custom`}>
          {content.options.length === 0
            ? 'Your answer'
            : content.multiple
              ? 'Additional answer (optional)'
              : 'Or write your own answer'}
        </label>
        <textarea
          id={`${id}-custom`}
          rows={2}
          value={custom}
          className="field-input mt-1 w-full min-w-0 resize-y"
          onChange={(event) => {
            setCustom(event.target.value);
            setError(null);
            if (!content.multiple) setSelected([]);
          }}
          onKeyDown={(event) => {
            if (shouldSubmitChatComposerKey(event.nativeEvent)) {
              event.preventDefault();
              void submit('reply');
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary">
            {pending || externalPending ? 'Sending…' : 'Send answer'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => void submit('reject')}>
            Skip question
          </button>
          <span className="text-caption text-tagma-muted">Shift+Enter for a new line</span>
        </div>
      </fieldset>
      {onStop && (
        <button
          type="button"
          className="btn-secondary mt-2"
          disabled={stopping}
          onClick={() =>
            void onStop().catch(() => setError('Could not stop Chat. Please try again.'))
          }
        >
          Stop chat
        </button>
      )}
      {error && (
        <p role="alert" className="mt-1 text-caption text-tagma-error">
          {error}
        </p>
      )}
    </form>
  );
}

export function QuestionPanel() {
  const operation = useChatStore((state) => state.activeChatOperationV2);
  const request = useChatStore((state) =>
    operation ? state.chatOperationV2QuestionRequests[operation.operationId] : undefined,
  );
  const pending = useChatStore(
    (state) =>
      !!operation &&
      !!request &&
      !!state.pendingChatActions[
        chatOperationActionKey({
          type: 'question.reply',
          operationId: operation.operationId,
          requestId: request.requestId,
        })
      ],
  );
  const stopping = useChatStore(
    (state) => !!operation && !!state.pendingChatActions[`${operation.operationId}:stop`],
  );
  if (operation?.executionState !== 'waiting_for_user' || request?.state !== 'live_pending')
    return null;
  return (
    <QuestionForm
      key={`${operation.operationId}:${request.requestId}`}
      content={request.content}
      externalPending={pending}
      stopping={stopping}
      onStop={() =>
        performChatOperationAction({ type: 'operation.stop', operationId: operation.operationId })
      }
      onReply={async (choice, answers) =>
        (
          await performChatOperationAction({
            type: 'question.reply',
            operationId: operation.operationId,
            requestId: request.requestId,
            choice,
            answers,
          })
        ).executed
      }
    />
  );
}
