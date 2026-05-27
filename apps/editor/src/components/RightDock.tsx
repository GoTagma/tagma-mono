import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Code, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings2, X } from 'lucide-react';

/**
 * Unified right-side dock. Composes three slots:
 *   - A horizontal tab strip ("attached" tabs) in the dock column — users can
 *     stack multiple tabs here and switch between them in-place.
 *   - A single optional "detached" column to the LEFT of the dock, for the
 *     one tab a user has pulled out into a side-by-side view.
 *   - An always-visible vertical activity rail on the far right, which is the
 *     sole launcher now that the toolbar no longer carries Chat / YAML
 *     buttons.
 *
 * Invariants the reducer maintains:
 *   - `detachedTab` never appears in `attached` (a tab is either detached OR
 *     docked, never both).
 *   - `activeTab` is either null or a member of `attached`.
 *   - When `attached` becomes non-empty and `activeTab` is null (or stale),
 *     the last tab in the list becomes active.
 */

export type RightTab = 'inspector' | 'yaml' | 'chat';

const ALL_TABS: RightTab[] = ['inspector', 'yaml', 'chat'];
const TAB_WIDTH_MIN = 360;
const TAB_WIDTH_DEFAULT = 360;
const TAB_WIDTH_MAX = 720;
const LAYOUT_KEY = 'tagma.right-dock.v2';
const WIDTH_KEY = 'tagma.right-dock.widths.v1';
const DRAG_MIME = 'application/x-tagma-tab';

const TAB_META: Record<RightTab, { label: string; icon: typeof Settings2 }> = {
  inspector: { label: 'Inspector', icon: Settings2 },
  yaml: { label: 'YAML', icon: Code },
  chat: { label: 'Chat', icon: MessageSquare },
};

interface PersistedLayout {
  attached: RightTab[];
  activeTab: RightTab | null;
  detachedTab: RightTab | null;
}

function isRightTab(v: unknown): v is RightTab {
  return v === 'inspector' || v === 'yaml' || v === 'chat';
}

function sanitizeLayout(raw: Partial<PersistedLayout>): PersistedLayout {
  const seen = new Set<RightTab>();
  const attached: RightTab[] = [];
  if (Array.isArray(raw.attached)) {
    for (const t of raw.attached) {
      if (isRightTab(t) && !seen.has(t)) {
        seen.add(t);
        attached.push(t);
      }
    }
  }
  let detachedTab: RightTab | null = null;
  if (isRightTab(raw.detachedTab)) {
    detachedTab = raw.detachedTab;
    // Invariant: detached ∉ attached.
    const idx = attached.indexOf(detachedTab);
    if (idx !== -1) attached.splice(idx, 1);
  }
  let activeTab: RightTab | null = null;
  if (isRightTab(raw.activeTab) && attached.includes(raw.activeTab)) {
    activeTab = raw.activeTab;
  } else if (attached.length > 0) {
    activeTab = attached[attached.length - 1];
  }
  return { attached, activeTab, detachedTab };
}

function loadLayout(): PersistedLayout {
  if (typeof localStorage === 'undefined') {
    return { attached: [], activeTab: null, detachedTab: null };
  }
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { attached: [], activeTab: null, detachedTab: null };
    return sanitizeLayout(JSON.parse(raw) as Partial<PersistedLayout>);
  } catch {
    return { attached: [], activeTab: null, detachedTab: null };
  }
}

function saveLayout(layout: PersistedLayout): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* quota / disabled — fine, skip persistence */
  }
}

interface PersistedWidths {
  dock: number;
  detached: number;
}

function clampWidth(w: unknown): number {
  if (typeof w !== 'number' || !Number.isFinite(w)) return TAB_WIDTH_DEFAULT;
  return Math.max(TAB_WIDTH_MIN, Math.min(TAB_WIDTH_MAX, Math.round(w)));
}

