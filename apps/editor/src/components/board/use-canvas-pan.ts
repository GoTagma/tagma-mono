import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { getZoom } from '../../utils/zoom';
import { resolveCanvasPan } from './canvas-pan';

export function useCanvasPan(contentRef: RefObject<HTMLDivElement | null>) {
  const didDragRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const element = contentRef.current;
      if (!element) return;

      cleanupRef.current?.();
      const start = {
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      };
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      let started = false;
      let cleaned = false;
      didDragRef.current = false;

      const onMove = (moveEvent: MouseEvent) => {
        const next = resolveCanvasPan(start, moveEvent, getZoom(), started);
        if (!started) {
          if (!next.didDrag) return;
          started = true;
          didDragRef.current = true;
        }
        element.scrollLeft = next.scrollLeft;
        element.scrollTop = next.scrollTop;
      };

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', cleanup);
        window.removeEventListener('blur', cleanup);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
      };

      cleanupRef.current = cleanup;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', cleanup);
      window.addEventListener('blur', cleanup);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    },
    [contentRef],
  );

  return { didDragRef, handleMouseDown };
}
