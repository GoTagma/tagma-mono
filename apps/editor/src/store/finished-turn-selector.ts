import type { ChatFinishedTurn } from './chat-store';

export interface FinishedTurnQueueState {
  finishedTurnQueue: ChatFinishedTurn[];
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
