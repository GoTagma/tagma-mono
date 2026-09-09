import { useRef, useState } from 'react';
import type { ChatOperationV2InventoryCandidate } from '../../api/chat-operations';
import { useChatStore } from '../../store/chat-store';

export function ClarificationOptions({
  question,
  candidates,
  pending,
  onChoose,
}: {
  question: string;
  candidates: readonly ChatOperationV2InventoryCandidate[];
  pending: boolean;
  onChoose: (candidateId: string) => void;
}) {
  return (
    <section
      aria-label="Choose a pipeline"
      className="min-w-0 border-t border-tagma-border px-3 py-2"
    >
      <p className="text-label text-tagma-text break-words">{question}</p>
      <div className="mt-2 flex min-w-0 flex-col gap-1">
        {candidates.map((candidate) => (
          <button
            key={candidate.candidateId}
            type="button"
            disabled={pending}
            onClick={() => onChoose(candidate.candidateId)}
            className="min-w-0 border border-tagma-border px-2 py-1.5 text-left hover:bg-tagma-surface disabled:opacity-50"
          >
            <span className="block break-words text-label text-tagma-text">
              {candidate.name || candidate.relativeCoordinate.split('/').at(-1)}
            </span>
            <span className="block break-words text-caption font-mono text-tagma-muted">
              {candidate.relativeCoordinate}
            </span>
            <span className="block text-caption text-tagma-muted">
              {[
                candidate.currentCanvas && 'Current canvas',
                candidate.sessionOwned && 'This conversation',
                candidate.manualNewDraft && 'New draft',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-1 text-caption text-tagma-muted">
        {pending
          ? 'Sending selection…'
          : 'Choose a pipeline above, or clarify in the message below.'}
      </p>
    </section>
  );
}

function ClarificationSelection({
  operationId,
  requestId,
  question,
  candidates,
}: {
  operationId: string;
  requestId: string;
  question: string;
  candidates: readonly ChatOperationV2InventoryCandidate[];
}) {
  const choose = useChatStore((state) => state.chooseActiveChatOperationV2Candidate);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const select = async (candidateId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await choose(operationId, requestId, candidateId);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <ClarificationOptions
      question={question}
      candidates={candidates}
      pending={pending}
      onChoose={(id) => void select(id)}
    />
  );
}

export function ClarificationPanel() {
  const operation = useChatStore((state) => state.activeChatOperationV2);
  const pending = useChatStore((state) =>
    operation ? state.chatOperationV2ThreadDetails[operation.operationId]?.pendingInput : null,
  );
  if (
    operation?.executionState !== 'waiting_for_user' ||
    pending?.kind !== 'clarification' ||
    pending.candidates.length === 0
  )
    return null;
  return (
    <ClarificationSelection
      key={`${operation.operationId}:${pending.clarificationId}`}
      operationId={operation.operationId}
      requestId={pending.clarificationId}
      question={pending.question}
      candidates={pending.candidates}
    />
  );
}
