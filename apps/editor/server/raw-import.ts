import { parseYaml } from '@tagma/sdk/yaml';
import type { RawPipelineConfig } from '@tagma/sdk';
import type { WorkspaceState } from './workspace-state.js';

export function importRawYamlIntoWorkspace(
  ws: WorkspaceState,
  yaml: string,
  normalize: (config: RawPipelineConfig) => RawPipelineConfig = (config) => config,
): void {
  ws.config = normalize(parseYaml(yaml));
  ws.yamlPath = null;
  ws.manualNewPipelineYamlPath = null;
  ws.layout = { positions: {} };
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
}
