import { useState } from 'react';
import { ShieldCheck, Check, Infinity as InfinityIcon, X } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { PendingPermission } from '../../utils/permission-store-helpers';

interface PermissionBubbleProps {
  permission: PendingPermission;
}

/**
 * Inline prompt for an opencode tool-permission request. Rendered at the end
 * of the chat stream after YamlActionBubble; appears until the server emits
 * permission.replied (which applySseEvent in chat-store removes from state).
 *
 * No client-side timeout — opencode's server-side timeout is authoritative.
 * Buttons disable while a reply is in flight so double-click doesn't fire
 * two POSTs; re-enabled on failure so retry works.
 */
export function PermissionBubble({ permission }: PermissionBubbleProps) {
  const reply = useChatStore((s) => s.replyPermission);
  const [pending, setPending] = useState<null | 'once' | 'always' | 'reject'>(null);

  const onClick = async (response: 'once' | 'always' | 'reject') => {
    if (pending) return;
    setPending(response);
    try {
      await reply(
        permission.id,
        response,
        permission.sessionID,
        permission.workspaceKey,
        permission.protocol,
        permission.directory,
      );
    } finally {
      // Whether server removes the entry (on success) or keeps it (on
      // failure — replyPermission sets sendError and doesn't throw),
      // the button must re-enable so the user can act again.
      setPending(null);
    }
  };

  const disabled = pending !== null;
  const workspaceLabel =
    permission.workspaceKey.split(/[\\/]/).filter(Boolean).at(-1) ?? permission.workspaceKey;

  return (
    <div className="max-w-[90%] self-start px-3 py-2 chat-permission-card">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={12} className="text-tagma-warning shrink-0" />
        <span className="text-body font-medium text-tagma-text">Permission required</span>
        <span className="text-caption font-mono text-tagma-muted truncate">{permission.tool}</span>
      </div>

      <dl className="mb-2 grid grid-cols-[auto,minmax(0,1fr)] gap-x-2 gap-y-1 text-caption">
        <dt className="text-tagma-muted">Requested action</dt>
        <dd className="min-w-0 break-words text-tagma-text">{permission.title}</dd>
        <dt className="text-tagma-muted">Workspace</dt>
        <dd className="min-w-0 truncate font-mono text-tagma-text" title={permission.workspaceKey}>
          {workspaceLabel}
        </dd>
        {permission.directory && (
          <>
            <dt className="text-tagma-muted">Working directory</dt>
            <dd
              className="min-w-0 break-all font-mono text-tagma-text"
              title={permission.directory}
            >
              {permission.directory}
            </dd>
          </>
        )}
      </dl>

      <p className="mb-2 text-caption text-tagma-muted/85">
        Allow only if this action and target match what you asked Tagma to do.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('once')}
          className="flex items-start gap-1 px-2 py-1 text-left text-body text-tagma-success border border-tagma-success/30 hover:bg-tagma-success/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={11} className="mt-0.5 shrink-0" />
          <span className="flex flex-col">
            <span>{pending === 'once' ? 'Replying…' : 'Allow once'}</span>
            <span className="text-caption text-tagma-muted">Only this request</span>
          </span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('always')}
          className="flex items-start gap-1 px-2 py-1 text-left text-body text-tagma-accent border border-tagma-accent/30 hover:bg-tagma-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <InfinityIcon size={11} className="mt-0.5 shrink-0" />
          <span className="flex flex-col">
            <span>{pending === 'always' ? 'Replying…' : 'Always for this chat'}</span>
            <span className="text-caption text-tagma-muted">
              Future matching requests in this chat
            </span>
          </span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('reject')}
          className="flex items-start gap-1 px-2 py-1 text-left text-body text-tagma-error border border-tagma-error/30 hover:bg-tagma-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <X size={11} className="mt-0.5 shrink-0" />
          <span className="flex flex-col">
            <span>{pending === 'reject' ? 'Replying…' : 'Reject'}</span>
            <span className="text-caption text-tagma-muted">Do not run this request</span>
          </span>
        </button>
      </div>
    </div>
  );
}
