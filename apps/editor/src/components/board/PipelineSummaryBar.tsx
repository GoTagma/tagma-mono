import { Cpu, Clock, Plug, Webhook } from 'lucide-react';
import type { RawPipelineConfig } from '../../api/client';

interface PipelineSummaryBarProps {
  config: RawPipelineConfig;
}

/* Uniform icon+label chip */
function InfoChip({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className="inline-flex h-[16px] min-w-0 shrink-0 items-center gap-1.5 overflow-hidden border border-tagma-border/50 bg-tagma-elevated/60 px-1.5">
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
      <InfoChip
        key="t"
        icon={<Clock size={9} />}
        label={config.timeout}
        color="text-tagma-ready/60"
      />,
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
    <div className="flex h-[26px] min-w-0 shrink-0 items-center border-b border-tagma-border/30 bg-tagma-bg px-2 sm:px-[44px]">
      <div className="hide-scrollbar flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {chips}
      </div>
      <span className="hidden sm:inline shrink-0 pl-2 text-[9px] font-mono tracking-wide text-tagma-muted/30">
        {config.tracks.length} track{config.tracks.length !== 1 ? 's' : ''}
        {' · '}
        {totalTasks} task{totalTasks !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
