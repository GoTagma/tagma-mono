import type { ReactNode } from 'react';
import { Loader2, Package } from 'lucide-react';

/**
 * Shared layout tokens + primitives for the plugin cards in the Installed
 * and Marketplace tabs. Pulled out so both panels stay visually consistent:
 * same grid column width, same card shell, same chip styles, same action
 * button styles. Content differs — layout does not.
 *
 * Exported as Tailwind class strings (not raw pixel values) so the design
 * tokens stay inside the utility-first pipeline and remain JIT-extractable
 * at build time. Editing a token here restyles every plugin card.
 */

// ── Grid & shell ──
//
// `auto-rows-fr` makes every card within the same grid row stretch to the
// tallest sibling, so cards with shorter descriptions don't leave chip rows
// floating at different y-coordinates across a row of cards.
export const PLUGIN_CARD_GRID_CLASSES =
  'grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] auto-rows-fr gap-2';

export const PLUGIN_CARD_SHELL_CLASSES =
  'flex items-start gap-2 p-3 bg-tagma-surface/50 border border-tagma-border hover:border-tagma-accent/40 transition-colors min-h-[104px]';

// ── Chips ──
const CHIP_BASE = 'text-[9px] px-1 py-px border whitespace-nowrap';

export const CHIP_STYLES = {
  neutral: `${CHIP_BASE} bg-tagma-muted/10 text-tagma-muted border-tagma-muted/20`,
  success: `${CHIP_BASE} bg-green-500/10 text-green-400/80 border-green-500/20`,
  danger: `${CHIP_BASE} bg-tagma-error/10 text-tagma-error/80 border-tagma-error/20`,
  info: `${CHIP_BASE} bg-blue-500/10 text-blue-400/80 border-blue-500/20`,
  accent: `${CHIP_BASE} bg-purple-500/10 text-purple-400/80 border-purple-500/20`,
} as const;

export type ChipVariant = keyof typeof CHIP_STYLES;

interface ChipProps {
  variant: ChipVariant;
  children: ReactNode;
  title?: string;
  mono?: boolean;
}

export function Chip({ variant, children, title, mono }: ChipProps) {
  const classes = `${CHIP_STYLES[variant]}${mono ? ' font-mono' : ''}`;
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

/**
 * Lightweight meta chip (no background, just icon + text) used for things
 * like publish date or download count where a coloured pill would be too
 * loud next to the real status chips.
 */
export function MetaChip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      className="flex items-center gap-0.5 text-[9px] text-tagma-muted whitespace-nowrap"
      title={title}
    >
      {children}
    </span>
  );
}

// ── Action buttons ──
const ACTION_BUTTON_BASE =
  'inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap';

const ACTION_BUTTON_VARIANTS = {
  primary: 'bg-blue-500/20 text-blue-300 border-blue-500/30 hover:bg-blue-500/30',
  danger: 'bg-tagma-error/15 text-tagma-error border-tagma-error/30 hover:bg-tagma-error/25',
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
 * against that plugin. Matches the action-button box size so the card
 * layout doesn't jump when a click flips the UI into the "busy" state.
 */
export function BusyLabel({ label }: { label: string }) {
  return (
    <span className={`${ACTION_BUTTON_BASE} bg-transparent text-tagma-muted border-tagma-border`}>
      <Loader2 size={11} className="animate-spin" />
      <span>{label}</span>
    </span>
  );
}

// ── Card shell ──
interface PluginCardShellProps {
  /** Icon column. Defaults to the shared Package icon. */
  icon?: ReactNode;
  /** First row of the content column — usually name + version + inline meta. */
  header: ReactNode;
  /** Optional second row. Rendered in muted text with a 2-line clamp. */
  description?: string | null;
  /** Third row — status/category/meta chips. */
  chips: ReactNode;
  /** Right-hand column — one or more ActionButton / BusyLabel elements stacked vertically. */
  actions: ReactNode;
}

/**
 * Unified shell used by both Installed and Marketplace card components.
 * The three content slots (`header`, `description`, `chips`) and the
 * `actions` column give the callers freedom over *what* to render while
 * guaranteeing identical outer dimensions, padding, typography, and chip
 * alignment across tabs.
 *
 * `mt-auto` on the chip row pushes chips to the card's bottom edge so a
 * card with no description still bottom-aligns its chips with cards that
 * do have one, keeping the grid visually tidy.
 */
export function PluginCardShell({
  icon,
  header,
  description,
  chips,
  actions,
}: PluginCardShellProps) {
  return (
    <div className={PLUGIN_CARD_SHELL_CLASSES}>
      <span className="shrink-0 mt-0.5 text-tagma-muted">
        {icon ?? <Package size={14} />}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {header}
        </div>
        {description && (
          <p className="text-[10px] text-tagma-muted line-clamp-2">
            {description}
          </p>
        )}
        <div className="flex items-center gap-1 flex-wrap mt-auto pt-1">
          {chips}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1">
        {actions}
      </div>
    </div>
  );
}
