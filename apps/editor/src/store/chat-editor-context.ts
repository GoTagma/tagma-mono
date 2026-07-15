/**
 * Build the per-turn `<editor-context>` block prepended to every user message.
 *
 * The Tagma router agent's system prompt (`.opencode/agents/tagma-router.md`)
 * treats this block as the authoritative source for the user's current editor
 * state, and ChatPanel strips it before display so the user never sees the
 * prefix.
 *
 * Re-read on every send rather than cached: yamlPath/workDir live in the
 * pipeline store and change as the user opens, switches, or closes pipelines.
 */
import { usePipelineStore } from './pipeline-store';
import { useRunStore } from './run-store';
import { useEditorSettingsStore } from './editor-settings-store';
import type { ChatYamlStageConflict } from '../api/client';
import {
  createNewPipelineRequestedActionLines,
  fillManualNewPipelineRequestedActionLines,
} from '../../shared/requested-action.js';

function normalizeChatPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsStylePath(normalized) ? normalized.toLowerCase() : normalized;
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function sameChatPath(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeChatPath(a);
  const right = normalizeChatPath(b);
  return !!left && !!right && left === right;
}

function workspaceRelativePath(workDir: string, absPath: string | null | undefined): string | null {
  if (!workDir || !absPath) return null;
  const w = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = absPath.replace(/\\/g, '/');
  if (a.startsWith(w + '/')) return a.slice(w.length + 1);
  if (a.toLowerCase().startsWith(w.toLowerCase() + '/')) return a.slice(w.length + 1);
  return null;
}

interface WorkspaceYamlFolderEntry {
  readonly folder: string;
  readonly yaml: string;
  readonly manifest: string;
  readonly legacyFlat?: boolean;
}

export interface ChatYamlReconcileSummary {
  readonly outcome: 'unchanged' | 'adopted' | 'forked' | 'created';
  readonly conflicts: readonly ChatYamlStageConflict[];
  readonly localBranchPersisted: boolean;
  readonly resultPath: string | null;
  readonly compileSuccess: boolean;
}

function escapeEditorContextValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function previousChatYamlReconcileLines(summary: ChatYamlReconcileSummary): string[] {
  const lines = [
    '  <previous-chat-yaml-reconcile>',
    `    <outcome>${escapeEditorContextValue(summary.outcome)}</outcome>`,
  ];
  if (summary.conflicts.length) {
    lines.push(
      '    <conflicts>',
      ...summary.conflicts.map(
        (conflict) => `      <conflict>${escapeEditorContextValue(conflict)}</conflict>`,
      ),
      '    </conflicts>',
    );
  } else {
    lines.push('    <conflicts empty="true" />');
  }
  lines.push(
    `    <local-branch-persisted>${summary.localBranchPersisted}</local-branch-persisted>`,
    summary.resultPath
      ? `    <result-path>${escapeEditorContextValue(summary.resultPath)}</result-path>`
      : '    <result-path unavailable="true" />',
    `    <compile-success>${summary.compileSuccess}</compile-success>`,
    '  </previous-chat-yaml-reconcile>',
  );
  return lines;
}

