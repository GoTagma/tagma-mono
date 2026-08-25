import type { ChatFinishedTurn } from './chat-store';

export interface FinishedTurnQueueState {
  finishedTurnQueue: ChatFinishedTurn[];
  activeChatYamlLifecycle?: { turnId: string } | null;
}

export interface CurrentSessionFinishedTurnQueueState extends FinishedTurnQueueState {
  currentSessionId: string | null;
}

/**
 * Select only the queue head so appending later turns does not restart the
 * reconciliation already processing the current turn.
 */
export function selectFinishedTurnQueueHead(
  state: FinishedTurnQueueState,
): ChatFinishedTurn | undefined {
  return state.finishedTurnQueue[0];
}

/**
 * A preserved failure belongs to its own stage and must not create global
 * head-of-line blocking. Reconciliation remains bounded/serial, but advances
 * to the next healthy independent turn while failed stages await recovery.
 */
export function selectNextReconcilableFinishedTurn(
  state: FinishedTurnQueueState,
): ChatFinishedTurn | undefined {
  if (state.activeChatYamlLifecycle) {
    return state.finishedTurnQueue.find(
      (turn) => turn.id === state.activeChatYamlLifecycle!.turnId,
    );
  }
  return state.finishedTurnQueue.find((turn) => !turn.reconcileFailure);
}

export function selectCurrentSessionFailedTurn(
  state: CurrentSessionFinishedTurnQueueState,
): ChatFinishedTurn | undefined {
  return state.finishedTurnQueue.find(
    (turn) => turn.sessionId === state.currentSessionId && !!turn.reconcileFailure,
  );
}
