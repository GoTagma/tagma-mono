import { useMemo } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, FileCode2, Loader2, Plus, X as XIcon } from 'lucide-react';
import { ProductLogo } from './ProductLogo';
import type { WorkspaceYamlEntry } from '../api/client';
import { formatRelative } from '../utils/format-relative';

interface PipelinePickerProps {
  workDir: string;
  workspaceYamls: WorkspaceYamlEntry[];
  yamlEditLocked: boolean;
  openingPath: string | null;
  onPickPipeline: (path: string) => void;
  onCreateNew: () => void;
  onSwitchWorkspace: () => void;
  onDeletePipeline: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function PipelineRow({
  entry,
  isOpening,
  openingPath,
  yamlEditLocked,
  onPickPipeline,
  onDeletePipeline,
}: {
  entry: WorkspaceYamlEntry;
  isOpening: boolean;
  openingPath: string | null;
  yamlEditLocked: boolean;
  onPickPipeline: (path: string) => void;
  onDeletePipeline: (path: string) => void;
}) {
  const primary =
    entry.pipelineName && entry.pipelineName.trim() ? entry.pipelineName.trim() : entry.name;
  const showSecondary = primary !== entry.name;
  const openingThis = openingPath === entry.path;
  return (
    <li className="group flex items-stretch transition-colors">
      <button
        type="button"
        onClick={() => onPickPipeline(entry.path)}
        disabled={isOpening}
        aria-busy={openingThis || undefined}
        aria-label={`${openingThis ? 'Opening' : 'Open'} pipeline ${primary}`}
        className={`group/row flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-tagma-elevated/40 disabled:cursor-wait ${
          openingThis ? '' : 'disabled:opacity-50'
        }`}
        title={entry.path}
      >
        {openingThis ? (
          <Loader2
            size={13}
            aria-hidden="true"
            className="shrink-0 animate-spin text-tagma-accent"
          />
        ) : (
          <FileCode2
            size={13}
            className="shrink-0 text-tagma-muted transition-colors group-hover/row:text-tagma-accent"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-label font-medium text-tagma-text">{primary}</span>
          </div>
          {showSecondary && (
            <div className="mt-0.5 truncate font-mono text-caption text-tagma-muted-dim">
              {entry.name}
            </div>
          )}
        </div>
        {openingThis ? (
          <span
            role="status"
            aria-live="polite"
            className="shrink-0 font-mono text-caption text-tagma-accent"
          >
            <span className="sr-only">Opening pipeline {primary}</span>
            <span aria-hidden="true">Opening</span>
          </span>
        ) : (
          <span className="shrink-0 font-mono text-caption tabular-nums text-tagma-muted-dim">
            {formatRelative(entry.mtimeMs)}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (yamlEditLocked || isOpening) return;
          onDeletePipeline(entry.path);
        }}
        disabled={yamlEditLocked || isOpening}
        className="mr-3 shrink-0 self-center p-1 text-tagma-muted-dim/40 opacity-0 transition-[opacity,color] hover:text-tagma-error focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-0"
        title={`Remove the "${entry.name}" pipeline folder (run history is preserved)`}
        aria-label={`Remove ${entry.name}`}
      >
        <XIcon size={11} />
      </button>
    </li>
  );
}

export function PipelinePicker({
  workDir,
  workspaceYamls,
  yamlEditLocked,
  openingPath,
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
  const isOpening = openingPath !== null;

  return (
    <motion.div
      className="h-full w-full flex items-center justify-center bg-tagma-bg overflow-y-auto py-4 sm:py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full max-w-[640px] px-4 sm:px-8 my-auto">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3 sm:mb-10">
          <div className="w-9 h-9 flex items-center justify-center">
            <ProductLogo size={32} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-display font-semibold tracking-wide text-tagma-text truncate">
              {wsName}
            </h1>
            <p className="text-caption font-mono uppercase tracking-widest text-tagma-muted-dim mt-0.5 truncate">
              {workDir}
            </p>
          </div>
          <button
            type="button"
            onClick={onSwitchWorkspace}
            disabled={isOpening}
            className="group flex items-center gap-1.5 px-2 py-1 text-tagma-muted hover:text-tagma-accent transition-colors shrink-0 disabled:cursor-wait disabled:text-tagma-muted-dim/50"
            title="Return to workspace selection"
            aria-label="Switch workspace"
          >
            <ArrowLeft size={11} />
            <span className="hidden text-caption font-mono uppercase tracking-widest sm:inline">
              Switch Workspace
            </span>
          </button>
        </div>

        {/* Section heading */}
        <div className="flex items-center gap-2 mb-3 px-0.5">
          <FileCode2 size={10} className="text-tagma-muted-dim" />
          <span className="text-caption font-medium text-tagma-muted uppercase tracking-widest">
            Pipelines
          </span>
        </div>

        <ul
          className="flex max-h-[min(55dvh,20rem)] flex-col divide-y divide-tagma-border/60 overflow-y-auto border border-tagma-border"
          aria-busy={isOpening}
        >
          {sorted.map((entry) => (
            <PipelineRow
              key={entry.path}
              entry={entry}
              isOpening={isOpening}
              openingPath={openingPath}
              yamlEditLocked={yamlEditLocked}
              onPickPipeline={onPickPipeline}
              onDeletePipeline={onDeletePipeline}
            />
          ))}
        </ul>

        {/* Footer action */}
        <button
          type="button"
          onClick={onCreateNew}
          disabled={isOpening}
          aria-label="Create new pipeline"
          className="group flex items-center gap-2 mt-3 px-3 py-2 text-tagma-muted hover:text-tagma-accent transition-colors disabled:cursor-wait disabled:text-tagma-muted-dim/50"
        >
          <Plus size={11} />
          <span className="text-body font-medium">New Pipeline</span>
        </button>

        {/* Footer hint */}
        <div className="mt-6 text-center sm:mt-10">
          <p className="text-caption font-mono text-tagma-muted-dim/70 tracking-wide">
            Pipelines stored in <span className="text-tagma-muted-dim">{wsRoot}/.tagma/</span>
          </p>
        </div>
      </div>
    </motion.div>
  );
}
