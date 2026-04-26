export { bootstrapBuiltins } from './bootstrap';
export {
  PluginRegistry,
  isValidPluginName,
  PLUGIN_NAME_RE,
  readPluginManifest,
} from './registry';
export type { RegisterResult } from './registry';
export type {
  PluginCategory,
  PluginModule,
  PluginManifest,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
} from './types';

