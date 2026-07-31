import { X } from 'lucide-react';
import { type PluginRegistry } from '../../api/client';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';
import {
  getOpencodeSettingsMutationBlockMessage,
  useEditorSettingsController,
} from '../settings/use-editor-settings-controller';
import {
  EditorSettingsSections,
  PythonAgentWizard,
  SettingsStorageFooter,
} from '../settings/EditorSettingsSections';

// Re-exported so existing imports (and tests) pinned to this module keep
// working now that the implementation lives in settings/use-editor-settings-controller.
export { getOpencodeSettingsMutationBlockMessage };

interface EditorSettingsPanelProps {
  workDir: string;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onClose: () => void;
}

/**
 * Classic Editor Settings modal. This is only the dialog chrome — every
 * section, the Python wizard, and all state come from the shared settings
 * controller/sections so the modal and the full settings page behave
 * identically. Kept reachable as "Editor Settings (Classic)..." until the
 * page replacement is confirmed.
 */
export function EditorSettingsPanel({
  workDir,
  onRegistryUpdate,
  onClose,
}: EditorSettingsPanelProps) {
  const controller = useEditorSettingsController(workDir, onRegistryUpdate);
  const modalRef = useModalFocusTrap<HTMLDivElement>();

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell flex w-full max-w-[680px] flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 id="editor-settings-title" className="panel-title">
            Editor Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="modal-viewport-body space-y-4 px-5 py-4">
          <EditorSettingsSections controller={controller} />
          <SettingsStorageFooter controller={controller} />
        </div>
      </div>
      <PythonAgentWizard controller={controller} />
    </div>
  );
}
