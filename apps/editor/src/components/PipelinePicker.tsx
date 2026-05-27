import { useMemo } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, FileCode2, Plus, X as XIcon } from 'lucide-react';
import { ProductLogo } from './ProductLogo';
import type { WorkspaceYamlEntry } from '../api/client';
import { formatRelative } from '../utils/format-relative';

interface PipelinePickerProps {
  workDir: string;
  workspaceYamls: WorkspaceYamlEntry[];
  yamlEditLocked: boolean;
  onPickPipeline: (path: string) => void;
  onCreateNew: () => void;
  onSwitchWorkspace: () => void;
  onDeletePipeline: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function PipelinePicker({
  workDir,
  workspaceYamls,
  yamlEditLocked,
  onPickPipeline,
  onCreateNew,
  onSwitchWorkspace,
  onDeletePipeline,
}: PipelinePickerProps) {
  const sorted = useMemo(
    () => [...workspaceYamls].sort((a, b) => b.mtimeMs - a.mtimeMs),
    [workspaceYamls],
  );

  const wsName = basename(workDir);
  const wsRoot = workDir.replace(/[/\\]+$/, '');

  return (
    <motion.div
      className="h-full w-full flex items-center justify-center bg-tagma-bg overflow-y-auto py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full max-w-[640px] px-8 my-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 flex items-center justify-center">
            <ProductLogo size={32} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold tracking-wide text-tagma-text truncate">
              {wsName}
            </h1>
            <p className="text-[10px] font-mono uppercase tracking-widest text-tagma-muted-dim mt-0.5 truncate">
              {workDir}
            </p>
          </div>
          <button
            type="button"
            onClick={onSwitchWorkspace}
            className="group flex items-center gap-1.5 px-2 py-1 text-tagma-muted hover:text-tagma-accent transition-colors shrink-0"
            title="Return to workspace selection"
          >
            <ArrowLeft size={11} />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              Switch Workspace
            </span>
          </button>
        </div>

        {/* Section heading */}
        <div className="flex items-center gap-2 mb-3 px-0.5">
          <FileCode2 size={10} className="text-tagma-muted-dim" />
          <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-widest">
            Pipelines
          </span>
        </div>

        {/* List — scrolls inside its own bounded box when the workspace
            holds many pipelines, so the header and footer stay visible. */}
        <ul className="flex flex-col border border-tagma-border divide-y divide-tagma-border/60 max-h-[55vh] overflow-y-auto">
          {sorted.map((y) => {
            const primary =
              y.pipelineName && y.pipelineName.trim() ? y.pipelineName.trim() : y.name;
            const showSecondary = primary !== y.name;
            return (
              <li
                key={y.path}
                className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-tagma-elevated/40 cursor-pointer"
                onClick={() => {
                  onPickPipeline(y.path);
                }}
                title={y.path}
              >
                <FileCode2
                  size={13}
                  className="shrink-0 text-tagma-muted group-hover:text-tagma-accent transition-colors"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-tagma-text truncate">
                      {primary}
                    </span>
                  </div>
                  {showSecondary && (
                    <div className="text-[10px] font-mono text-tagma-muted-dim truncate mt-0.5">
                      {y.name}
                    </div>
                  )}
                </div>
                <span className="text-[10px] font-mono text-tagma-muted-dim shrink-0 tabular-nums">
                  {formatRelative(y.mtimeMs)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (yamlEditLocked) return;
                    onDeletePipeline(y.path);
                  }}
                  disabled={yamlEditLocked}
                  className="p-1 text-tagma-muted-dim/40 hover:text-tagma-error opacity-0 group-hover:opacity-100 transition-all shrink-0 disabled:opacity-0"
                  title={`Remove the "${y.name}" pipeline folder (run history is preserved)`}
                  aria-label={`Remove ${y.name}`}
                >
                  <XIcon size={11} />
                </button>
              </li>
            );
          })}
        </ul>

        {/* Footer action */}
        <button
          type="button"
          onClick={onCreateNew}
          className="group flex items-center gap-2 mt-3 px-3 py-2 text-tagma-muted hover:text-tagma-accent transition-colors"
        >
          <Plus size={11} />
          <span className="text-[11px] font-medium">New Pipeline</span>
        </button>

        {/* Footer hint */}
        <div className="mt-10 text-center">
          <p className="text-[10px] font-mono text-tagma-muted-dim/70 tracking-wide">
            Pipelines stored in <span className="text-tagma-muted-dim">{wsRoot}/.tagma/</span>
          </p>
        </div>
      </div>
    </motion.div>
  );
}
