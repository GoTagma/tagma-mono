import type { ReactNode } from 'react';
import { Loader2, Package } from 'lucide-react';
import type { PluginCategory } from '../../api/client';

/**
 * Shared layout tokens + primitives for the plugin cards in the Installed
 * and Marketplace tabs. Pulled out so both panels stay visually consistent:
 * same grid column width, same card shell, same status / meta / action
 * treatments. Content differs — layout does not.
 *
 * The shell is modeled as a small editorial catalog entry: a category
 * glyph on the left, a typographic stack in the middle (name, type,
 * description, meta ticker), and a status-plus-action column on the right.
 * Exported as Tailwind class strings (not raw pixel values) so the design
 * tokens stay inside the utility-first pipeline and remain JIT-extractable
 * at build time. Editing a token here restyles every plugin card.
 */

// ── Grid ──
//
// Wider min column (440px) with a larger row gap turns the previously
// dense list of strips into a breathable two-column catalog on typical
// editor widths, while still collapsing gracefully to one column on
// narrower panels. `auto-rows-fr` keeps siblings at matched heights so
// meta rows and action buttons line up across a row.
export const PLUGIN_CARD_GRID_CLASSES =
  'grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] auto-rows-fr gap-3';

// ── Category glyph ──
//
// The big letter block in the upper-left of each card. Each of the four
// known categories has its own theme-accent color, so a row of cards
// communicates "what kind of thing is this" at a glance without forcing
// the user to read a chip. Unknown / missing categories fall back to a
// generic Package icon in muted neutral.
const CATEGORY_STYLES: Record<
  PluginCategory,
  { letter: string; text: string; bg: string; border: string }
> = {
  drivers: {
    letter: 'D',
    text: 'text-tagma-accent',
    bg: 'bg-tagma-accent/10',
    border: 'border-tagma-accent/40',
  },
  triggers: {
    letter: 'T',
    text: 'text-tagma-warning',
    bg: 'bg-tagma-warning/10',
    border: 'border-tagma-warning/40',
  },
  completions: {
    letter: 'C',
    text: 'text-tagma-success',
    bg: 'bg-tagma-success/10',
    border: 'border-tagma-success/40',
  },
  middlewares: {
    letter: 'M',
    text: 'text-tagma-info',
    bg: 'bg-tagma-info/10',
    border: 'border-tagma-info/40',
  },
};

export function CategoryGlyph({ category }: { category: PluginCategory | null }) {
  if (!category) {
    return (
      <div className="w-11 h-11 flex items-center justify-center border border-tagma-border bg-tagma-bg/60 text-tagma-muted-dim">
        <Package size={18} strokeWidth={1.75} />
      </div>
    );
  }
  const s = CATEGORY_STYLES[category];
  return (
    <div
      className={`w-11 h-11 flex items-center justify-center border ${s.bg} ${s.border} ${s.text} font-sans text-[20px] font-semibold tracking-tight leading-none`}
      title={category}
    >
      {s.letter}
    </div>
  );
}

// ── Status badges ──
//
// Replaces the old rainbow-chip system with a small, intentional set of
// four flat badges. Each uses a single colored square dot + uppercase
// micro-label so a stack of 2–3 badges reads as a glyphic "status column"
// at the card's top-right rather than a noisy pill garden.
type StatusVariant = 'installed' | 'missing' | 'loaded' | 'declared';

const STATUS_STYLES: Record<StatusVariant, { dot: string; text: string; label: string }> = {
  installed: { dot: 'bg-tagma-success', text: 'text-tagma-success', label: 'Installed' },
  missing:   { dot: 'bg-tagma-error',   text: 'text-tagma-error',   label: 'Missing' },
  loaded:    { dot: 'bg-tagma-ready',   text: 'text-tagma-ready',   label: 'Loaded' },
  declared:  { dot: 'bg-tagma-accent',  text: 'text-tagma-accent',  label: 'Declared' },
};

export function StatusBadge({ variant }: { variant: StatusVariant }) {
  const s = STATUS_STYLES[variant];
  return (
    <span className="flex items-center gap-1.5 text-[9px] tracking-[0.14em] uppercase font-medium whitespace-nowrap">
      <span className={`w-1.5 h-1.5 ${s.dot}`} />
      <span className={s.text}>{s.label}</span>
    </span>
  );
}

// ── Meta items ──
//
// Inline text + icon used for context pairs like "2.5k/wk" or "Apr 14".
// No background, sits on a single line at the bottom of the card.
// `MetaBullet` is a tiny separator for callers that want to inline
// multiple meta items without spawning container divs.
export function MetaItem({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="flex items-center gap-1 text-[10px] text-tagma-muted-dim whitespace-nowrap"
      title={title}
    >
      {children}
    </span>
  );
}

export function MetaBullet() {
  return (
    <span className="text-[8px] text-tagma-border leading-none" aria-hidden="true">
      •
    </span>
  );
}

