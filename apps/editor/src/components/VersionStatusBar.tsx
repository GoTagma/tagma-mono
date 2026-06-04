import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Moon,
  RefreshCw,
  Sun,
  X,
  Info,
} from 'lucide-react';
import {
  api,
  type EditorInfo,
  type HotupdateKind,
  type HotupdateStatus,
  type OpencodeInfo,
  type SidecarInfo,
} from '../api/client';
import { useTheme } from '../hooks/use-theme';
import { usePipelineStore } from '../store/pipeline-store';
import { broadcast, subscribe as subscribeChannel } from '../utils/window-sync';
import { ZoomControls } from './board/ZoomControls';

type Popover = 'tagma' | 'opencode' | null;

type EditorFetch =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: EditorInfo }
  | { kind: 'error'; message: string };

type EditorApply =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

type SidecarFetch =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: SidecarInfo }
  | { kind: 'error'; message: string };

type SidecarApply =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

type OpencodeFetch =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: OpencodeInfo }
  | { kind: 'error'; message: string };

type BundleApply =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; editorVersion: string; sidecarVersion: string; opencodeVersion: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

// Server responses for a canceled update carry `{ kind: 'canceled' }`; the
// shared api client.ts request helper hoists that onto the thrown Error's
// `kind` property. Check both so a direct `err.name === 'AbortError'` (from
// e.g. fetch aborts on the client side, should that ever happen) also lands
// in the canceled bucket rather than the error bucket.
function isCanceled(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { kind?: unknown; name?: unknown };
  return e.kind === 'canceled' || e.name === 'AbortError';
}

export type BundleSkew =
  | { kind: 'active'; editorVersion: string; sidecarVersion: string }
  | { kind: 'user-installed'; editorVersion: string; sidecarVersion: string };

/**
 * Detect a Tagma version skew between editor and sidecar. Two shapes:
 *
 *   - `active`: the running editor and sidecar are on different versions —
 *     the post-restart symptom of "I updated but sidecar is still old".
 *
 *   - `user-installed`: both userData hot-update pointers exist and
 *     disagree. Pre-restart symptom of a bundle update that crashed between
 *     editor and sidecar activation; surfacing it lets the user re-run
 *     Update Tagma before the active versions diverge on next launch.
 *
 * `active` wins over `user-installed` when both fire — it matches what the
 * user is currently experiencing.
 *
 * Returns null when no skew is detectable.
 */
export function computeBundleSkew(
  editorInfo: EditorInfo,
  sidecarInfo: SidecarInfo,
): BundleSkew | null {
  if (
    editorInfo.activeVersion &&
    sidecarInfo.activeVersion &&
    editorInfo.activeVersion !== sidecarInfo.activeVersion
  ) {
    return {
      kind: 'active',
      editorVersion: editorInfo.activeVersion,
      sidecarVersion: sidecarInfo.activeVersion,
    };
  }
  if (
    editorInfo.userInstalledVersion &&
    sidecarInfo.userInstalledVersion &&
    editorInfo.userInstalledVersion !== sidecarInfo.userInstalledVersion
  ) {
    return {
      kind: 'user-installed',
      editorVersion: editorInfo.userInstalledVersion,
      sidecarVersion: sidecarInfo.userInstalledVersion,
    };
  }
  return null;
}

export function computeBundlePendingRestart(
  editorInfo: EditorInfo,
  sidecarInfo: SidecarInfo,
): boolean {
  return editorInfo.pendingRestart || sidecarInfo.pendingRestart;
}

