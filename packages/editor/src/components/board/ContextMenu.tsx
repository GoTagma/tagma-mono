import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { getZoom, viewportW, viewportH } from '../../utils/zoom';

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onAction: () => void;
}

export interface MenuSeparator {
  separator: true;
}

export interface SubMenuItem {
  label: string;
  icon?: React.ReactNode;
  submenu: SubmenuConfig;
}

export interface SubmenuConfig {
  searchable?: boolean;
  searchPlaceholder?: string;
  items: MenuEntry[];
  maxHeight?: number;
}

export type MenuEntry = MenuItem | MenuSeparator | SubMenuItem;

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry;
}

function isSubmenu(entry: MenuEntry): entry is SubMenuItem {
  return 'submenu' in entry;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}

function SubmenuPanel({ config, onClose, parentRect }: {
  config: SubmenuConfig;
  onClose: () => void;
  parentRect: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (config.searchable && inputRef.current) inputRef.current.focus();
  }, [config.searchable]);

  // Position: to the right of the parent menu, clamped to viewport
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const z = getZoom();
    const vw = viewportW();
    const vh = viewportH();
    // parentRect is in screen coords; convert to logical for fixed positioning
    const pRight = parentRect.right / z;
    const pLeft = parentRect.left / z;
    const pTop = parentRect.top / z;
    const rW = rect.width / z;
    const rH = rect.height / z;
    // Horizontal: prefer right, fall back to left
    if (pRight + rW > vw) {
      el.style.left = `${pLeft - rW}px`;
    } else {
      el.style.left = `${pRight}px`;
    }
    el.style.top = `${pTop}px`;
    // Vertical: clamp bottom
    if (pTop + rH > vh) {
      el.style.top = `${Math.max(4, vh - rH - 4)}px`;
    }
  }, [parentRect]);

  const filtered = config.items.filter((entry) => {
    if (!query) return true;
    if (isSeparator(entry)) return false;
    if (isSubmenu(entry)) return entry.label.toLowerCase().includes(query.toLowerCase());
    return entry.label.toLowerCase().includes(query.toLowerCase());
  });

  const maxH = config.maxHeight ?? 280;

  return (
    <div
      ref={ref}
      className="fixed z-[101] bg-tagma-surface border border-tagma-border shadow-panel py-1 min-w-[180px] animate-fade-in"
      style={{ left: parentRect.right / getZoom(), top: parentRect.top / getZoom() }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {config.searchable && (
        <div className="px-2 pb-1.5 pt-1">
          <div className="flex items-center gap-1.5 border border-tagma-border/60 bg-tagma-bg px-2 py-1">
            <Search size={10} className="text-tagma-muted shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={config.searchPlaceholder ?? 'Search...'}
              className="bg-transparent text-[11px] text-tagma-text placeholder:text-tagma-muted/50 outline-none border-none shadow-none w-full"
              style={{ boxShadow: 'none', borderColor: 'transparent' }}
            />
          </div>
        </div>
      )}
      <div className="overflow-y-auto" style={{ maxHeight: maxH }}>
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-tagma-muted text-center">No matches</div>
        )}
        {filtered.map((entry, i) => {
          if (isSeparator(entry)) {
            return <div key={`sep-${i}`} className="my-1 border-t border-tagma-border/40" />;
          }
          if (isSubmenu(entry)) return null; // nested submenus not supported
          return (
            <button
              key={i}
              disabled={entry.disabled}
              onClick={() => { entry.onAction(); onClose(); }}
              className={`
                w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors
                disabled:opacity-30 disabled:cursor-not-allowed
                ${entry.danger
                  ? 'text-tagma-error hover:bg-tagma-error/10'
                  : 'text-tagma-text hover:bg-tagma-elevated'}
              `}
            >
              {entry.icon && <span className="w-4 flex items-center justify-center shrink-0">{entry.icon}</span>}
              <span className="flex-1 truncate">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubmenuTrigger({ entry, isOpen, onMouseEnter, onMouseLeave, onClick, onSubmenuPanelEnter, onClose }: {
  entry: SubMenuItem;
  isOpen: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  onSubmenuPanelEnter: () => void;
  onClose: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={btnRef}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors text-tagma-text hover:bg-tagma-elevated"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      >
        {entry.icon && <span className="w-4 flex items-center justify-center shrink-0">{entry.icon}</span>}
        <span className="flex-1">{entry.label}</span>
        <ChevronRight size={10} className="text-tagma-muted shrink-0" />
      </button>
      {isOpen && btnRef.current && (
        <div
          data-submenu-panel
          onMouseEnter={onSubmenuPanelEnter}
          onMouseLeave={onMouseLeave}
        >
          <SubmenuPanel
            config={entry.submenu}
            onClose={onClose}
            parentRect={btnRef.current.getBoundingClientRect()}
          />
        </div>
      )}
    </div>
  );
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Delay registration so the opening right-click doesn't immediately close the menu
    let frameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(() => {
        // Listen to both mousedown and pointerdown to handle cases where
        // preventDefault() on pointerdown blocks mousedown (e.g., TaskCard sliding)
        document.addEventListener('mousedown', handleOutside, true);
        document.addEventListener('pointerdown', handleOutsidePointer, true);
        document.addEventListener('contextmenu', handleOutside, true);
      });
    });

    function isInsideMenu(target: Node) {
      if (ref.current && ref.current.contains(target)) return true;
      // Check all submenu panels (fixed-position children may be outside ref)
      const panels = document.querySelectorAll('[data-submenu-panel]');
      for (const panel of panels) {
        if (panel.contains(target)) return true;
      }
      return false;
    }

    function handleOutside(e: MouseEvent) {
      if (!isInsideMenu(e.target as Node)) onClose();
    }

    function handleOutsidePointer(e: PointerEvent) {
      if (!isInsideMenu(e.target as Node)) onClose();
    }

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Close on any wheel/scroll interaction outside the menu
    const wheelHandler = (e: WheelEvent) => {
      if (e.target instanceof Node && isInsideMenu(e.target)) return;
      onClose();
    };

    const scrollHandler = (e: Event) => {
      // Ignore scroll events from inside the menu or submenu (e.g. scrollbar drag)
      if (e.target instanceof Node && isInsideMenu(e.target)) return;
      onClose();
    };

    // Close on drag operations starting outside the menu
    const dragHandler = (e: DragEvent) => {
      if (e.target instanceof Node && isInsideMenu(e.target)) return;
      onClose();
    };

    document.addEventListener('keydown', escHandler);
    document.addEventListener('wheel', wheelHandler, true);
    document.addEventListener('scroll', scrollHandler, true);
    document.addEventListener('dragstart', dragHandler, true);
    window.addEventListener('resize', onClose);

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener('mousedown', handleOutside, true);
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
      document.removeEventListener('contextmenu', handleOutside, true);
      document.removeEventListener('keydown', escHandler);
      document.removeEventListener('wheel', wheelHandler, true);
      document.removeEventListener('scroll', scrollHandler, true);
      document.removeEventListener('dragstart', dragHandler, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Clamp to viewport (x,y are screen coords from clientX/clientY)
  const logicalX = x / getZoom();
  const logicalY = y / getZoom();
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const z = getZoom();
    const vw = viewportW();
    const vh = viewportH();
    const rW = rect.width / z;
    const rH = rect.height / z;
    if (logicalX + rW > vw) {
      el.style.left = `${logicalX - rW}px`;
    }
    if (logicalY + rH > vh) {
      el.style.top = `${logicalY - rH}px`;
    }
  }, [logicalX, logicalY]);

  const handleSubmenuEnter = useCallback((index: number) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpenSubmenu(index), 120);
  }, []);

  const handleSubmenuLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpenSubmenu(null), 200);
  }, []);

  const handleSubmenuPanelEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  useEffect(() => {
    return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); };
  }, []);

  return (
    <div
      ref={ref}
      className="fixed z-[100] bg-tagma-surface border border-tagma-border shadow-panel py-1 min-w-[160px] animate-fade-in"
      style={{ left: logicalX, top: logicalY }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (isSeparator(entry)) {
          return <div key={`sep-${i}`} className="my-1 border-t border-tagma-border/40" />;
        }

        if (isSubmenu(entry)) {
          const isOpen = openSubmenu === i;
          return (
            <SubmenuTrigger
              key={i}
              entry={entry}
              isOpen={isOpen}
              onMouseEnter={() => handleSubmenuEnter(i)}
              onMouseLeave={handleSubmenuLeave}
              onClick={() => setOpenSubmenu(isOpen ? null : i)}
              onSubmenuPanelEnter={handleSubmenuPanelEnter}
              onClose={onClose}
            />
          );
        }

        return (
          <button
            key={i}
            disabled={entry.disabled}
            onClick={() => { entry.onAction(); onClose(); }}
            className={`
              w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors
              disabled:opacity-30 disabled:cursor-not-allowed
              ${entry.danger
                ? 'text-tagma-error hover:bg-tagma-error/10'
                : 'text-tagma-text hover:bg-tagma-elevated'}
            `}
          >
            {entry.icon && <span className="w-4 flex items-center justify-center shrink-0">{entry.icon}</span>}
            <span>{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
