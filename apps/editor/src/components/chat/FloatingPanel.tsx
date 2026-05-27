import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getZoom, viewportW, viewportH } from '../../utils/zoom';

/**
 * Floating menu anchored to a trigger. Rendered via a portal into document.body
 * and positioned with `position: fixed`, so it escapes any scroll-clipped or
 * overflow-hidden ancestor — the chat panel's message list and the right
 * dock both clip, which was chopping the bottom off the dropdowns before.
 *
 * Auto-flips vertically when there isn't enough room below the trigger, and
 * shifts horizontally to stay inside the viewport. Closes on outside click,
 * on scroll/resize, AND when the anchor moves mid-open (e.g. the user drags
 * the right-dock resize handle while the picker is open — without this the
 * dropdown floats at its original viewport coords while the trigger slides
 * out from under it).
 *
 * The root is a `flex flex-col` with NO overflow — callers split their
 * content into sticky-height sections (header, scrollable body, footer) so
 * the scrollbar starts where it should, not at the very top of the panel.
 */
export function FloatingPanel({
  anchor,
  open,
  onClose,
  width,
  maxHeight = 320,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  width: number;
  maxHeight?: number;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const compute = () => {
      // CSS `zoom` on <html> (browser-mode ZoomControls) makes
      // getBoundingClientRect return screen-pixel coords while
      // `position: fixed` expects logical (pre-zoom) coords. Without
      // the divide-by-z the panel was offset proportionally to zoom —
      // visible at any zoom != 100%, exact at 100%.
      const z = getZoom();
      const r = anchor.getBoundingClientRect();
      const rLeft = r.left / z;
      const rTop = r.top / z;
      const rBottom = r.bottom / z;
      const vw = viewportW();
      const vh = viewportH();
      const margin = 6;
      let left = rLeft;
      if (left + width > vw - margin) left = vw - width - margin;
      if (left < margin) left = margin;
      const below = vh - rBottom - margin;
      const above = rTop - margin;
      // Prefer below unless there isn't room for a reasonable panel and above
      // has more space. 200px is "useful enough" — above that we stop flipping.
      const preferBelow = below >= Math.min(maxHeight, 200) || below >= above;
      let top: number;
      let mh: number;
      if (preferBelow) {
        top = rBottom + 4;
        mh = Math.min(maxHeight, below);
      } else {
        mh = Math.min(maxHeight, above);
        top = rTop - mh - 4;
      }
      setPos({ left, top, maxHeight: mh });
    };
    compute();
    // Reposition on resize AND on any scroll (capture, since inner scrolls
    // don't bubble). Scrolling a neighbouring container — e.g. the chat
    // message list while the picker is open — shouldn't dismiss the menu;
    // `getBoundingClientRect` gives viewport-relative coords so a fresh
    // compute() keeps the panel glued to the trigger as it moves.
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, anchor, width, maxHeight]);

  // Close-on-anchor-move: dragging the right-dock resize handle slides the
  // trigger button sideways without firing window `resize` or `scroll`,
  // so the existing recompute listeners don't see it and the panel floats
  // at its stale fixed coordinates. rAF-poll the anchor's rect — close the
  // panel the moment it moves rather than trying to follow a drag in real
  // time, which is what the user asked for ("should just hide while I drag").
  // Cheap: getBoundingClientRect is a few µs per frame, and only runs while
  // the panel is open.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    let prev = anchor.getBoundingClientRect();
    let raf = 0;
    const tick = () => {
      const cur = anchor.getBoundingClientRect();
      if (
        Math.abs(cur.left - prev.left) > 0.5 ||
        Math.abs(cur.top - prev.top) > 0.5 ||
        Math.abs(cur.width - prev.width) > 0.5
      ) {
        onCloseRef.current();
        return;
      }
      prev = cur;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    // Read onClose through a ref so we don't rebind these listeners on every
    // parent render. If the parent passes a fresh `() => setOpen(false)` each
    // render, re-binding can drop a mousedown that fires between the old
    // removeEventListener and the new addEventListener — which manifested as
    // "clicking a model item does nothing" because the outside-click detector
    // was briefly absent while the user was mid-click inside the panel.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchor]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width,
        maxHeight: pos.maxHeight,
      }}
      className="flex flex-col bg-tagma-bg border border-tagma-border shadow-lg z-[100] overflow-hidden"
    >
      {children}
    </div>,
    document.body,
  );
}
