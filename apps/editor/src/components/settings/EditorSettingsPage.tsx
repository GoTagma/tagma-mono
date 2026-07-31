import { useState } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import type { PluginRegistry } from '../../api/client';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';
import { useEditorSettingsController } from './use-editor-settings-controller';
import {
  EditorSettingsSections,
  PythonAgentWizard,
  SETTINGS_CATEGORIES,
  SettingsStorageFooter,
  type SettingsCategory,
} from './EditorSettingsSections';

interface EditorSettingsPageProps {
  workDir: string;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onBack: () => void;
}

/**
 * Full-page Editor Settings — VS Code-style layout framed like the
 * Plugins/Stats pages: an h-9 utility header, a numbered category rail on the
 * left, and the active category's settings on the right. All state and
 * sections come from the shared settings controller.
 */
export function EditorSettingsPage({ workDir, onRegistryUpdate, onBack }: EditorSettingsPageProps) {
  const [category, setCategory] = useState<SettingsCategory>(SETTINGS_CATEGORIES[0].id);
  const controller = useEditorSettingsController(workDir, onRegistryUpdate);
  const isDesktop = hasDesktopBridge();
  const activeLabel = SETTINGS_CATEGORIES.find((c) => c.id === category)?.label ?? '';

  return (
    <div className="h-full flex flex-col bg-tagma-bg text-tagma-text">
      <header className="shrink-0 bg-tagma-surface/60 border-b border-tagma-border">
        <div
          className={`h-9 flex items-stretch border-b border-tagma-border/60 ${isDesktop ? 'app-drag-region pl-2 pr-0' : 'px-2'}`}
          onDoubleClick={(e) => {
            if (!isDesktop) return;
            if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
          }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0 h-full">
            <button
              onClick={onBack}
              title="Back to Editor"
              className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 shrink-0"
            >
              <ArrowLeft size={12} />
              <span className="hidden md:inline">Back to Editor</span>
            </button>
            <div className="w-px h-5 bg-tagma-border shrink-0" />
            <div className="flex items-center gap-1.5 px-2 shrink-0">
              <Settings2 size={13} className="text-tagma-accent" />
              <span className="text-xs font-medium text-tagma-text truncate max-w-[200px]">
                Editor Settings
              </span>
            </div>
            <div className="flex-1 min-w-[32px]" />
          </div>
          {isDesktop && <DesktopWindowControls />}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b border-tagma-border bg-tagma-surface/25 py-2 md:w-48 md:border-b-0 md:border-r md:py-5">
          <div className="hidden px-5 pb-3 text-[9px] tracking-[0.22em] uppercase text-tagma-muted-dim md:block">
            Categories
          </div>
          <nav className="flex overflow-x-auto md:flex-col md:overflow-x-visible">
            {SETTINGS_CATEGORIES.map((c, i) => {
              const isActive = category === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  className={`group relative flex min-w-[9rem] shrink-0 items-baseline gap-3 py-2 pl-5 pr-4 text-left transition-colors md:w-full md:min-w-0 ${
                    isActive
                      ? 'text-tagma-text bg-tagma-surface/80'
                      : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-surface/40'
                  }`}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1 bottom-1 w-[2px] bg-tagma-accent"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`w-5 text-[9px] font-mono tabular-nums leading-none ${
                      isActive ? 'text-tagma-accent' : 'text-tagma-muted-dim'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="flex-1 text-[12px] tracking-wide leading-tight">{c.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="flex-1 min-h-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 py-5 sm:px-8">
            <div className="pb-3 text-[9px] tracking-[0.22em] uppercase text-tagma-muted-dim">
              {activeLabel}
            </div>
            <div className="space-y-4">
              <EditorSettingsSections controller={controller} categories={[category]} />
              <SettingsStorageFooter controller={controller} />
            </div>
          </div>
        </section>
      </div>

      <PythonAgentWizard controller={controller} />
    </div>
  );
}
