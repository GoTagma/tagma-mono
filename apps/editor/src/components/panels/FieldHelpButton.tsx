import { HelpCircle } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useChatStore } from '../../store/chat-store';

interface FieldHelpButtonProps {
  /** Plain-language name of the field, e.g. "Driver" or "path". */
  field: string;
  /**
   * Where this field lives. Free-form scope phrase that completes the
   * sentence "...field on a Tagma {scope} do?". Examples: "task",
   * "track", "pipeline", "`file` trigger plugin",
   * "`exit_code` completion plugin".
   */
  scope: string;
  /** Optional extra hint appended verbatim to the question. */
  extra?: string;
  /** Tailwind classes for layout tweaks (e.g. margin). */
  className?: string;
}

/**
 * Small "?" trigger used next to inspector field labels. Clicking prefills
 * the chat composer with a question targeting the named field and opens the
 * chat tab — the user reviews/edits before hitting send (no auto-send).
 *
 * Rendered as a `<span role="button">` rather than a real `<button>` so it
 * is NOT a labelable control. When this lives inside a `<label>`, clicking
 * the label text would otherwise activate the first labelable descendant
 * and synthesize a click here, making the whole row open the chat.
 */
export function FieldHelpButton({ field, scope, extra, className }: FieldHelpButtonProps) {
  const ask = () => {
    const trailing = extra ? ` ${extra}` : '';
    const question = `What does the \`${field}\` field on a Tagma ${scope} do?${trailing}`;
    useChatStore.getState().prefillComposerForError(question);
  };
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    ask();
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      ask();
    }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`shrink-0 inline-flex items-center align-middle text-tagma-muted/50 hover:text-tagma-accent transition-colors cursor-pointer ${className ?? 'ml-1'}`}
      title="Ask AI about this field"
      aria-label={`Ask AI about ${field}`}
    >
      <HelpCircle size={11} />
    </span>
  );
}
