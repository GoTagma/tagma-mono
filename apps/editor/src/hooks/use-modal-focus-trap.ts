import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleAndEnabled(element: HTMLElement): boolean {
  if (element.matches(':disabled') || element.getAttribute('aria-hidden') === 'true') return false;
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

const modalStack: HTMLElement[] = [];

export function useModalFocusTrap<T extends HTMLElement>(enabled = true, onEscape?: () => void) {
  const ref = useRef<T>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return;
    modalStack.push(root);
    const isTopModal = () => modalStack.at(-1) === root;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(visibleAndEnabled);
    const focusInitial = window.setTimeout(() => {
      if (!isTopModal() || root.contains(document.activeElement)) return;
      (getFocusable()[0] ?? root).focus({ preventScroll: true });
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal() || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey
          ? active === first || !root.contains(active)
          : active === last || !root.contains(active)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.clearTimeout(focusInitial);
      document.removeEventListener('keydown', onKeyDown, true);
      const index = modalStack.lastIndexOf(root);
      if (index !== -1) modalStack.splice(index, 1);
      if (previousFocus && document.contains(previousFocus))
        previousFocus.focus({ preventScroll: true });
    };
  }, [enabled]);
  return ref;
}
