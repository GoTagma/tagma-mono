import { useRef } from 'react';
import type { MouseEventHandler, PointerEventHandler } from 'react';

export interface ModalBackdropPointerSequence {
  startedOnBackdrop: boolean;
  endedOnBackdrop: boolean;
}

/**
 * A backdrop click dismisses a modal only when the pointer interaction started
 * and ended on the backdrop. Browsers can synthesize a click on the backdrop
 * when a text-selection drag starts inside the dialog and is released outside.
 */
export function shouldDismissModalFromBackdropClick(
  sequence: ModalBackdropPointerSequence | null,
  clickLandedOnBackdrop: boolean,
): boolean {
  return (
    sequence !== null &&
    sequence.startedOnBackdrop &&
    sequence.endedOnBackdrop &&
    clickLandedOnBackdrop
  );
}

export interface ModalBackdropDismissHandlers {
  onPointerDownCapture: PointerEventHandler<HTMLDivElement>;
  onPointerUpCapture: PointerEventHandler<HTMLDivElement>;
  onPointerCancelCapture: PointerEventHandler<HTMLDivElement>;
  onClick: MouseEventHandler<HTMLDivElement>;
}

export function useModalBackdropDismiss(onDismiss: () => void): ModalBackdropDismissHandlers {
  const sequenceRef = useRef<ModalBackdropPointerSequence | null>(null);

  return {
    onPointerDownCapture(event) {
      sequenceRef.current = {
        startedOnBackdrop: event.target === event.currentTarget,
        endedOnBackdrop: false,
      };
    },
    onPointerUpCapture(event) {
      const sequence = sequenceRef.current;
      if (!sequence) return;
      sequenceRef.current = {
        ...sequence,
        endedOnBackdrop: event.target === event.currentTarget,
      };
    },
    onPointerCancelCapture() {
      sequenceRef.current = null;
    },
    onClick(event) {
      const shouldDismiss = shouldDismissModalFromBackdropClick(
        sequenceRef.current,
        event.target === event.currentTarget,
      );
      sequenceRef.current = null;
      if (shouldDismiss) onDismiss();
    },
  };
}
