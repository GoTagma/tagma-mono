/**
 * Inline "modified" chip rendered next to a field label when its current
 * value differs from the saved-on-disk baseline. Visual style intentionally
 * matches the pipeline-level MODIFIED indicator in `Toolbar.tsx` so the
 * affordance reads as the same concept at every scale (whole pipeline →
 * track → task → individual field).
 *
 * Renders nothing when `visible` is false to keep call sites declarative —
 * inspectors can place the badge unconditionally in the layout and the
 * component handles its own visibility.
 */
export function ModifiedBadge({
  visible,
  label = 'modified',
  title,
}: {
  visible: boolean;
  /** Override the displayed text. Defaults to "modified" to mirror the toolbar. */
  label?: string;
  /** Optional tooltip — useful on the canvas where space is tight. */
  title?: string;
}) {
  if (!visible) return null;
  return (
    <span
      title={title ?? 'Unsaved change since last save'}
      className="inline-block text-[9px] font-medium tracking-wider uppercase text-tagma-warning/80 bg-tagma-warning/8 px-1.5 ml-1.5 align-middle leading-3"
    >
      {label}
    </span>
  );
}
