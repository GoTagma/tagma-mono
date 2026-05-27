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
      await reply(permission.id, response);
    } finally {
      // Whether server removes the entry (on success) or keeps it (on
      // failure — replyPermission sets sendError and doesn't throw),
      // the button must re-enable so the user can act again.
      setPending(null);
    }
  };

  const disabled = pending !== null;

  return (
    <div className="max-w-[90%] self-start px-3 py-2 border border-tagma-border bg-tagma-elevated">
      <div className="flex items-center gap-2 mb-2">
        <ShieldCheck size={12} className="text-tagma-warning shrink-0" />
        <span className="text-[11px] font-medium text-tagma-text">Permission required</span>
        <span className="text-[10px] font-mono text-tagma-muted truncate">{permission.tool}</span>
      </div>

      <div className="text-[12px] text-tagma-text mb-2 break-words">{permission.title}</div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('once')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-success border border-tagma-success/30 hover:bg-tagma-success/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Check size={11} />
          <span>{pending === 'once' ? 'Replying…' : 'Allow once'}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('always')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-accent border border-tagma-accent/30 hover:bg-tagma-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <InfinityIcon size={11} />
          <span>{pending === 'always' ? 'Replying…' : 'Always for this chat'}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onClick('reject')}
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-error border border-tagma-error/30 hover:bg-tagma-error/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <X size={11} />
          <span>{pending === 'reject' ? 'Replying…' : 'Reject'}</span>
        </button>
      </div>
    </div>
  );
}
