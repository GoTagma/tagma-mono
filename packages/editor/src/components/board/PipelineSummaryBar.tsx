import { Cpu, Clock, Plug, Webhook } from 'lucide-react';
import type { RawPipelineConfig } from '../../api/client';

interface PipelineSummaryBarProps {
  config: RawPipelineConfig;
}

/* Uniform icon+label chip */
function InfoChip({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 h-[16px] px-1.5 bg-tagma-elevated/60 border border-tagma-border/50 min-w-0 overflow-hidden">
      <span className={`inline-flex items-center justify-center shrink-0 ${color}`}>{icon}</span>
      <span className="text-[9px] font-mono text-tagma-muted/80 whitespace-nowrap">{label}</span>
    </div>
  );
}

export function PipelineSummaryBar({ config }: PipelineSummaryBarProps) {
  const hookCount = config.hooks
    ? Object.values(config.hooks).filter((v) => {
        if (v === undefined || v === null || v === '') return false;
        if (Array.isArray(v)) return v.length > 0;
        return true;
      }).length
    : 0;
  const pluginCount = config.plugins?.length ?? 0;

  const hasAnyInfo = config.driver || config.timeout || pluginCount > 0 || hookCount > 0;
  if (!hasAnyInfo) return null;

  const totalTasks = config.tracks.reduce((n, t) => n + t.tasks.length, 0);

  const chips: React.ReactNode[] = [];
  if (config.driver)
    chips.push(
      <InfoChip
        key="d"
        icon={<Cpu size={9} />}
        label={config.driver}
        color="text-tagma-accent/50"
      />,
    );
  if (config.timeout)
    chips.push(
      <InfoChip key="t" icon={<Clock size={9} />} label={config.timeout} color="text-tagma-ready/60" />,
    );
  if (pluginCount > 0)
    chips.push(
      <InfoChip
        key="p"
        icon={<Plug size={9} />}
        label={`${pluginCount} plugin${pluginCount !== 1 ? 's' : ''}`}
        color="text-tagma-info/60"
      />,
    );
  if (hookCount > 0)
    chips.push(
      <InfoChip
        key="h"
        icon={<Webhook size={9} />}
        label={`${hookCount}/6 hooks`}
        color="text-tagma-success/60"
      />,
    );

  return (
    <div className="flex items-center h-[26px] px-[44px] bg-tagma-bg border-b border-tagma-border/30 shrink-0">
      <div className="flex items-center gap-1.5 h-full">{chips}</div>
      <span className="flex-1" />
      <span className="text-[9px] font-mono text-tagma-muted/30 tracking-wide">
        {config.tracks.length} track{config.tracks.length !== 1 ? 's' : ''}
        {' · '}
        {totalTasks} task{totalTasks !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