function loadWidths(): PersistedWidths {
  if (typeof localStorage === 'undefined') {
    return { dock: TAB_WIDTH_DEFAULT, detached: TAB_WIDTH_DEFAULT };
  }
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return { dock: TAB_WIDTH_DEFAULT, detached: TAB_WIDTH_DEFAULT };
    const parsed = JSON.parse(raw) as Partial<PersistedWidths>;
    return {
      dock: clampWidth(parsed?.dock),
      detached: clampWidth(parsed?.detached),
    };
  } catch {
    return { dock: TAB_WIDTH_DEFAULT, detached: TAB_WIDTH_DEFAULT };
  }
}

function saveWidths(widths: PersistedWidths): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(WIDTH_KEY, JSON.stringify(widths));
  } catch {
    /* fine — skip persistence */
  }
}

export interface UseRightDockResult {
  /** Tabs docked in the horizontal tab strip, in insertion order. */
  attached: RightTab[];
  /** Which attached tab is currently displayed. Always ∈ attached, or null. */
  activeTab: RightTab | null;
  /** Tab pulled out into its own side-by-side column (or null). */
  detachedTab: RightTab | null;
  isTabVisible: (tab: RightTab) => boolean;
  /** Add tab to attached and make it active. No-op if already detached. */
  openTab: (tab: RightTab) => void;
  /** Remove tab from whichever slot holds it. */
  closeTab: (tab: RightTab) => void;
  /** Switch which attached tab is shown. Must be in `attached`. */
  selectTab: (tab: RightTab) => void;
  /** Move tab to the detached slot; old detached (if any) returns to attached. */
  detachTab: (tab: RightTab) => void;
  /** Move the detached tab back into attached as the active one. */
  reattach: () => void;
  /**
   * Rail click: if visible anywhere, close; otherwise open in dock. Keeps the
   * activity rail's click semantics consistent regardless of current state.
   */
  toggleFromRail: (tab: RightTab) => void;
}

/**
 * State hook. The inspector tab stays where the user put it — clearing the
 * selection does NOT close it (the panel shows an empty-state placeholder
 * instead). Manual close (X button or rail click) is the only way to dismiss.
 */
export function useRightDock(): UseRightDockResult {
  const initial = useMemo(() => loadLayout(), []);
  const [attached, setAttached] = useState<RightTab[]>(initial.attached);
  const [activeTab, setActiveTab] = useState<RightTab | null>(initial.activeTab);
  const [detachedTab, setDetachedTab] = useState<RightTab | null>(initial.detachedTab);

  useEffect(() => {
    saveLayout({ attached, activeTab, detachedTab });
  }, [attached, activeTab, detachedTab]);

  // Invariant syncer — if `activeTab` isn't in `attached` (e.g. after a
  // close/detach), fall back to the last remaining attached tab. Runs as an
  // effect rather than inline in every action so we can't forget it.
  useEffect(() => {
    if (activeTab !== null && !attached.includes(activeTab)) {
      setActiveTab(attached.length > 0 ? attached[attached.length - 1] : null);
    } else if (activeTab === null && attached.length > 0) {
      // This branch fires when a tab was just opened into an empty dock.
      setActiveTab(attached[attached.length - 1]);
    }
  }, [attached, activeTab]);

  const openTab = useCallback(
    (tab: RightTab) => {
      // Already visible as the detached column — clicking its tab again would
      // yank it out of the user's custom side-by-side layout. Leave it alone.
      if (detachedTab === tab) return;
      setAttached((a) => (a.includes(tab) ? a : [...a, tab]));
      setActiveTab(tab);
    },
    [detachedTab],
  );

  const closeTab = useCallback((tab: RightTab) => {
    setAttached((a) => a.filter((t) => t !== tab));
    setDetachedTab((d) => (d === tab ? null : d));
    // activeTab is fixed up by the invariant-syncer effect above.
  }, []);

  const selectTab = useCallback((tab: RightTab) => {
    // Only flip `activeTab` if the tab is actually in the dock; a rail click
    // on a not-yet-attached tab goes through `openTab` instead.
    setAttached((a) => {
      if (!a.includes(tab)) return a;
      setActiveTab(tab);
      return a;
    });
  }, []);

  const detachTab = useCallback(
    (tab: RightTab) => {
      if (detachedTab === tab) return;
      // Remove `tab` from attached (if it was there). Simultaneously rescue
      // the previous detached tab by appending it to attached, so a detach
      // never silently eats a tab.
      setAttached((a) => {
        const without = a.filter((t) => t !== tab);
        if (detachedTab && !without.includes(detachedTab)) {
          return [...without, detachedTab];
        }
        return without;
      });
      setDetachedTab(tab);
    },
    [detachedTab],
  );

  const reattach = useCallback(() => {
    setDetachedTab((d) => {
      if (!d) return d;
      setAttached((a) => (a.includes(d) ? a : [...a, d]));
      setActiveTab(d);
      return null;
    });
  }, []);

  const toggleFromRail = useCallback(
    (tab: RightTab) => {
      if (detachedTab === tab) {
        setDetachedTab(null);
        return;
      }
      if (attached.includes(tab)) {
        // Visible in dock (either active or behind another tab). Clicking the
        // rail closes it outright — matches how hitting the rail icon for an
        // active tab felt in the previous single-tab design.
        setAttached((a) => a.filter((t) => t !== tab));
        return;
      }
      // Not visible — open in dock.
      setAttached((a) => [...a, tab]);
      setActiveTab(tab);
    },
    [attached, detachedTab],
  );

  const isTabVisible = useCallback(
    (tab: RightTab) => attached.includes(tab) || detachedTab === tab,
    [attached, detachedTab],
  );

  return {
    attached,
    activeTab,
    detachedTab,
    isTabVisible,
    openTab,
    closeTab,
    selectTab,
    detachTab,
    reattach,
    toggleFromRail,
  };
}

