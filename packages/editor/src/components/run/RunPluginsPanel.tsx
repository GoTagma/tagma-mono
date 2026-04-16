// Read-only plugins panel shown in Run mode when the user opens the
// Plugins modal. Displays:
//  - Plugin packages declared in the pipeline (`config.plugins`)
//  - Registered handlers grouped by category (drivers / triggers /
//    completions / middlewares), which tells the user what the SDK
//    actually loaded for this run

import { useMemo } from 'react';
import { X, Package, Cpu, Zap, CheckCircle2, Layers } from 'lucide-react';
import { usePipelineStore } from '../../store/pipeline-store';
import type { RawPipelineConfig } from '../../api/client';
import { viewportH } from '../../utils/zoom';

interface RunPluginsPanelProps {
  config: RawPipelineConfig;
  onClose: () => void;
}

function Section({ icon, label, items }: { icon: React.ReactNode; label: string; items: readonly string[] }) {
  if (items.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-1">
          {icon}
          <span>{label}</span>
          <span className="text-tagma-muted/40">(0)</span>
        </div>
        <div className="text-[10px] font-mono text-tagma-muted/40 italic pl-5">— none registered —</div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-1">
        {icon}
        <span>{label}</span>
        <span className="text-tagma-muted/40">({items.length})</span>
      </div>
      <div className="pl-5 flex flex-wrap gap-1">
        {items.map((name) => (
          <span
            key={name}
            className="text-[10px] font-mono text-tagma-text/80 bg-tagma-bg border border-tagma-border/60 px-2 py-[2px]"
          >
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RunPluginsPanel({ config, onClose }: RunPluginsPanelProps) {
  const registry = usePipelineStore((s) => s.registry);

  const declaredPlugins = useMemo(() => config.plugins ?? [], [config.plugins]);
  const maxH = useMemo(() => Math.floor(viewportH() * 0.8), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[560px] flex flex-col animate-fade-in"
        style={{ maxHeight: maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-tagma-accent" />
            <h2 className="panel-title">Plugins (read-only)</h2>
          </div>
          <button onClick={onClose} className="p-1 text-tagma-muted hover:text-tagma-text transition-colors">
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* Declared (from config.plugins) */}
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-1.5">
              <Package size={9} />
              <span>Declared packages</span>
              <span className="text-tagma-muted/40">({declaredPlugins.length})</span>
            </div>
            {declaredPlugins.length === 0 ? (
              <div className="text-[10px] font-mono text-tagma-muted/50 italic pl-5">
                No third-party plugin packages declared in this pipeline.
              </div>
            ) : (
              <div className="pl-5 space-y-1">
                {declaredPlugins.map((name) => (
                  <div
                    key={name}
                    className="text-[11px] font-mono text-tagma-text bg-tagma-bg border border-tagma-border px-2.5 py-1"
                  >
                    {name}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-tagma-border/40" />

          {/* Registered handlers — what the SDK actually loaded */}
          <div className="space-y-4">
            <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/50">
              Registered handlers (builtin + declared packages)
            </div>
            <Section
              icon={<Cpu size={9} />}
              label="Drivers"
              items={registry.drivers}
            />
            <Section
              icon={<Zap size={9} />}
              label="Triggers"
              items={registry.triggers}
            />
            <Section
              icon={<CheckCircle2 size={9} />}
              label="Completions"
              items={registry.completions}
            />
            <Section
              icon={<Layers size={9} />}
              label="Middlewares"
              items={registry.middlewares}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