// ── Action buttons ──
//
// Primary action now uses the theme's copper accent with a full-bleed
// hover fill, making it the unambiguous CTA on every card. The button
// grew from 10px text / ~4px vertical padding to 11px / 6px to feel
// like a real call-to-action instead of an afterthought buried in the
// corner of a thin strip.
const ACTION_BUTTON_BASE =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium tracking-wide border transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap';

const ACTION_BUTTON_VARIANTS = {
  primary:
    'bg-tagma-accent/10 text-tagma-accent border-tagma-accent/40 hover:bg-tagma-accent hover:text-white hover:border-tagma-accent',
  danger:
    'bg-transparent text-tagma-error border-tagma-error/30 hover:bg-tagma-error/15 hover:border-tagma-error/60',
} as const;

export type ActionButtonVariant = keyof typeof ACTION_BUTTON_VARIANTS;

interface ActionButtonProps {
  variant: ActionButtonVariant;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

export function ActionButton({
  variant,
  icon,
  label,
  onClick,
  disabled,
  title,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${ACTION_BUTTON_BASE} ${ACTION_BUTTON_VARIANTS[variant]}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * In-place replacement for an action button when an operation is running
 * against that plugin. Sized identically so the card does not reflow as
 * the UI flips between idle and busy.
 */
export function BusyLabel({ label }: { label: string }) {
  return (
    <span className={`${ACTION_BUTTON_BASE} bg-transparent text-tagma-muted border-tagma-border`}>
      <Loader2 size={12} className="animate-spin" />
      <span>{label}</span>
    </span>
  );
}

// ── Card shell ──

interface PluginCardShellProps {
  /** Resolved primary category. `null` renders a generic fallback glyph. */
  category: PluginCategory | null;
  name: string;
  version?: string | null;
  /** Optional mono subtitle shown in accent color under the name. */
  typeLabel?: string | null;
  description?: string | null;
  /**
   * Draws a copper accent rail down the card's left edge, signalling that
   * this plugin is part of the pipeline manifest. Used for cards flagged
   * as "declared" so they stand out from the background noise.
   */
  accent?: boolean;
  /** Top-right column — usually a <StatusBadge /> stack. */
  statuses?: ReactNode;
  /** Bottom-left meta ticker — usually MetaItems separated by <MetaBullet />. */
  meta?: ReactNode;
  /** Bottom-right CTA area — one or more <ActionButton /> / <BusyLabel /> elements. */
  actions: ReactNode;
}

/**
 * Unified editorial card shell used by both the Installed and Marketplace
 * panels. Layout:
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │▌[G]  name                 v0.3.1            • Installed   │
 *   │▌     type-label                              • Loaded     │
 *   │▌     description line 1                                    │
 *   │▌     description line 2                                    │
 *   │▌                                                           │
 *   │▌     2.5k/wk · Apr 14 · @tagma          [ Uninstall ]      │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   - Left (44x44): category glyph (D/T/C/M in that category's theme
 *     color, or a fallback Package icon).
 *   - Center: typographic stack — name (13px semibold), type subtitle
 *     (10px mono accent), 2-line description, and an optional meta
 *     ticker pinned to the bottom of the column.
 *   - Right: up to three status badges at the top, primary CTA at the
 *     bottom. `justify-between` on the column keeps the two edges
 *     locked regardless of card height.
 *   - A copper accent rail (▌) is drawn down the left edge when
 *     `accent` is true — used for cards that are declared in the
 *     pipeline manifest, so the user can spot their current pipeline
 *     at a glance in a long list.
 */
export function PluginCardShell({
  category,
  name,
  version,
  typeLabel,
  description,
  accent,
  statuses,
  meta,
  actions,
}: PluginCardShellProps) {
  return (
    <div className="group relative flex gap-4 p-5 bg-tagma-surface/40 border border-tagma-border hover:bg-tagma-surface/70 hover:border-tagma-accent/40 transition-all duration-200 min-h-[148px]">
      {accent && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-tagma-accent"
          aria-hidden="true"
        />
      )}

      <div className="shrink-0">
        <CategoryGlyph category={category} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="text-[13px] font-semibold text-tagma-text truncate tracking-tight leading-tight">
            {name}
          </h3>
          {version && (
            <span className="shrink-0 text-[10px] font-mono text-tagma-muted-dim leading-tight">
              v{version}
            </span>
          )}
        </div>

        {typeLabel && (
          <div className="mt-0.5 text-[10px] font-mono text-tagma-accent/80 tracking-wide truncate">
            {typeLabel}
          </div>
        )}

        {description && (
          <p className="mt-2 text-[11px] text-tagma-muted leading-[1.55] line-clamp-2">
            {description}
          </p>
        )}

        {meta && (
          <div className="mt-auto pt-3 flex items-center gap-1.5 flex-wrap">
            {meta}
          </div>
        )}
      </div>

      <div className="shrink-0 flex flex-col items-end justify-between gap-3">
        {statuses ? (
          <div className="flex flex-col items-end gap-1">{statuses}</div>
        ) : (
          <span aria-hidden="true" />
        )}
        <div>{actions}</div>
      </div>
    </div>
  );
}
