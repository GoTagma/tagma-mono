import { Bug, Copy, Loader2, Power } from 'lucide-react';

import type { DiagnosticsSessionStatus } from '../../api/client';

interface DiagnosticsSettingsSectionProps {
  status: DiagnosticsSessionStatus | null;
  busy: boolean;
  copied: boolean;
  hasWorkspace: boolean;
  currentWorkspace: string;
  onEnable: () => void;
  onDisable: () => void;
  onCopy: () => void;
}

export function DiagnosticsSettingsSection({
  status,
  busy,
  copied,
  hasWorkspace,
  currentWorkspace,
  onEnable,
  onDisable,
  onCopy,
}: DiagnosticsSettingsSectionProps) {
  const enabledForCurrentWorkspace =
    status?.enabled === true && status.workspaceKey === currentWorkspace;

  return (
    <div>
      <label className="field-label">Coding agent diagnostics</label>
      <div className="space-y-2 border border-tagma-border bg-tagma-bg px-2.5 py-2">
        <div className="flex items-start gap-2">
          <Bug size={13} className="mt-0.5 shrink-0 text-tagma-accent" />
          <div className="space-y-1 text-caption leading-relaxed text-tagma-muted">
            <p>
              Enable a temporary, loopback-only, read-only connection so Codex or another coding
              agent can inspect this workspace's current editor state, OpenCode chat, active runs,
              and recent runtime logs.
            </p>
            <p className="text-tagma-warning/90">
              Known credential formats are redacted, but chat messages, prompts, tool output, file
              paths, and console logs may still contain sensitive text. Review diagnostics before
              sharing them.
            </p>
          </div>
        </div>

        <div className="text-caption font-mono text-tagma-muted">
          {status === null
            ? 'Checking status...'
            : status.enabled
              ? `Enabled for ${status.workspaceKey ?? 'unknown workspace'}`
              : 'Disabled'}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!enabledForCurrentWorkspace && (
            <button
              type="button"
              onClick={onEnable}
              disabled={!hasWorkspace || busy}
              className="flex items-center gap-1.5 border border-tagma-accent/50 px-2.5 py-1 text-body text-tagma-accent transition-colors hover:bg-tagma-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Power size={11} />}
              {status?.enabled ? 'Enable for this workspace' : 'Enable diagnostics'}
            </button>
          )}

          {status?.enabled && (
            <>
              <button
                type="button"
                onClick={onCopy}
                disabled={busy}
                className="flex items-center gap-1.5 border border-tagma-border px-2.5 py-1 text-body text-tagma-text transition-colors hover:bg-tagma-surface disabled:opacity-40"
              >
                <Copy size={11} />
                {copied ? 'Copied' : 'Copy agent instructions'}
              </button>
              <button
                type="button"
                onClick={onDisable}
                disabled={busy}
                className="border border-tagma-error/40 px-2.5 py-1 text-body text-tagma-error/90 transition-colors hover:bg-tagma-error/10 disabled:opacity-40"
              >
                Disable
              </button>
            </>
          )}
        </div>

        <p className="text-tiny leading-relaxed text-tagma-muted/80">
          The random token is rotated each time diagnostics are enabled and is revoked when disabled
          or when Tagma closes. It cannot call the editor's write APIs.
        </p>
      </div>
    </div>
  );
}
