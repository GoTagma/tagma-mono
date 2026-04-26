export { bootstrapBuiltins } from './bootstrap';
export {
  PluginRegistry,
  isValidPluginName,
  PLUGIN_NAME_RE,
  readPluginManifest,
} from '@tagma/core';
export type { RegisteredCapability, RegisterResult } from '@tagma/core';
export type {
  CapabilityHandler,
  PluginCategory,
  PluginCapabilities,
  PluginModule,
  PluginManifest,
  PluginSetupContext,
  TagmaPlugin,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
} from './types';