export function renderSaveIndicator(args: {
  isDirty: boolean;
  lastAutosaveAt: number | null;
}): ReactNode {
  if (args.isDirty) {
    return (
      <span className="text-tagma-warning/80 shrink-0" title="Unsaved changes">
        ● Unsaved
      </span>
    );
  }
  if (args.lastAutosaveAt !== null) {
    const d = new Date(args.lastAutosaveAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return (
      <span className="text-tagma-muted/60 shrink-0" title="Last saved time">
        {`Saved ${hh}:${mm}:${ss}`}
      </span>
    );
  }
  return null;
}

export function VersionStatusBar() {
  const [open, setOpen] = useState<Popover>(null);
  const { theme, setTheme } = useTheme();
  const yamlPath = usePipelineStore((s) => s.yamlPath);
  const workDir = usePipelineStore((s) => s.workDir);
  const isDirty = usePipelineStore((s) => s.isDirty);
  const lastAutosaveAt = usePipelineStore((s) => s.lastAutosaveAt);

  // Show ".tagma/filename.yaml" relative to workspace when possible, otherwise
  // fall back to the basename so the bar doesn't get crowded out by an
  // absolute path.
  const displayPath = useMemo(() => {
    if (!yamlPath) return null;
    if (workDir) {
      const normalized = yamlPath.replace(/\\/g, '/');
      const normalizedWd = workDir.replace(/\\/g, '/');
      if (normalized.startsWith(normalizedWd + '/')) {
        return normalized.slice(normalizedWd.length + 1);
      }
    }
    return yamlPath.replace(/^.*[\\/]/, '');
  }, [yamlPath, workDir]);

  const [editorFetch, setEditorFetch] = useState<EditorFetch>({ kind: 'loading' });
  const [editorApply, setEditorApply] = useState<EditorApply>({ kind: 'idle' });
  const [sidecarFetch, setSidecarFetch] = useState<SidecarFetch>({ kind: 'loading' });
  const [sidecarApply, setSidecarApply] = useState<SidecarApply>({ kind: 'idle' });
  const [opencodeFetch, setOpencodeFetch] = useState<OpencodeFetch>({ kind: 'loading' });
  const [bundleApply, setBundleApply] = useState<BundleApply>({ kind: 'idle' });
  const [hotupdateStatus, setHotupdateStatus] = useState<HotupdateStatus>({ active: false });
  const observedHotupdateKindRef = useRef<HotupdateKind | null>(null);
  const localHotupdateKindRef = useRef<HotupdateKind | null>(null);

  const refreshEditor = useCallback(async () => {
    setEditorFetch({ kind: 'loading' });
    try {
      const info = await api.getEditorInfo(true);
      setEditorFetch({ kind: 'loaded', info });
    } catch (e) {
      setEditorFetch({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to read editor update status',
      });
    }
  }, []);

  const refreshOpencode = useCallback(async () => {
    setOpencodeFetch({ kind: 'loading' });
    try {
      const info = await api.getOpencodeInfo();
      setOpencodeFetch({ kind: 'loaded', info });
    } catch (e) {
      setOpencodeFetch({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to read OpenCode status',
      });
    }
  }, []);

  const refreshSidecar = useCallback(async () => {
    setSidecarFetch({ kind: 'loading' });
    try {
      const info = await api.getSidecarInfo(true);
      setSidecarFetch({ kind: 'loaded', info });
    } catch (e) {
      setSidecarFetch({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to read sidecar update status',
      });
    }
  }, []);

  const refreshHotupdateStatus = useCallback(async () => {
    try {
      setHotupdateStatus(await api.getHotupdateStatus());
    } catch {
      // Older or restarting sidecars may briefly miss this endpoint. The
      // normal update request still owns final success/error handling.
    }
  }, []);

  const markHotupdateActive = useCallback((kind: HotupdateKind) => {
    switch (kind) {
      case 'release':
        setBundleApply((prev) => (prev.kind === 'updating' ? prev : { kind: 'updating' }));
        break;
      case 'editor':
        setEditorApply((prev) => (prev.kind === 'updating' ? prev : { kind: 'updating' }));
        break;
      case 'sidecar':
        setSidecarApply((prev) => (prev.kind === 'updating' ? prev : { kind: 'updating' }));
        break;
      case 'opencode':
        break;
    }
  }, []);

  const clearRecoveredHotupdate = useCallback((kind: HotupdateKind) => {
    if (localHotupdateKindRef.current === kind) return;
    switch (kind) {
      case 'release':
        setBundleApply((prev) => (prev.kind === 'updating' ? { kind: 'idle' } : prev));
        break;
      case 'editor':
        setEditorApply((prev) => (prev.kind === 'updating' ? { kind: 'idle' } : prev));
        break;
      case 'sidecar':
        setSidecarApply((prev) => (prev.kind === 'updating' ? { kind: 'idle' } : prev));
        break;
      case 'opencode':
        break;
    }
  }, []);

  const refreshAfterHotupdate = useCallback(
    (kind: HotupdateKind) => {
      switch (kind) {
        case 'release':
          void refreshEditor();
          void refreshSidecar();
          void refreshOpencode();
          break;
        case 'editor':
          void refreshEditor();
          break;
        case 'sidecar':
          void refreshSidecar();
          break;
        case 'opencode':
          void refreshOpencode();
          break;
      }
    },
    [refreshEditor, refreshSidecar, refreshOpencode],
  );

  // Fetch both on mount so the chips can show a real version string instead
  // of an unknown placeholder for the whole session. Cheap: both are local-ish reads.
  useEffect(() => {
    void refreshEditor();
    void refreshSidecar();
    void refreshOpencode();
    void refreshHotupdateStatus();
  }, [refreshEditor, refreshSidecar, refreshOpencode, refreshHotupdateStatus]);

  useEffect(() => {
    const currentKind = hotupdateStatus.active ? hotupdateStatus.kind : null;
    const previousKind = observedHotupdateKindRef.current;

    if (currentKind) {
      observedHotupdateKindRef.current = currentKind;
      markHotupdateActive(currentKind);
      return;
    }

    if (previousKind) {
      observedHotupdateKindRef.current = null;
      clearRecoveredHotupdate(previousKind);
      refreshAfterHotupdate(previousKind);
    }
  }, [hotupdateStatus, markHotupdateActive, clearRecoveredHotupdate, refreshAfterHotupdate]);

  const activeHotupdateKind = hotupdateStatus.active ? hotupdateStatus.kind : null;
  useEffect(() => {
    if (!activeHotupdateKind) return;
    const intervalId = window.setInterval(() => {
      void refreshHotupdateStatus();
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [activeHotupdateKind, refreshHotupdateStatus]);

  const handleEditorUpdate = useCallback(async () => {
    localHotupdateKindRef.current = 'editor';
    setEditorApply({ kind: 'updating' });
    try {
      const result = await api.updateEditor();
      setEditorApply({ kind: 'done', version: result.version });
      // Re-fetch info so `pendingRestart` flips true in the panel. We do NOT
      // call window.location.reload() here - the sidecar's express.static
      // was pinned to the old dist at process startup, so a reload would
      // just re-serve the old bundle. Only a full app relaunch (which
      // respawns the sidecar) actually applies the update. The peer-window
      // broadcast is purely for their info-chip refresh; dropping the
      // reload everywhere avoids pretending anything changed.
      void refreshEditor();
      broadcast('editor-updated', { version: result.version });
    } catch (e) {
      if (isCanceled(e)) {
        setEditorApply({ kind: 'canceled' });
        return;
      }
      setEditorApply({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Editor update failed',
      });
    } finally {
      if (localHotupdateKindRef.current === 'editor') localHotupdateKindRef.current = null;
      void refreshHotupdateStatus();
    }
  }, [refreshEditor, refreshHotupdateStatus]);

  const handleEditorCancel = useCallback(() => {
    // Fire-and-forget: the in-flight /update request will reject with a
    // canceled error once the server aborts the download. We don't need to
    // branch on the cancel endpoint's own response — 409 (no update in flight)
    // simply means the server already finished or errored first.
    void api.cancelEditorUpdate().catch(() => {});
  }, []);

  const handleSidecarUpdate = useCallback(async () => {
    localHotupdateKindRef.current = 'sidecar';
    setSidecarApply({ kind: 'updating' });
    try {
      const result = await api.updateSidecar();
      setSidecarApply({ kind: 'done', version: result.version });
      void refreshSidecar();
      broadcast('sidecar-updated', { version: result.version });
    } catch (e) {
      if (isCanceled(e)) {
        setSidecarApply({ kind: 'canceled' });
        return;
      }
      setSidecarApply({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Sidecar update failed',
      });
    } finally {
      if (localHotupdateKindRef.current === 'sidecar') localHotupdateKindRef.current = null;
      void refreshHotupdateStatus();
    }
  }, [refreshSidecar, refreshHotupdateStatus]);

  const handleSidecarCancel = useCallback(() => {
    void api.cancelSidecarUpdate().catch(() => {});
  }, []);

  const handleBundleUpdate = useCallback(async () => {
    localHotupdateKindRef.current = 'release';
    setBundleApply({ kind: 'updating' });
    try {
      const result = await api.updateRelease();
      setBundleApply({
        kind: 'done',
        editorVersion: result.editorVersion,
        sidecarVersion: result.sidecarVersion,
        opencodeVersion: result.opencodeVersion,
      });
      void refreshEditor();
      void refreshSidecar();
      void refreshOpencode();
      broadcast('editor-updated', { version: result.editorVersion });
      broadcast('sidecar-updated', { version: result.sidecarVersion });
    } catch (e) {
      if (isCanceled(e)) {
        setBundleApply({ kind: 'canceled' });
        return;
      }
      setBundleApply({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Release update failed',
      });
    } finally {
      if (localHotupdateKindRef.current === 'release') localHotupdateKindRef.current = null;
      void refreshHotupdateStatus();
    }
  }, [refreshEditor, refreshSidecar, refreshOpencode, refreshHotupdateStatus]);

  const handleBundleCancel = useCallback(() => {
    void api.cancelReleaseUpdate().catch(() => {});
  }, []);

  // Catch update broadcasts from peer windows so chips flip to pendingRestart
  // and prompt the user. OpenCode only changes through the release update
  // path, which refreshes its status directly.
  useEffect(() => {
    const offEditor = subscribeChannel('editor-updated', () => {
      void refreshEditor();
    });
    const offSidecar = subscribeChannel('sidecar-updated', () => {
      void refreshSidecar();
    });
    return () => {
      offEditor();
      offSidecar();
    };
  }, [refreshEditor, refreshSidecar]);

  // When both components report the same `activeVersion`, the bundle chip
  // shows the shared version (the normal case). When they disagree — usually
  // right after a crash between activations — the chip shows "mixed" so the
  // user knows something is off.
  const tagmaActiveVersion =
    editorFetch.kind === 'loaded' && sidecarFetch.kind === 'loaded'
      ? editorFetch.info.activeVersion === sidecarFetch.info.activeVersion
        ? (editorFetch.info.activeVersion ?? 'not found')
        : 'mixed'
      : editorFetch.kind === 'error' || sidecarFetch.kind === 'error'
        ? 'error'
        : '...';

  const bundleSkew =
    editorFetch.kind === 'loaded' && sidecarFetch.kind === 'loaded'
      ? computeBundleSkew(editorFetch.info, sidecarFetch.info)
      : null;

  // Auto-open the bundle popover the first time skew is detected this
  // session so the warning is visible without the user having to click.
  // Tracked via a ref so dismissing (closing) the popover doesn't bounce
  // it back open the next render.
  const skewAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (bundleSkew && !skewAutoOpenedRef.current) {
      skewAutoOpenedRef.current = true;
      setOpen('tagma');
    }
  }, [bundleSkew]);

  const bundleLatestVersion = editorFetch.kind === 'loaded' ? editorFetch.info.latestVersion : null;

  const bundleCanUpdate =
    editorFetch.kind === 'loaded' &&
    sidecarFetch.kind === 'loaded' &&
    editorFetch.info.canUpdate &&
    sidecarFetch.info.canUpdate &&
    editorFetch.info.shellCompatible &&
    sidecarFetch.info.shellCompatible;

  const bundleUpdateAvailable =
    editorFetch.kind === 'loaded' &&
    sidecarFetch.kind === 'loaded' &&
    (editorFetch.info.updateAvailable || sidecarFetch.info.updateAvailable);

  const bundleHasUpdate = bundleCanUpdate && bundleUpdateAvailable;
  const bundlePendingRestart =
    editorFetch.kind === 'loaded' && sidecarFetch.kind === 'loaded'
      ? computeBundlePendingRestart(editorFetch.info, sidecarFetch.info)
      : false;

  const opencodeActive =
    opencodeFetch.kind === 'loaded'
      ? (opencodeFetch.info.runningVersion ??
        opencodeFetch.info.userInstalledVersion ??
        opencodeFetch.info.bundledVersion)
      : null;
  const opencodeVersion =
    opencodeFetch.kind === 'loaded'
      ? (opencodeActive ?? 'not found')
      : opencodeFetch.kind === 'error'
        ? 'error'
        : '...';

  return (
    <div className="h-6 shrink-0 border-t border-tagma-border bg-tagma-bg flex items-center px-2 text-[10px] font-mono text-tagma-muted select-none gap-2">
      <div className="flex items-center gap-1 shrink-0">
        <VersionChip
          label={`tagma ${tagmaActiveVersion}`}
          hasUpdate={bundleHasUpdate || bundlePendingRestart}
          warning={bundleSkew !== null}
          warningTitle={
            bundleSkew
              ? `Version skew: editor ${bundleSkew.editorVersion} vs sidecar ${bundleSkew.sidecarVersion}. Click for details.`
              : undefined
          }
          active={open === 'tagma'}
          onClick={() => setOpen((prev) => (prev === 'tagma' ? null : 'tagma'))}
        >
          {open === 'tagma' && (
            <PopoverShell onClose={() => setOpen(null)} title="Tagma">
              <TagmaBundleBody
                editorFetch={editorFetch}
                sidecarFetch={sidecarFetch}
                bundleApply={bundleApply}
                editorApply={editorApply}
                sidecarApply={sidecarApply}
                bundleLatestVersion={bundleLatestVersion}
                bundleCanUpdate={bundleCanUpdate}
                bundleUpdateAvailable={bundleUpdateAvailable}
                onBundleUpdate={handleBundleUpdate}
                onBundleCancel={handleBundleCancel}
                onRefreshEditor={refreshEditor}
                onRefreshSidecar={refreshSidecar}
                onEditorOnlyUpdate={handleEditorUpdate}
                onEditorOnlyCancel={handleEditorCancel}
                onSidecarOnlyUpdate={handleSidecarUpdate}
                onSidecarOnlyCancel={handleSidecarCancel}
              />
            </PopoverShell>
          )}
        </VersionChip>

        <span className="text-tagma-muted/40">·</span>

        <VersionChip
          label={`opencode ${opencodeVersion}`}
          hasUpdate={false}
          active={open === 'opencode'}
          onClick={() => setOpen((prev) => (prev === 'opencode' ? null : 'opencode'))}
        >
          {open === 'opencode' && (
            <PopoverShell onClose={() => setOpen(null)} title="OpenCode CLI">
              {opencodeFetch.kind === 'loading' && <LoadingRow text="Reading OpenCode status..." />}
              {opencodeFetch.kind === 'error' && <ErrorRow text={opencodeFetch.message} />}
              {opencodeFetch.kind === 'loaded' && (
                <OpencodeInfoBody info={opencodeFetch.info} onRefresh={refreshOpencode} />
              )}
            </PopoverShell>
          )}
        </VersionChip>
      </div>

      {displayPath && (
        <div className="flex items-center gap-1 min-w-0 flex-1 group/file">
          <span className="text-tagma-muted/40 shrink-0">·</span>
          <span className="text-tagma-muted/70 truncate" title={yamlPath!}>
            {displayPath}
          </span>
          <button
            onClick={() => api.reveal(yamlPath!).catch(() => {})}
            className="text-tagma-muted/40 hover:text-tagma-accent opacity-0 group-hover/file:opacity-100 transition-opacity shrink-0"
            title="Reveal in File Explorer"
            aria-label="Reveal file in File Explorer"
          >
            <ExternalLink size={9} />
          </button>
        </div>
      )}

      {(() => {
        const ind = renderSaveIndicator({ isDirty, lastAutosaveAt });
        if (!ind) return null;
        return (
          <>
            <span className="text-tagma-muted/40">·</span>
            {ind}
          </>
        );
      })()}

      <div className="flex items-center h-full shrink-0 ml-auto">
        <ZoomControls />
        <div className="w-px h-3 bg-tagma-border/60 mx-1" />
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="flex items-center gap-1 px-1.5 py-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Moon size={11} /> : <Sun size={11} />}
        </button>
      </div>
    </div>
  );
}

interface VersionChipProps {
  label: string;
  hasUpdate: boolean;
  /** Shown as a red warning indicator that pre-empts the update dot. */
  warning?: boolean;
  /** Tooltip text used when `warning` is true. */
  warningTitle?: string;
  active: boolean;
  onClick: () => void;
  children?: ReactNode;
}

function VersionChip({
  label,
  hasUpdate,
  warning,
  warningTitle,
  active,
  onClick,
  children,
}: VersionChipProps) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        title={warning ? warningTitle : undefined}
        className={
          'flex items-center gap-1 px-1.5 py-0.5 transition-colors ' +
          (warning
            ? 'text-tagma-error hover:bg-tagma-error/10 ' + (active ? 'bg-tagma-error/15' : '')
            : active
              ? 'bg-tagma-surface text-tagma-text'
              : 'hover:bg-tagma-surface hover:text-tagma-text')
        }
      >
        <span>{label}</span>
        {warning ? (
          <AlertTriangle
            size={9}
            className="text-tagma-error"
            aria-label={warningTitle ?? 'Warning'}
          />
        ) : hasUpdate ? (
          <span
            className="w-1.5 h-1.5 rounded-full bg-tagma-accent"
            title="Update available"
            aria-label="Update available"
          />
        ) : null}
      </button>
      {children}
    </div>
  );
}

