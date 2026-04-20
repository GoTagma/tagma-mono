import { useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { Trash2 } from 'lucide-react';

export interface DropdownAction {
  label: string;
  subLabel?: string;
  shortcut?: string;
  disabled?: boolean;
  onAction: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
}

export interface DropdownSep {
  separator: true;
}

export type DropdownItem = DropdownAction | DropdownSep;

function isSep(item: DropdownItem): item is DropdownSep {
  return 'separator' in item;
}

interface DropdownMenuProps {
  items: DropdownItem[];
  onClose: () => void;
  anchorClassName?: string;
  anchorStyle?: CSSProperties;
}

export function DropdownMenu({ items, onClose, anchorClassName, anchorStyle }: DropdownMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  const isInside = useCallback((target: Node) => {
    return ref.current !== null && ref.current.contains(target);
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!isInside(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Close when scrolling OUTSIDE this menu; scrolling inside is allowed.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && isInside(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, isInside]);

  return (
    <div
      ref={ref}
      className={`${anchorClassName ?? ''} bg-tagma-surface border border-tagma-border/80 shadow-xl py-1 min-w-[240px] max-w-[360px] overflow-y-auto animate-fade-in`}
      style={{
        maxHeight: 'min(560px, calc(100vh - 64px))',
        overscrollBehavior: 'contain',
        ...anchorStyle,
      }}
    >
      {items.map((item, ii) => {
        if (isSep(item)) {
          return <div key={`sep-${ii}`} className="my-1 border-t border-tagma-border/30" />;
        }
        return (
          <div
            key={ii}
            className={`group w-full flex items-center justify-between pr-1 text-[11px] text-left transition-colors ${item.disabled ? 'text-tagma-muted/45 cursor-not-allowed' : 'text-tagma-text hover:bg-tagma-accent/10 hover:text-tagma-accent'}`}
          >
            <button
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) {
                  item.onAction();
                  onClose();
                }
              }}
              className="flex-1 min-w-0 flex items-center justify-between px-3 py-1.5 text-left text-inherit disabled:cursor-not-allowed disabled:text-inherit"
            >
              <span className="flex flex-col min-w-0 items-start">
                <span className="truncate max-w-full">{item.label}</span>
                {item.subLabel && (
                  <span
                    className={`text-[9px] truncate max-w-full leading-tight ${item.disabled ? 'text-inherit' : 'text-tagma-muted/60'}`}
                  >
                    {item.subLabel}
                  </span>
                )}
              </span>
              {item.shortcut && (
                <span
                  className={`text-[9px] font-mono ml-6 tracking-wider ${item.disabled ? 'text-inherit' : 'text-tagma-muted/60'}`}
                >
                  {item.shortcut}
                </span>
              )}
            </button>
            {item.onDelete && !item.disabled && (
              <button
                type="button"
                title={item.deleteTitle ?? 'Remove'}
                onClick={(e) => {
                  e.stopPropagation();
                  item.onDelete?.();
                  onClose();
                }}
                className="ml-1 p-1 text-tagma-muted/60 hover:text-tagma-error opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
