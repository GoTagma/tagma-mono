import { useEffect, useState } from 'react';
import { Download, ExternalLink, Terminal } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { openLocalFilePath } from '../../desktop';
import { api } from '../../api/client';

interface ParsedBinarySection {
  readonly label: string;
  readonly usedBy: readonly string[];
  readonly commands: ReadonlyArray<{ readonly platform: string; readonly command: string }>;
  readonly verify: string | null;
  readonly hasContent: boolean;
}

/**
 * Pull the `### \`<name>\`` section out of a requirements.md body. Mirrors the
 * extractor in RequirementsCheckModal — kept inline so this component remains
 * usable inline next to the task error without a shared parser dependency.
 *
 * The agent's system prompt declares the exact body shape this expects (see
 * `## Companion .requirements.md file` in opencode-seed.ts).
 */
function extractBinarySection(body: string, name: string): ParsedBinarySection {
  const empty: ParsedBinarySection = {
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

interface MissingBinaryHelpProps {
  /** The bare command name the runtime tried to spawn (e.g. "claude"). */
  readonly binary: string;
}

/**
 * Renders install instructions for a single missing CLI, sourced from the
 * pipeline's `*.requirements.md` body. The body is maintained per pipeline
 * (server-synced binary list, agent-maintained install commands), so changing
 * what the user sees here doesn't require a code change — they edit the file.
 *
 * When the requirements file doesn't exist, can't be loaded, or doesn't yet
 * have a section for this binary, falls back to a generic "not on PATH"
 * notice rather than rendering nothing.
 */
export function MissingBinaryHelp({ binary }: MissingBinaryHelpProps) {
  const [section, setSection] = useState<ParsedBinarySection | null>(null);
  const [requirementsPath, setRequirementsPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getRequirements()
      .then((res) => {
        if (cancelled) return;
        setSection(extractBinarySection(res.body, binary));
        setRequirementsPath(res.path);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSection(null);
        setRequirementsPath(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [binary]);

  if (loading) {
    return (
      <div className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2 text-[11px] text-tagma-warning">
        <div className="flex items-center gap-1.5">
          <Terminal size={11} />
          <span>
            <code className="font-mono">{binary}</code> not found in PATH
          </span>
        </div>
        <p className="mt-1 text-[10px] text-tagma-text/70">Loading install instructions…</p>
      </div>
    );
  }

  if (!section || !section.hasContent) {
    return (
      <div className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-tagma-warning">
          <Terminal size={11} />
          <span>
            <code className="font-mono">{binary}</code> not found in PATH
          </span>
        </div>
        <p className="text-[10px] text-tagma-text/70 leading-relaxed">
          Install the CLI, restart the editor so the new PATH is picked up, then re-run the
          pipeline. Open the chat and ask the agent to add install instructions to
          <code className="font-mono"> .requirements.md</code> so this panel can guide the next
          person who hits the same error.
        </p>
        {requirementsPath && (
          <button
            type="button"
            onClick={() => openLocalFilePath(requirementsPath)}
            className="flex items-center gap-1 text-[10px] text-tagma-accent hover:underline"
          >
            <ExternalLink size={10} />
            <span>Open requirements file</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="border border-tagma-warning/30 bg-tagma-warning/5 px-2.5 py-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-tagma-warning">
        <Download size={11} />
        <span>
          <code className="font-mono">{binary}</code> not found on PATH
        </span>
      </div>

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

      {section.verify && (
        <p className="text-[10px] text-tagma-muted/80">
          Verify: <code className="font-mono text-tagma-text/80">{section.verify}</code>
        </p>
      )}

      {requirementsPath && (
        <button
          type="button"
          onClick={() => openLocalFilePath(requirementsPath)}
          className="flex items-center gap-1 text-[10px] text-tagma-accent hover:underline"
        >
          <ExternalLink size={10} />
          <span>Open requirements file</span>
        </button>
      )}

      <p className="text-[10px] text-tagma-muted/80 leading-relaxed">
        After installing, restart this app so the updated PATH is picked up, then re-run the
        pipeline.
      </p>
    </div>
  );
}