interface PopoverShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

function PopoverShell({ title, onClose, children }: PopoverShellProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // The trigger button is a sibling that also toggles via onClick, so
        // we only close on clicks outside the whole chip wrapper.
        const wrapper = ref.current.parentElement;
        if (wrapper && !wrapper.contains(e.target as Node)) onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 bottom-full mb-1 z-[90] w-max min-w-[320px] max-w-[640px] bg-tagma-surface border border-tagma-border/80 shadow-xl p-3 animate-fade-in"
    >
      <div className="text-[11px] font-sans text-tagma-text mb-2">{title}</div>
      {children}
    </div>
  );
}

function LoadingRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-tagma-muted font-sans">
      <Loader2 size={12} className="animate-spin" />
      {text}
    </div>
  );
}

function ErrorRow({ text }: { text: string }) {
  return <div className="text-[10px] text-tagma-error font-mono break-words">{text}</div>;
}

interface TagmaBundleBodyProps {
  editorFetch: EditorFetch;
  sidecarFetch: SidecarFetch;
  bundleApply: BundleApply;
  editorApply: EditorApply;
  sidecarApply: SidecarApply;
  bundleLatestVersion: string | null;
  bundleCanUpdate: boolean;
  bundleUpdateAvailable: boolean;
  onBundleUpdate: () => void;
  onBundleCancel: () => void;
  onRefreshEditor: () => void;
  onRefreshSidecar: () => void;
  onEditorOnlyUpdate: () => void;
  onEditorOnlyCancel: () => void;
  onSidecarOnlyUpdate: () => void;
  onSidecarOnlyCancel: () => void;
}

