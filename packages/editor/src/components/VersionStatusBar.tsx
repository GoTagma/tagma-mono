import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Moon,
  RefreshCw,
  Sun,
} from 'lucide-react';
import {
  api,
  type EditorInfo,
  type OpencodeInfo,
} from '../api/client';
import { useTheme } from '../hooks/use-theme';
import { ZoomControls } from './board/ZoomControls';

type Popover = 'editor' | 'opencode' | null;

type EditorFetch =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: EditorInfo }
  | { kind: 'error'; message: string };

type EditorApply =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'error'; message: string };

type OpencodeFetch =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: OpencodeInfo }
  | { kind: 'error'; message: string };

type OpencodeApply =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'error'; message: string };

export function VersionStatusBar() {
  const [open, setOpen] = useState<Popover>(null);
  const { theme, setTheme } = useTheme();

  const [editorFetch, setEditorFetch] = useState<EditorFetch>({ kind: 'loading' });
  const [editorApply, setEditorApply] = useState<EditorApply>({ kind: 'idle' });
  const [opencodeFetch, setOpencodeFetch] = useState<OpencodeFetch>({ kind: 'loading' });
  const [opencodeApply, setOpencodeApply] = useState<OpencodeApply>({ kind: 'idle' });

  const refreshEditor = useCallback(async () => {
    setEditorFetch({ kind: 'loading' });
    try {
      const info = await api.getEditorInfo();
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

  // Fetch both on mount so the chips can show a real version string instead
  // of "…" for the whole session. Cheap: both are local-ish reads.
  useEffect(() => {
    void refreshEditor();
    void refreshOpencode();
  }, [refreshEditor, refreshOpencode]);

  const handleEditorUpdate = useCallback(async () => {
    setEditorApply({ kind: 'updating' });
    try {
      const result = await api.updateEditor();
      setEditorApply({ kind: 'done', version: result.version });
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setEditorApply({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Editor update failed',
      });
    }
  }, []);

  const handleOpencodeUpdate = useCallback(async () => {
    setOpencodeApply({ kind: 'updating' });
    try {
      const result = await api.updateOpencode();
      setOpencodeApply({ kind: 'done', version: result.version });
      await refreshOpencode();
    } catch (e) {
      setOpencodeApply({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Update failed',
      });
    }
  }, [refreshOpencode]);

  const editorVersion =
    editorFetch.kind === 'loaded'
      ? (editorFetch.info.activeVersion ?? 'not found')
      : editorFetch.kind === 'error'
        ? 'error'
        : '…';
  const editorHasUpdate =
    editorFetch.kind === 'loaded' && editorFetch.info.updateAvailable && editorFetch.info.canUpdate;

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
        : '…';
  const opencodeHasUpdate =
    opencodeFetch.kind === 'loaded' &&
    opencodeFetch.info.updateAvailable &&
    opencodeFetch.info.canUpdate;

  return (
    <div className="h-6 shrink-0 border-t border-tagma-border bg-tagma-bg flex items-center justify-between px-2 text-[10px] font-mono text-tagma-muted select-none">
      <div className="flex items-center gap-1">
        <VersionChip
          label={`editor ${editorVersion}`}
          hasUpdate={editorHasUpdate}
          active={open === 'editor'}
          onClick={() => setOpen((prev) => (prev === 'editor' ? null : 'editor'))}
        >
          {open === 'editor' && (
            <PopoverShell onClose={() => setOpen(null)} title="Editor">
              {editorFetch.kind === 'loading' && <LoadingRow text="Reading editor update status…" />}
              {editorFetch.kind === 'error' && <ErrorRow text={editorFetch.message} />}
              {editorFetch.kind === 'loaded' && (
                <EditorUpdateBody
                  info={editorFetch.info}
                  apply={editorApply}
                  onRefresh={refreshEditor}
                  onUpdate={handleEditorUpdate}
                />
              )}
            </PopoverShell>
          )}
        </VersionChip>

        <span className="text-tagma-muted/40">·</span>

        <VersionChip
          label={`opencode ${opencodeVersion}`}
          hasUpdate={opencodeHasUpdate}
          active={open === 'opencode'}
          onClick={() => setOpen((prev) => (prev === 'opencode' ? null : 'opencode'))}
        >
          {open === 'opencode' && (
            <PopoverShell onClose={() => setOpen(null)} title="OpenCode CLI">
              {opencodeFetch.kind === 'loading' && <LoadingRow text="Reading OpenCode status…" />}
              {opencodeFetch.kind === 'error' && <ErrorRow text={opencodeFetch.message} />}
              {opencodeFetch.kind === 'loaded' && (
                <OpencodeUpdateBody
                  info={opencodeFetch.info}
                  apply={opencodeApply}
                  onRefresh={refreshOpencode}
                  onUpdate={handleOpencodeUpdate}
                />
              )}
            </PopoverShell>
          )}
        </VersionChip>
      </div>

      <div className="flex items-center h-full">
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
  active: boolean;
  onClick: () => void;
  children?: ReactNode;
}

function VersionChip({ label, hasUpdate, active, onClick, children }: VersionChipProps) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        className={
          'flex items-center gap-1 px-1.5 py-0.5 transition-colors ' +
          (active
            ? 'bg-tagma-surface text-tagma-text'
            : 'hover:bg-tagma-surface hover:text-tagma-text')
        }
      >
        <span>{label}</span>
        {hasUpdate && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-tagma-accent"
            title="Update available"
            aria-label="Update available"
          />
        )}
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
      className="absolute left-0 bottom-full mb-1 z-[90] w-[320px] bg-tagma-surface border border-tagma-border/80 shadow-xl p-3 animate-fade-in"
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

interface EditorUpdateBodyProps {
  info: EditorInfo;
  apply: EditorApply;
  onRefresh: () => void;
  onUpdate: () => void;
}

function EditorUpdateBody({ info, apply, onRefresh, onUpdate }: EditorUpdateBodyProps) {
  const updating = apply.kind === 'updating';
  const disabled = !info.manifestUrl;

  const buttonTitle = disabled
    ? 'Editor updates are disabled in this build (no manifest URL configured).'
    : !info.canUpdate
      ? 'Editor updates are only available when running under the desktop app.'
      : !info.updateAvailable
        ? 'Editor is already at the latest version.'
        : `Download editor ${info.latestVersion} and swap in without a restart`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] font-mono">
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-text">
          {info.activeVersion ?? <span className="text-tagma-warning">not found</span>}
        </span>
        <span className="text-tagma-muted">Bundled</span>
        <span className="text-tagma-muted-dim">
          {info.bundledVersion ?? '(dev mode — none shipped)'}
        </span>
        {info.userInstalledVersion && (
          <>
            <span className="text-tagma-muted">Hot-update override</span>
            <span className="text-tagma-muted-dim">{info.userInstalledVersion}</span>
          </>
        )}
        <span className="text-tagma-muted">Channel</span>
        <span className="text-tagma-muted-dim">{info.channel ?? 'stable'}</span>
        <span className="text-tagma-muted">Latest</span>
        <span className={info.updateAvailable ? 'text-tagma-accent' : 'text-tagma-muted-dim'}>
          {disabled
            ? '(updates disabled)'
            : (info.latestVersion ?? '(manifest unreachable)')}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onUpdate}
          disabled={disabled || !info.canUpdate || !info.updateAvailable || updating}
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          title={buttonTitle}
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {updating
            ? 'Updating…'
            : info.updateAvailable && info.latestVersion
              ? `Update to ${info.latestVersion}`
              : 'Up to date'}
        </button>
        <button
          onClick={onRefresh}
          disabled={updating}
          className="btn-ghost"
          title="Re-check the release manifest"
        >
          <RefreshCw size={11} /> Check again
        </button>
        {info.releaseNotesUrl && info.updateAvailable && (
          <a
            href={info.releaseNotesUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-tagma-muted hover:text-tagma-text underline"
          >
            Release notes
          </a>
        )}
      </div>

      {apply.kind === 'done' && (
        <SuccessBox>Installed editor {apply.version}. Reloading to apply…</SuccessBox>
      )}
      {apply.kind === 'error' && <WarnBox message={apply.message} />}
    </div>
  );
}

interface OpencodeUpdateBodyProps {
  info: OpencodeInfo;
  apply: OpencodeApply;
  onRefresh: () => void;
  onUpdate: () => void;
}

function OpencodeUpdateBody({ info, apply, onRefresh, onUpdate }: OpencodeUpdateBodyProps) {
  const activeVersion =
    info.runningVersion ?? info.userInstalledVersion ?? info.bundledVersion ?? null;
  const updating = apply.kind === 'updating';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] font-mono">
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-text">
          {activeVersion ?? <span className="text-tagma-warning">not found</span>}
        </span>
        <span className="text-tagma-muted">Bundled</span>
        <span className="text-tagma-muted-dim">
          {info.bundledVersion ?? '(dev mode — none shipped)'}
        </span>
        {info.userInstalledVersion && (
          <>
            <span className="text-tagma-muted">User override</span>
            <span className="text-tagma-muted-dim">{info.userInstalledVersion}</span>
          </>
        )}
        <span className="text-tagma-muted">Latest on npm</span>
        <span className={info.updateAvailable ? 'text-tagma-accent' : 'text-tagma-muted-dim'}>
          {info.latestVersion ?? '(registry unreachable)'}
        </span>
        <span className="text-tagma-muted">Target</span>
        <span className="text-tagma-muted-dim">
          {info.platform}/{info.arch}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onUpdate}
          disabled={!info.canUpdate || !info.updateAvailable || updating}
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          title={
            !info.canUpdate
              ? 'Updates are only available when running under the desktop app.'
              : !info.updateAvailable
                ? 'OpenCode is already at the latest version.'
                : `Download opencode ${info.latestVersion} for ${info.platform}/${info.arch}`
          }
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {updating
            ? 'Updating…'
            : info.updateAvailable && info.latestVersion
              ? `Update to ${info.latestVersion}`
              : 'Up to date'}
        </button>
        <button
          onClick={onRefresh}
          disabled={updating}
          className="btn-ghost"
          title="Re-check the registry"
        >
          <RefreshCw size={11} /> Check again
        </button>
      </div>

      {apply.kind === 'done' && (
        <SuccessBox>Installed opencode {apply.version} into your profile.</SuccessBox>
      )}
      {apply.kind === 'error' && <WarnBox message={apply.message} />}
    </div>
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