export interface RightDockProps {
  state: UseRightDockResult;
  inspectorAvailable: boolean;
  inspectorContent: ReactNode;
  yamlContent: ReactNode;
  chatContent: ReactNode;
}

export function RightDock({
  state,
  inspectorAvailable,
  inspectorContent,
  yamlContent,
  chatContent,
}: RightDockProps) {
  const {
    attached,
    activeTab,
    detachedTab,
    closeTab,
    selectTab,
    detachTab,
    reattach,
    toggleFromRail,
  } = state;

  // Drag state lives here (not in useRightDock) so the hook stays focused on
  // layout semantics; drag is purely a UI affordance for triggering detach /
  // reattach / tab reordering within the strip.
  const [draggingTab, setDraggingTab] = useState<RightTab | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const [dockWidth, setDockWidth] = useState<number>(() => loadWidths().dock);
  const [detachedWidth, setDetachedWidth] = useState<number>(() => loadWidths().detached);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    saveWidths({ dock: dockWidth, detached: detachedWidth });
  }, [dockWidth, detachedWidth]);

  const startResize = (target: 'dock' | 'detached') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = target === 'dock' ? dockWidth : detachedWidth;
    const setter = target === 'dock' ? setDockWidth : setDetachedWidth;

    setIsResizing(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    // rAF-throttle so we don't spam setState on every pointermove event.
    let pending = startWidth;
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      setter(pending);
    };

    const onMove = (ev: PointerEvent) => {
      // Handle sits on the LEFT edge of a right-side column — dragging left
      // (ev.clientX < startX) widens the column.
      pending = clampWidth(startWidth + (startX - ev.clientX));
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };

    const onUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        setter(pending);
      }
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const renderContent = useCallback(
    (tab: RightTab): ReactNode => {
      switch (tab) {
        case 'inspector':
          return inspectorContent;
        case 'yaml':
          return yamlContent;
        case 'chat':
          return chatContent;
      }
    },
    [inspectorContent, yamlContent, chatContent],
  );

  const handleDragStart = (tab: RightTab) => (e: ReactDragEvent<HTMLElement>) => {
    setDraggingTab(tab);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, tab);
    // Some browsers refuse to initiate drag without this text/plain fallback.
    e.dataTransfer.setData('text/plain', tab);
  };

  const handleDragEnd = () => {
    setDraggingTab(null);
    setDropActive(false);
  };

  const handleDropDetach = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDropActive(false);
    const payload = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (isRightTab(payload)) detachTab(payload);
    setDraggingTab(null);
  };

  const handleDragOverDetach = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!draggingTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropActive) setDropActive(true);
  };

  const handleDropReattach = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (isRightTab(payload) && payload === detachedTab) reattach();
    setDraggingTab(null);
  };

  const handleDragOverReattach = (e: ReactDragEvent<HTMLDivElement>) => {
    if (draggingTab !== detachedTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  // The drop-to-detach zone only makes sense while dragging the dock's active
  // tab — dragging something already detached has nowhere else to go.
  const showDetachDropZone = draggingTab !== null && draggingTab !== detachedTab;

  return (
    <>
      <AnimatePresence initial={false}>
        {showDetachDropZone && (
          <motion.div
            key="detach-drop"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 80, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={`shrink-0 h-full flex items-center justify-center border-l-2 border-dashed overflow-hidden ${
              dropActive
                ? 'border-tagma-accent bg-tagma-accent/10'
                : 'border-tagma-border/60 bg-tagma-surface/30'
            }`}
            onDragOver={handleDragOverDetach}
            onDragLeave={() => setDropActive(false)}
            onDrop={handleDropDetach}
          >
            <span className="text-[9px] font-mono text-tagma-muted uppercase tracking-widest whitespace-nowrap [writing-mode:vertical-rl] rotate-180">
              Drop to detach
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {detachedTab && (
          <motion.aside
            key={`detached-${detachedTab}`}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: detachedWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={isResizing ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="relative shrink-0 overflow-hidden border-l border-tagma-border bg-tagma-bg"
          >
            <div className="h-full flex flex-col" style={{ width: detachedWidth }}>
              <DetachedHeader
                tab={detachedTab}
                onReattach={reattach}
                onClose={() => closeTab(detachedTab)}
                onDragStart={handleDragStart(detachedTab)}
                onDragEnd={handleDragEnd}
                isDragging={draggingTab === detachedTab}
              />
              <div className="flex-1 min-h-0 overflow-hidden">{renderContent(detachedTab)}</div>
            </div>
            <ResizeHandle onPointerDown={startResize('detached')} />
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {attached.length > 0 && (
          <motion.aside
            key="dock"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: dockWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={isResizing ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="relative shrink-0 overflow-hidden border-l border-tagma-border bg-tagma-bg"
            onDragOver={handleDragOverReattach}
            onDrop={handleDropReattach}
          >
            <div className="h-full flex flex-col" style={{ width: dockWidth }}>
              <DockTabStrip
                tabs={attached}
                activeTab={activeTab}
                draggingTab={draggingTab}
                onSelect={selectTab}
                onClose={closeTab}
                onDetach={detachTab}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                {activeTab ? renderContent(activeTab) : null}
              </div>
            </div>
            <ResizeHandle onPointerDown={startResize('dock')} />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Always-visible vertical rail — the sole launcher for the dock now
          that the toolbar no longer carries Chat / YAML toggles. Clicking an
          icon opens or closes its tab; whichever slot is currently showing it
          (dock or detached) counts as "visible". */}
      <ActivityRail
        attached={attached}
        activeTab={activeTab}
        detachedTab={detachedTab}
        inspectorHasSelection={inspectorAvailable}
        onToggle={toggleFromRail}
      />
    </>
  );
}

function DockTabStrip({
  tabs,
  activeTab,
  draggingTab,
  onSelect,
  onClose,
  onDetach,
  onDragStart,
  onDragEnd,
}: {
  tabs: RightTab[];
  activeTab: RightTab | null;
  draggingTab: RightTab | null;
  onSelect: (tab: RightTab) => void;
  onClose: (tab: RightTab) => void;
  onDetach: (tab: RightTab) => void;
  onDragStart: (tab: RightTab) => (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  return (
    <div className="flex items-stretch h-9 border-b border-tagma-border bg-tagma-surface/40 shrink-0">
      {tabs.map((tab) => {
        const meta = TAB_META[tab];
        const Icon = meta.icon;
        const isActive = tab === activeTab;
        const isDragging = draggingTab === tab;
        return (
          <div
            key={tab}
            draggable
            onDragStart={onDragStart(tab)}
            onDragEnd={onDragEnd}
            onClick={() => onSelect(tab)}
            title={`${meta.label} — drag left of the dock to detach`}
            className={`group relative flex items-center gap-1.5 px-2.5 text-[10px] font-mono border-r border-tagma-border/60 cursor-pointer select-none transition-colors ${
              isActive
                ? 'bg-tagma-bg text-tagma-text'
                : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-surface'
            } ${isDragging ? 'opacity-50' : ''}`}
          >
            <Icon size={11} />
            <span>{meta.label}</span>
            {isActive && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDetach(tab);
                }}
                title="Detach into its own column"
                aria-label={`Detach ${meta.label}`}
                className="ml-1 p-0.5 text-tagma-muted/70 hover:text-tagma-accent transition-colors"
              >
                <PanelLeftOpen size={10} />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab);
              }}
              title={`Close ${meta.label}`}
              aria-label={`Close ${meta.label}`}
              className={`p-0.5 transition-colors ${
                isActive
                  ? 'text-tagma-muted/70 hover:text-tagma-text'
                  : 'text-tagma-muted/40 hover:text-tagma-text opacity-0 group-hover:opacity-100'
              }`}
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
      <div className="flex-1" />
    </div>
  );
}

function DetachedHeader({
  tab,
  onReattach,
  onClose,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  tab: RightTab;
  onReattach: () => void;
  onClose: () => void;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const meta = TAB_META[tab];
  const Icon = meta.icon;
  return (
    <div
      className={`flex items-center gap-1.5 h-9 px-2.5 border-b border-tagma-border bg-tagma-surface/40 shrink-0 ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex items-center gap-1.5 text-[10px] font-mono text-tagma-text cursor-grab active:cursor-grabbing select-none"
        title="Drag back onto the dock to re-attach"
      >
        <Icon size={11} className="text-tagma-muted" />
        <span>{meta.label}</span>
      </div>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onReattach}
        title="Re-dock into tab strip"
        aria-label="Re-dock"
        className="p-1 text-tagma-muted hover:text-tagma-accent transition-colors"
      >
        <PanelLeftClose size={11} />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ResizeHandle({
  onPointerDown,
}: {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      title="Drag to resize"
      className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize bg-transparent hover:bg-tagma-accent/60 active:bg-tagma-accent z-50 transition-colors isolate"
    />
  );
}

function ActivityRail({
  attached,
  activeTab,
  detachedTab,
  inspectorHasSelection,
  onToggle,
}: {
  attached: RightTab[];
  activeTab: RightTab | null;
  detachedTab: RightTab | null;
  inspectorHasSelection: boolean;
  onToggle: (tab: RightTab) => void;
}) {
  return (
    <div className="w-8 shrink-0 h-full flex flex-col items-stretch border-l border-tagma-border bg-tagma-surface/40">
      {ALL_TABS.map((tab) => {
        const meta = TAB_META[tab];
        const Icon = meta.icon;
        const isAttached = attached.includes(tab);
        const isDockActive = activeTab === tab;
        const isDetached = detachedTab === tab;
        const visible = isAttached || isDetached;
        const inspectorEmpty = tab === 'inspector' && !inspectorHasSelection;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onToggle(tab)}
            title={
              isDetached
                ? `${meta.label} (detached — click to close)`
                : isDockActive
                  ? `${meta.label} (active — click to close)`
                  : isAttached
                    ? `${meta.label} (in dock — click to close)`
                    : inspectorEmpty
                      ? `${meta.label} (no pipeline, task, or track selected)`
                      : meta.label
            }
            aria-label={meta.label}
            aria-pressed={visible}
            className={`relative flex items-center justify-center h-9 transition-colors ${
              visible
                ? 'text-tagma-accent bg-tagma-accent/10'
                : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-surface'
            }`}
          >
            <Icon size={14} />
            {isDetached && (
              <span
                className="absolute top-1 right-1 w-1.5 h-1.5 bg-tagma-accent"
                aria-hidden="true"
                title="Currently detached"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
