export { bootstrapBuiltins } from './bootstrap';
export { PluginRegistry, isValidPluginName, PLUGIN_NAME_RE, readPluginManifest } from '@tagma/core';
export type { RegisteredCapability, RegisterPluginOptions, RegisterResult } from '@tagma/core';
export type {
  CapabilityHandler,
  PluginCategory,
  PluginCapabilities,
  PluginModule,
  PluginManifest,
  TagmaPlugin,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
} from '@tagma/types';
