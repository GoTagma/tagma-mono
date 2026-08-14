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
  buildChatContextWindowMarker,
  type ChatContextWindowSnapshot,
} from '../../shared/chat-context-window.js';
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
  readonly trialRunSuccess?: boolean;
  readonly trialVerification?:
    'verified' | 'prerequisite-unavailable' | 'not-verified' | 'not-required';
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
  );
  if (typeof summary.trialRunSuccess === 'boolean') {
    lines.push(`    <trial-run-success>${summary.trialRunSuccess}</trial-run-success>`);
  }
  if (summary.trialVerification) {
    lines.push(
      `    <trial-verification>${escapeEditorContextValue(summary.trialVerification)}</trial-verification>`,
    );
  }
  lines.push('  </previous-chat-yaml-reconcile>');
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
    const normalizedAbsPath = absPath.replace(/\\/g, '/');
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
    const displayYaml = directPipelineRoot ? normalizedAbsPath : rel;
    const displayFolder = directPipelineRoot
      ? normalizedAbsPath.slice(0, normalizedAbsPath.lastIndexOf('/'))
      : folder;
    const key = `${displayFolder}\0${displayYaml}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      folder: displayFolder,
      yaml: displayYaml,
      manifest: displayYaml.replace(/\.ya?ml$/i, '.manifest.json'),
      ...(legacyFlat ? { legacyFlat } : {}),
    });
  }
  return entries;
}

function formatWorkspaceYamlFolderEntry(entry: WorkspaceYamlFolderEntry): string[] {
  const legacyAttr = entry.legacyFlat ? ' legacy="flat"' : '';
  return [
    `    <pipeline${legacyAttr}>`,
    `      <folder>${escapeEditorContextValue(entry.folder)}</folder>`,
    `      <yaml>${escapeEditorContextValue(entry.yaml)}</yaml>`,
    `      <manifest>${escapeEditorContextValue(entry.manifest)}</manifest>`,
    '    </pipeline>',
  ];
}

export interface EditorContextOptions {
  workspaceYamlFilePaths?: readonly string[];
  userText?: string;
  currentYamlPath?: string | null;
  chatModel?: {
    readonly providerID: string;
    readonly modelID: string;
  } | null;

  chatYamlStage?: {
    id: string;
    agentTagmaDir: string;
  } | null;
  previousChatYamlReconcile?: ChatYamlReconcileSummary | null;
  /**
   * Frozen context-window policy for this request, embedded as a hidden
   * `<tagma-chat-context-window>` marker. Internal repair continuations pass
   * `null` and inherit the policy of the visible turn they belong to.
   */
  contextWindow?: ChatContextWindowSnapshot | null;
}

export function buildEditorContext(options: EditorContextOptions = {}): string {
  const { workDir, yamlPath, manualNewPipelineYamlPath, yamlRunVersion, registry } =
    usePipelineStore.getState();
  const run = useRunStore.getState();
  const pythonAgent = useEditorSettingsStore.getState().settings?.pythonAgent;
  if (!workDir) return '';
  const lines = [`  <workspace>${escapeEditorContextValue(workDir)}</workspace>`];
  const contextYamlPath =
    options.currentYamlPath === undefined ? yamlPath : options.currentYamlPath;
  const requestContext = {
    currentPipelineIsManualNewDraft: sameChatPath(manualNewPipelineYamlPath, yamlPath),
  };
  const fillManualNewPipelineAction = fillManualNewPipelineRequestedActionLines(
    options.userText,
    requestContext,
  );
  const createNewPipelineAction = createNewPipelineRequestedActionLines(
    options.userText,
    requestContext,
  );
  lines.push(...fillManualNewPipelineAction, ...createNewPipelineAction);
  if (
    (fillManualNewPipelineAction.length > 0 || createNewPipelineAction.length > 0) &&
    options.chatModel
  ) {
    const providerID = options.chatModel.providerID.trim();
    const modelID = options.chatModel.modelID.trim();
    if (providerID && modelID) {
      lines.push(
        `  <opencode-chat-model provider-id="${escapeEditorContextValue(providerID)}" model-id="${escapeEditorContextValue(modelID)}" />`,
      );
    }
  }
  if (options.chatYamlStage) {
    const agentRoot = options.chatYamlStage.agentTagmaDir.replace(/\\/g, '/');
    lines.push(`  <chat-staging id="${escapeEditorContextValue(options.chatYamlStage.id)}">`);
    lines.push(`    <agent-root>${escapeEditorContextValue(agentRoot)}</agent-root>`);
    lines.push(
      '    <write-policy>Agent-root is the sole filesystem read/write boundary for this staged turn. Do not inspect or access live workspace paths outside agent-root.</write-policy>',
      '  </chat-staging>',
    );
  }
  if (options.previousChatYamlReconcile) {
    lines.push(...previousChatYamlReconcileLines(options.previousChatYamlReconcile));
  }
  if (options.contextWindow) {
    lines.push(`  ${buildChatContextWindowMarker(options.contextWindow)}`);
  }
  if (contextYamlPath) {
    const rel = workspaceRelativePath(
      options.chatYamlStage?.agentTagmaDir ?? workDir,
      contextYamlPath,
    );
    const targetPath = options.chatYamlStage ? contextYamlPath.replace(/\\/g, '/') : rel;
    if (rel && targetPath) {
      lines.push(`  <current-file>${escapeEditorContextValue(targetPath)}</current-file>`);
    }
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
    lines.push(`    <interpreter>${escapeEditorContextValue(interpreter)}</interpreter>`);
    if (pythonAgent.interpreterVersion) {
      lines.push(
        `    <version>${escapeEditorContextValue(pythonAgent.interpreterVersion)}</version>`,
      );
    }
    lines.push(`    <venv>${escapeEditorContextValue(pythonAgent.venvPath)}</venv>`);
    lines.push('  </python-agent>');
  } else {
    const reason = pythonAgent?.enabled ? 'incomplete' : 'not-configured';
    lines.push(`  <python-agent enabled="false" reason="${escapeEditorContextValue(reason)}">`);
    lines.push(
      '    <action>Enable Python AI Agent in Editor Settings before creating Python helpers.</action>',
    );
    lines.push('  </python-agent>');
  }
  const pluginLines: string[] = [];
  const fmt = (xs: readonly string[]) => escapeEditorContextValue(xs.join(', '));
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