function workspaceRelativeYamlFolderEntries(
  pipelineRoot: string,
  absPaths: readonly string[] | undefined,
  directPipelineRoot = false,
): WorkspaceYamlFolderEntry[] {
  if (!absPaths?.length) return [];
  const seen = new Set<string>();
  const entries: WorkspaceYamlFolderEntry[] = [];
  for (const absPath of absPaths) {
    const rel = workspaceRelativePath(pipelineRoot, absPath);
    if (!rel || !/\.ya?ml$/i.test(rel)) continue;
    const parts = rel.split('/');
    let folder: string;
    let legacyFlat = false;
    if (directPipelineRoot && parts.length >= 2) {
      folder = parts.slice(0, -1).join('/');
    } else if (directPipelineRoot && parts.length === 1) {
      folder = '.';
      legacyFlat = true;
    } else if (parts.length >= 3) {
      folder = parts.slice(0, -1).join('/');
    } else if (parts.length === 2 && parts[0] === '.tagma') {
      folder = parts[0];
      legacyFlat = true;
    } else {
      continue;
    }
    const key = `${folder}\0${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      folder,
      yaml: rel,
      manifest: rel.replace(/\.ya?ml$/i, '.manifest.json'),
      ...(legacyFlat ? { legacyFlat } : {}),
    });
  }
  return entries;
}

function formatWorkspaceYamlFolderEntry(entry: WorkspaceYamlFolderEntry): string[] {
  const legacyAttr = entry.legacyFlat ? ' legacy="flat"' : '';
  return [
    `    <pipeline${legacyAttr}>`,
    `      <folder>${entry.folder}</folder>`,
    `      <yaml>${entry.yaml}</yaml>`,
    `      <manifest>${entry.manifest}</manifest>`,
    '    </pipeline>',
  ];
}

export interface EditorContextOptions {
  workspaceYamlFilePaths?: readonly string[];
  userText?: string;
  currentYamlPath?: string | null;
  chatYamlStage?: {
    id: string;
    agentTagmaDir: string;
  } | null;
  previousChatYamlReconcile?: ChatYamlReconcileSummary | null;
}

export function buildEditorContext(options: EditorContextOptions = {}): string {
  const { workDir, yamlPath, manualNewPipelineYamlPath, yamlRunVersion, registry } =
    usePipelineStore.getState();
  const run = useRunStore.getState();
  const pythonAgent = useEditorSettingsStore.getState().settings?.pythonAgent;
  if (!workDir) return '';
  const lines = [`  <workspace>${workDir}</workspace>`];
  const contextYamlPath =
    options.currentYamlPath === undefined ? yamlPath : options.currentYamlPath;
  const requestContext = {
    currentPipelineIsManualNewDraft: sameChatPath(manualNewPipelineYamlPath, yamlPath),
  };
  lines.push(...fillManualNewPipelineRequestedActionLines(options.userText, requestContext));
  lines.push(...createNewPipelineRequestedActionLines(options.userText, requestContext));
  if (options.chatYamlStage) {
    const agentRoot = options.chatYamlStage.agentTagmaDir.replace(/\\/g, '/');
    lines.push(`  <chat-staging id="${options.chatYamlStage.id}">`);
    lines.push(`    <agent-root>${agentRoot}</agent-root>`);
    lines.push(
      '    <write-policy>Write pipeline artifacts only inside agent-root. Live .tagma pipeline paths are read-only source material.</write-policy>',
      '  </chat-staging>',
    );
  }
  if (options.previousChatYamlReconcile) {
    lines.push(...previousChatYamlReconcileLines(options.previousChatYamlReconcile));
  }
  if (contextYamlPath) {
    const rel = workspaceRelativePath(
      options.chatYamlStage?.agentTagmaDir ?? workDir,
      contextYamlPath,
    );
    if (rel) lines.push(`  <current-file>${rel}</current-file>`);
    lines.push(`  <yaml-run-version>${yamlRunVersion ?? 0}</yaml-run-version>`);
  }
  const workspaceYamlFolders = workspaceRelativeYamlFolderEntries(
    options.chatYamlStage?.agentTagmaDir ?? workDir,
    options.workspaceYamlFilePaths,
    !!options.chatYamlStage,
  );
  if (workspaceYamlFolders.length) {
    lines.push(
      '  <workspace-yaml-folders>',
      ...workspaceYamlFolders.flatMap(formatWorkspaceYamlFolderEntry),
      '  </workspace-yaml-folders>',
    );
  } else if (options.workspaceYamlFilePaths !== undefined) {
    lines.push('  <workspace-yaml-folders empty="true" />');
  } else {
    lines.push('  <workspace-yaml-folders unavailable="true" />');
  }
  const currentFileRunning =
    (run.status === 'starting' || run.status === 'running') && sameChatPath(run.yamlPath, yamlPath);
  if (currentFileRunning) {
    lines.push(
      '  <pipeline-availability protected="true" reason="running">',
      '    <allowed>general discussion; create a new pipeline; edit a different existing pipeline</allowed>',
      '    <unrestricted>Switch to another pipeline or create a new one before unrestricted chat work.</unrestricted>',
      '  </pipeline-availability>',
    );
  }
  if (pythonAgent?.enabled && pythonAgent.interpreterCommand && pythonAgent.venvPath) {
    const interpreter = [pythonAgent.interpreterCommand, ...pythonAgent.interpreterArgs].join(' ');
    lines.push('  <python-agent enabled="true">');
    lines.push(`    <interpreter>${interpreter}</interpreter>`);
    if (pythonAgent.interpreterVersion) {
      lines.push(`    <version>${pythonAgent.interpreterVersion}</version>`);
    }
    lines.push(`    <venv>${pythonAgent.venvPath}</venv>`);
    lines.push('  </python-agent>');
  } else {
    const reason = pythonAgent?.enabled ? 'incomplete' : 'not-configured';
    lines.push(`  <python-agent enabled="false" reason="${reason}">`);
    lines.push(
      '    <action>Enable Python AI Agent in Editor Settings before creating Python helpers.</action>',
    );
    lines.push('  </python-agent>');
  }
  const pluginLines: string[] = [];
  const fmt = (xs: readonly string[]) => xs.join(', ');
  if (registry.drivers.length) pluginLines.push(`    <drivers>${fmt(registry.drivers)}</drivers>`);
  if (registry.triggers.length)
    pluginLines.push(`    <triggers>${fmt(registry.triggers)}</triggers>`);
  if (registry.completions.length)
    pluginLines.push(`    <completions>${fmt(registry.completions)}</completions>`);
  if (registry.middlewares.length)
    pluginLines.push(`    <middlewares>${fmt(registry.middlewares)}</middlewares>`);
  if (pluginLines.length) {
    lines.push('  <plugins>', ...pluginLines, '  </plugins>');
  }
  return `<editor-context>\n${lines.join('\n')}\n</editor-context>\n\n`;
}
