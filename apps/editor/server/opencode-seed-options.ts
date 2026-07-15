import { readGlobalSettings } from './global-settings.js';
import { readEditorSettings } from './plugins/loader.js';
import type { SeedOpencodeArtifactsOptions } from './opencode-seed.js';
import type { WorkspaceState } from './workspace-state.js';

/** Build the complete seed configuration at every OpenCode entry point. */
export function buildOpencodeSeedOptions(
  ws: WorkspaceState,
  globalSettingsDir?: string,
): SeedOpencodeArtifactsOptions {
  const editorSettings = readEditorSettings(ws);
  const pythonAgent = editorSettings.pythonAgent;
  return {
    agentMaxSteps: readGlobalSettings(globalSettingsDir).opencodeAgentMaxSteps,
    pythonToolsEnabled: Boolean(
      pythonAgent.enabled && pythonAgent.interpreterCommand && pythonAgent.venvPath,
    ),
  };
}