function TagmaBundleBody(props: TagmaBundleBodyProps) {
  const {
    editorFetch,
    sidecarFetch,
    bundleApply,
    editorApply,
    sidecarApply,
    bundleLatestVersion,
    bundleCanUpdate,
    bundleUpdateAvailable,
    onBundleUpdate,
    onBundleCancel,
    onRefreshEditor,
    onRefreshSidecar,
    onEditorOnlyUpdate,
    onEditorOnlyCancel,
    onSidecarOnlyUpdate,
    onSidecarOnlyCancel,
  } = props;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const updating = bundleApply.kind === 'updating';

  const rows: { label: string; running: string | null; latest: string | null }[] = [
    {
      label: 'Editor',
      running: editorFetch.kind === 'loaded' ? editorFetch.info.activeVersion : null,
      latest: editorFetch.kind === 'loaded' ? editorFetch.info.latestVersion : null,
    },
    {
      label: 'Sidecar',
      running: sidecarFetch.kind === 'loaded' ? sidecarFetch.info.activeVersion : null,
      latest: sidecarFetch.kind === 'loaded' ? sidecarFetch.info.latestVersion : null,
    },
  ];

  const skew =
    editorFetch.kind === 'loaded' && sidecarFetch.kind === 'loaded'
      ? computeBundleSkew(editorFetch.info, sidecarFetch.info)
      : null;
  const pendingRestart =
    editorFetch.kind === 'loaded' && sidecarFetch.kind === 'loaded'
      ? computeBundlePendingRestart(editorFetch.info, sidecarFetch.info)
      : false;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-[10px] font-mono [&>span]:whitespace-nowrap">
        <span className="text-tagma-muted">Component</span>
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-muted">Latest</span>
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span className="text-tagma-text">{row.label}</span>
            <span className="text-tagma-text">
              {row.running ?? <span className="text-tagma-warning">not found</span>}
            </span>
            <span
              className={
                row.latest && row.running && row.latest !== row.running
                  ? 'text-tagma-accent'
                  : 'text-tagma-muted-dim'
              }
            >
              {row.latest ?? '—'}
            </span>
          </Fragment>
        ))}
      </div>

      {skew && (
        <WarnBox
          message={
            skew.kind === 'active'
              ? `Version skew detected (editor ${skew.editorVersion} vs sidecar ${skew.sidecarVersion}). Run Update Tagma to realign.`
              : `A previous Update Tagma did not complete (editor staged ${skew.editorVersion}, sidecar staged ${skew.sidecarVersion}). Run Update Tagma again to realign before the next launch.`
          }
        />
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onBundleUpdate}
          disabled={!bundleCanUpdate || !bundleUpdateAvailable || updating}
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors whitespace-nowrap"
          title={
            !bundleCanUpdate
              ? 'Updates are only available when running under the desktop app.'
              : !bundleUpdateAvailable
                ? pendingRestart
                  ? 'Update downloaded. Close and reopen Tagma to apply.'
                  : 'Tagma is already at the latest version.'
                : `Download editor and sidecar ${bundleLatestVersion}. Takes effect next time Tagma relaunches.`
          }
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {updating
            ? 'Updating...'
            : bundleUpdateAvailable && bundleLatestVersion
              ? `Update Tagma to ${bundleLatestVersion}`
              : pendingRestart
                ? 'Restart required'
                : 'Up to date'}
        </button>
        {updating && <CancelUpdateButton onCancel={onBundleCancel} />}
        <button
          onClick={() => {
            onRefreshEditor();
            onRefreshSidecar();
          }}
          disabled={updating}
          className="btn-ghost whitespace-nowrap"
          title="Re-check the release manifest"
        >
          <RefreshCw size={11} /> Check again
        </button>
      </div>

      {bundleApply.kind === 'done' && (
        <SuccessBox>
          Downloaded editor {bundleApply.editorVersion}, sidecar {bundleApply.sidecarVersion}, and
          OpenCode {bundleApply.opencodeVersion}. Close and reopen Tagma to apply.
        </SuccessBox>
      )}
      {pendingRestart && bundleApply.kind !== 'done' && (
        <InfoBox>Update downloaded. Close and reopen Tagma to apply.</InfoBox>
      )}
      {bundleApply.kind === 'canceled' && (
        <InfoBox>Update canceled. No changes were applied.</InfoBox>
      )}
      {bundleApply.kind === 'error' && <WarnBox message={bundleApply.message} />}

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-[10px] text-tagma-muted hover:text-tagma-text underline"
      >
        {showAdvanced ? 'Hide advanced recovery' : 'Advanced recovery'}
      </button>
      {showAdvanced && (
        <div className="border-t border-tagma-border/60 pt-2 space-y-2">
          <div className="text-[10px] text-tagma-muted font-sans">
            Single-component hot updates are disabled for OpenCode-pinned releases. Run Update Tagma
            again to recover from a partial update; it stages editor, sidecar, and OpenCode
            together.
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={onEditorOnlyUpdate}
              disabled={true}
              className="btn-ghost whitespace-nowrap"
              title="Use Update Tagma so editor, sidecar, and OpenCode stay compatible."
            >
              {editorApply.kind === 'updating' ? 'Updating editor...' : 'Editor-only disabled'}
            </button>
            {editorApply.kind === 'updating' && (
              <CancelUpdateButton onCancel={onEditorOnlyCancel} />
            )}
            <button
              onClick={onSidecarOnlyUpdate}
              disabled={true}
              className="btn-ghost whitespace-nowrap"
              title="Use Update Tagma so editor, sidecar, and OpenCode stay compatible."
            >
              {sidecarApply.kind === 'updating' ? 'Updating sidecar...' : 'Sidecar-only disabled'}
            </button>
            {sidecarApply.kind === 'updating' && (
              <CancelUpdateButton onCancel={onSidecarOnlyCancel} />
            )}
          </div>
          {editorApply.kind === 'canceled' && <InfoBox>Editor update canceled.</InfoBox>}
          {sidecarApply.kind === 'canceled' && <InfoBox>Sidecar update canceled.</InfoBox>}
          {editorApply.kind === 'error' && <WarnBox message={editorApply.message} />}
          {sidecarApply.kind === 'error' && <WarnBox message={sidecarApply.message} />}
        </div>
      )}
    </div>
  );
}

