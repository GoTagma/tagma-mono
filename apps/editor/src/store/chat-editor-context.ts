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

function workspaceRelativeYamlFolderEntries(
  workDir: string,
  absPaths: readonly string[] | undefined,
): WorkspaceYamlFolderEntry[] {
  if (!absPaths?.length) return [];
  const seen = new Set<string>();
  const entries: WorkspaceYamlFolderEntry[] = [];
  for (const absPath of absPaths) {
    const rel = workspaceRelativePath(workDir, absPath);
    if (!rel || !/\.ya?ml$/i.test(rel)) continue;
    const parts = rel.split('/');
    let folder: string;
    let legacyFlat = false;
    if (parts.length >= 3) {
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
}

export function buildEditorContext(options: EditorContextOptions = {}): string {
  const { workDir, yamlPath, manualNewPipelineYamlPath, yamlRunVersion, registry } =
    usePipelineStore.getState();
  const run = useRunStore.getState();
  const pythonAgent = useEditorSettingsStore.getState().settings?.pythonAgent;
  if (!workDir) return '';
  const lines = [`  <workspace>${workDir}</workspace>`];
  const requestContext = {
    currentPipelineIsManualNewDraft: sameChatPath(manualNewPipelineYamlPath, yamlPath),
  };
  lines.push(...fillManualNewPipelineRequestedActionLines(options.userText, requestContext));
  lines.push(...createNewPipelineRequestedActionLines(options.userText, requestContext));
  if (yamlPath) {
    const rel = workspaceRelativePath(workDir, yamlPath);
    if (rel) lines.push(`  <current-file>${rel}</current-file>`);
    lines.push(`  <yaml-run-version>${yamlRunVersion ?? 0}</yaml-run-version>`);
  }
  const workspaceYamlFolders = workspaceRelativeYamlFolderEntries(
    workDir,
    options.workspaceYamlFilePaths,
  );
  if (workspaceYamlFolders.length) {
    lines.push(
      '  <workspace-yaml-folders>',
      ...workspaceYamlFolders.flatMap(formatWorkspaceYamlFolderEntry),
      '  </workspace-yaml-folders>',
    );
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
