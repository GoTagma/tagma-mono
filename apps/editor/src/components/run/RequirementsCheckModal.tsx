import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  RefreshCw,
  PlayCircle,
  X as XIcon,
} from 'lucide-react';
import { api } from '../../api/client';
import { useRunStore, type RequirementsMissingState } from '../../store/run-store';
import { CopyButton } from './CopyButton';
import { openLocalFilePath } from '../../desktop';

interface BinarySection {
  readonly label: string;
  readonly usedBy: readonly string[];
  readonly commands: ReadonlyArray<{ readonly platform: string; readonly command: string }>;
  readonly verify: string | null;
  readonly hasContent: boolean;
}

interface EnvSection {
  readonly name: string;
  readonly description: string | null;
}

/**
 * Pull the `### \`<name>\`` block out of a requirements.md body, then parse
 * the bullet-list install commands and the `Verify:` line. The agent's system
 * prompt declares this exact shape — see `## Companion .requirements.md file`
 * in opencode-seed.ts. When the section is missing or unparseable we still
 * render the binary so the user knows what's wrong, just without copy buttons.
 */
function extractBinarySection(body: string, name: string): BinarySection {
  const empty: BinarySection = {
    label: name,
    usedBy: [],
    commands: [],
    verify: null,
    hasContent: false,
  };
  const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(`^###\\s+\`${escName}\`\\s*$`, 'm');
  const match = headerRe.exec(body);
  if (!match) return empty;
  const startIdx = match.index;
  const restStart = startIdx + match[0].length;
  const restAfter = body.slice(restStart);
  const nextHeaderOffset = restAfter.search(/^###\s+/m);
  const sectionEnd = nextHeaderOffset === -1 ? body.length : restStart + nextHeaderOffset;
  const section = body.slice(restStart, sectionEnd);

  const commands: { platform: string; command: string }[] = [];
  for (const m of section.matchAll(/^-\s+([^:]+):\s+`([^`]+)`/gm)) {
    commands.push({ platform: m[1]!.trim(), command: m[2]! });
  }

  const usedBy: string[] = [];
  const usedByMatch = /^Used in:\s*(.+)$/m.exec(section);
  if (usedByMatch) {
    for (const m of usedByMatch[1]!.matchAll(/`([^`]+)`/g)) {
      usedBy.push(m[1]!);
    }
  }

  const verifyMatch = /^Verify:\s+`([^`]+)`/m.exec(section);

  return {
    label: name,
    usedBy,
    commands,
    verify: verifyMatch ? verifyMatch[1]! : null,
    hasContent: commands.length > 0 || verifyMatch !== null || usedBy.length > 0,
  };
}

interface RequirementsCheckModalProps {
  readonly state: RequirementsMissingState;
  readonly onRecheck: () => void;
  readonly onRunAnyway: () => void;
  readonly onCancel: () => void;
}

export function RequirementsCheckModal({
  state,
  onRecheck,
  onRunAnyway,
  onCancel,
}: RequirementsCheckModalProps) {
  const [body, setBody] = useState<string | null>(null);
  const [envFrontmatter, setEnvFrontmatter] = useState<EnvSection[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getRequirements(state.requirementsPath)
      .then((res) => {
        if (cancelled) return;
        setBody(res.body);
        const envs: EnvSection[] = (res.frontmatter?.env ?? []).map((e) => ({
          name: e.name,
          description: e.description ?? null,
        }));
        setEnvFrontmatter(envs);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [state.requirementsPath]);

  const binarySections = useMemo(
    () => state.missing.binaries.map((name) => (body ? extractBinarySection(body, name) : null)),
    [body, state.missing.binaries],
  );

  const envSections = useMemo(() => {
    const byName = new Map(envFrontmatter.map((e) => [e.name, e] as const));
    return state.missing.envs.map((name) => byName.get(name) ?? { name, description: null });
  }, [envFrontmatter, state.missing.envs]);

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[640px] max-h-[80vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={14} className="text-tagma-warning shrink-0" />
            <h2 className="panel-title truncate text-tagma-warning">
              Pipeline requirements not satisfied
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <p className="text-[11px] text-tagma-text/80 leading-relaxed">
            Tagma checked this pipeline against its{' '}
            <code className="font-mono text-tagma-muted">.requirements.md</code> file before
            launching and found {state.missing.binaries.length + state.missing.envs.length} missing
            dependenc{state.missing.binaries.length + state.missing.envs.length === 1 ? 'y' : 'ies'}{' '}
            on this machine. Install the missing items below, then click <strong>Re-check</strong>.
            If you've already installed them and the check is wrong, use <strong>Run anyway</strong>
            .
          </p>

          {loadError && (
            <div className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2 text-[11px] text-tagma-warning">
              Could not load install instructions: {loadError}
            </div>
          )}

          {state.missing.binaries.length > 0 && (
            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-1.5">
                Missing CLI tools
              </div>
              <div className="space-y-2">
                {state.missing.binaries.map((name, i) => (
                  <BinaryCard key={name} name={name} section={binarySections[i] ?? null} />
                ))}
              </div>
            </section>
          )}

          {state.missing.envs.length > 0 && (
            <section>
              <div className="text-[10px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-1.5">
                Missing environment variables
              </div>
              <div className="space-y-1.5">
                {envSections.map((e) => (
                  <div
                    key={e.name}
                    className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-tagma-warning">
                      <code className="font-mono">{e.name}</code>
                    </div>
                    {e.description && (
                      <p className="mt-1 text-[10px] text-tagma-text/70 leading-relaxed">
                        {e.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <button
            type="button"
            onClick={() => openLocalFilePath(state.requirementsPath)}
            className="flex items-center gap-1 text-[10px] text-tagma-accent hover:underline"
          >
            <ExternalLink size={10} />
            <span>View full requirements document</span>
          </button>
        </div>

        <div className="px-4 py-3 border-t border-tagma-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="min-w-[96px] px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors text-center"
          >
            Cancel
          </button>
          <button
            onClick={onRunAnyway}
            className="min-w-[120px] px-3 py-1 text-[11px] text-tagma-warning border border-tagma-warning/50 hover:bg-tagma-warning/10 transition-colors flex items-center justify-center gap-1.5"
          >
            <PlayCircle size={11} />
            <span>Run anyway</span>
          </button>
          <button
            onClick={onRecheck}
            className="btn-primary w-auto min-w-[120px] justify-center text-center flex items-center gap-1.5"
          >
            <RefreshCw size={11} />
            <span>Re-check</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function BinaryCard({ name, section }: { name: string; section: BinarySection | null }) {
  return (
    <div className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-tagma-warning">
        <Download size={11} />
        <span>
          <code className="font-mono">{name}</code> not found on PATH
        </span>
      </div>

      {section?.usedBy && section.usedBy.length > 0 && (
        <p className="text-[10px] text-tagma-text/70 leading-relaxed">
          Used in:{' '}
          {section.usedBy.map((u, i) => (
            <span key={u}>
              {i > 0 && ', '}
              <code className="font-mono">{u}</code>
            </span>
          ))}
        </p>
      )}

      {section && section.commands.length > 0 ? (
        <div className="space-y-1.5">
          {section.commands.map((c, idx) => (
            <div key={`${c.platform}-${idx}`}>
              <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/70 mb-0.5">
                {c.platform}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-tagma-text bg-tagma-bg border border-tagma-border px-2 py-1.5">
                <span className="flex-1 min-w-0 truncate select-text" title={c.command}>
                  {c.command}
                </span>
                <CopyButton value={c.command} title="Copy command" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-tagma-muted/80 leading-relaxed">
          {section === null
            ? 'Loading install instructions…'
            : section.hasContent
              ? 'See the requirements document for install steps.'
              : `No install instructions yet for \`${name}\`. Open the chat and ask the agent to add them, or edit \`.requirements.md\` by hand.`}
        </p>
      )}

      {section?.verify && (
        <p className="text-[10px] text-tagma-muted/80">
          Verify: <code className="font-mono text-tagma-text/80">{section.verify}</code>
        </p>
      )}
    </div>
  );
}

/**
 * Mount once at App level. Subscribes to the run-store; renders nothing when
 * there is no pending preflight failure.
 */
export function GlobalRequirementsCheckModal() {
  const pending = useRunStore((s) => s.requirementsMissing);
  const retryRunFromRequirements = useRunStore((s) => s.retryRunFromRequirements);
  const dismissRequirementsCheck = useRunStore((s) => s.dismissRequirementsCheck);
  if (!pending) return null;
  return (
    <RequirementsCheckModal
      state={pending}
      onRecheck={() => {
        void retryRunFromRequirements();
      }}
      onRunAnyway={() => {
        void retryRunFromRequirements({ skipPreflight: true });
      }}
      onCancel={() => {
        dismissRequirementsCheck();
      }}
    />
  );
}