interface OpencodeInfoBodyProps {
  info: OpencodeInfo;
  onRefresh: () => void;
}

// Read-only view: OpenCode is pinned per Tagma release and ships with the
// installer. We intentionally do NOT expose an in-app updater — letting users
// upgrade independently has caused chat/runtime breakage in the past, so
// upgrades only ride along with a Tagma release.
function OpencodeInfoBody({ info, onRefresh }: OpencodeInfoBodyProps) {
  const activeVersion =
    info.runningVersion ?? info.userInstalledVersion ?? info.bundledVersion ?? null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] font-mono [&>span]:whitespace-nowrap">
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-text">
          {activeVersion ?? <span className="text-tagma-warning">not found</span>}
        </span>
        <span className="text-tagma-muted">Bundled</span>
        <span className="text-tagma-muted-dim">
          {info.bundledVersion ?? '(dev mode - none shipped)'}
        </span>
        {info.userInstalledVersion && (
          <>
            <span className="text-tagma-muted">User override</span>
            <span className="text-tagma-muted-dim">{info.userInstalledVersion}</span>
          </>
        )}
        <span className="text-tagma-muted">Target</span>
        <span className="text-tagma-muted-dim">
          {info.platform}/{info.arch}
        </span>
      </div>

      <div className="bg-tagma-surface/40 border border-tagma-border/60 px-2 py-1.5">
        <div className="flex items-start gap-1.5 text-[10px] text-tagma-muted/90 font-sans">
          <Info size={10} className="text-tagma-muted shrink-0 mt-[1px]" />
          <span>
            OpenCode ships with each Tagma release and is upgraded together with the editor — update
            Tagma to pick up a newer build.
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onRefresh}
          className="btn-ghost whitespace-nowrap"
          title="Re-probe the running OpenCode binary"
        >
          <RefreshCw size={11} /> Check again
        </button>
      </div>
    </div>
  );
}

function CancelUpdateButton({ onCancel }: { onCancel: () => void }) {
  // Fires once per click; the onCancel handler itself debounces against the
  // server (cancel endpoint returns 409 if nothing's in flight — no-op).
  // Re-clicks during the brief window before the /update request actually
  // rejects are harmless.
  const [clicked, setClicked] = useState(false);
  const label = clicked ? 'Canceling...' : 'Cancel';
  return (
    <button
      type="button"
      onClick={() => {
        setClicked(true);
        onCancel();
      }}
      disabled={clicked}
      className="flex items-center gap-1 text-[11px] px-2 py-1 border border-tagma-border text-tagma-muted hover:text-tagma-error hover:border-tagma-error/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      title="Abort the download and discard any staged bytes"
      aria-label="Cancel update"
    >
      <X size={11} />
      {label}
    </button>
  );
}

function SuccessBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
        <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}

function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-accent/8 border border-tagma-accent/30 px-2 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-accent/90 font-mono">
        <RefreshCw size={10} className="text-tagma-accent shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}

function WarnBox({ message }: { message: string }) {
  return (
    <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
        <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
        <span>{message}</span>
      </div>
    </div>
  );
}
