import { useState, useRef, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { DropdownMenu, type DropdownItem } from './DropdownMenu';

interface MenuDef {
  label: string;
  items: DropdownItem[];
}

interface MenuBarProps {
  menus: MenuDef[];
}

export function MenuBar({ menus }: MenuBarProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpenIdx(null), []);

  return (
    <div ref={barRef} className="flex items-center relative z-[100] h-full">
      {menus.map((menu, mi) => (
        <div key={mi} className="relative h-full flex items-center">
          <button
            className={`h-full px-2.5 text-[11px] tracking-wide transition-colors flex items-center gap-1 ${openIdx === mi ? 'bg-tagma-elevated text-tagma-text' : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-elevated/40'}`}
            onClick={() => setOpenIdx(openIdx === mi ? null : mi)}
            onMouseEnter={() => {
              if (openIdx !== null) setOpenIdx(mi);
            }}
          >
            {menu.label}
            <ChevronDown size={8} className="opacity-40" />
          </button>

          {openIdx === mi && (
            <DropdownMenu
              items={menu.items}
              onClose={close}
              anchorClassName="absolute left-0 top-full z-[101]"
            />
          )}
        </div>
      ))}
    </div>
  );
}
