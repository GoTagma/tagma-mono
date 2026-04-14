import type {
  PluginCategory, DriverPlugin, TriggerPlugin,
  CompletionPlugin, MiddlewarePlugin, PluginManifest,
} from './types';

type PluginType = DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;

const VALID_CATEGORIES: ReadonlySet<PluginCategory> = new Set([
  'drivers', 'triggers', 'completions', 'middlewares',
]);

const registries = {
  drivers:     new Map<string, DriverPlugin>(),
  triggers:    new Map<string, TriggerPlugin>(),
  completions: new Map<string, CompletionPlugin>(),
  middlewares: new Map<string, MiddlewarePlugin>(),
};

/**
 * Minimal contract enforcement so a malformed plugin fails fast at
 * registration time rather than crashing the engine mid-run.
 *
 * For drivers we materialize `capabilities` and assert each field is a
 * boolean — otherwise a plugin author can write
 *     get capabilities() { throw new Error('boom') }
 * and pass the basic typeof check, then crash preflight when the engine
 * touches `driver.capabilities.sessionResume`. (R8)
 */
function validateContract(category: PluginCategory, handler: unknown): void {
  if (!handler || typeof handler !== 'object') {
    throw new Error(`Plugin handler for category "${category}" must be an object`);
  }
  const h = handler as Record<string, unknown>;
  if (typeof h.name !== 'string' || h.name.length === 0) {
    throw new Error(`Plugin handler for category "${category}" must declare a non-empty "name"`);
  }
  switch (category) {
    case 'drivers': {
      if (typeof h.buildCommand !== 'function') {
        throw new Error(`drivers plugin "${h.name}" must export buildCommand()`);
      }
      // Materialize capabilities — this triggers any throwing getter NOW
      // instead of during preflight.
      let caps: unknown;
      try {
        caps = h.capabilities;
      } catch (err) {
        throw new Error(
          `drivers plugin "${h.name}" capabilities accessor threw: ` +
          (err instanceof Error ? err.message : String(err))
        );
      }
      if (!caps || typeof caps !== 'object') {
        throw new Error(`drivers plugin "${h.name}" must declare capabilities object`);
      }
      const c = caps as Record<string, unknown>;
      for (const field of ['sessionResume', 'systemPrompt', 'outputFormat'] as const) {
        if (typeof c[field] !== 'boolean') {
          throw new Error(
            `drivers plugin "${h.name}".capabilities.${field} must be a boolean (got ${typeof c[field]})`
          );
        }
      }
      // Optional methods, but if present must be functions.
      for (const opt of ['parseResult', 'resolveModel', 'resolveTools'] as const) {
        if (h[opt] !== undefined && typeof h[opt] !== 'function') {
          throw new Error(
            `drivers plugin "${h.name}".${opt} must be a function or undefined`
          );
        }
      }
      break;
    }
    case 'triggers':
      if (typeof h.watch !== 'function') {
        throw new Error(`triggers plugin "${h.name}" must export watch()`);
      }
      break;
    case 'completions':
      if (typeof h.check !== 'function') {
        throw new Error(`completions plugin "${h.name}" must export check()`);
      }
      break;
    case 'middlewares':
      if (typeof h.enhance !== 'function') {
        throw new Error(`middlewares plugin "${h.name}" must export enhance()`);
      }
      break;
  }
}

export type RegisterResult = 'registered' | 'replaced' | 'unchanged';

/**
 * Register a plugin under (category, type). Returns:
 *   - 'registered' on first registration
 *   - 'replaced'   when an existing entry was overwritten with a different handler
 *   - 'unchanged'  when the same handler instance was already present
 *
 * Throws if `category` is unknown, `type` is empty, or `handler` violates the
 * minimum interface contract for the category.
 */
export function registerPlugin<T extends PluginType>(
  category: PluginCategory, type: string, handler: T,
): RegisterResult {
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(`Unknown plugin category "${category}"`);
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`Plugin type must be a non-empty string (category="${category}")`);
  }
  validateContract(category, handler);
  const registry = registries[category] as Map<string, T>;
  const existing = registry.get(type);
  if (existing === handler) return 'unchanged';
  const wasReplaced = existing !== undefined;
  registry.set(type, handler);
  return wasReplaced ? 'replaced' : 'registered';
}

/**
 * Remove a plugin from the in-process registry. Returns true if a plugin
 * was actually removed. Note: ESM module caching is not affected, so
 * re-importing the same file after unregister will yield the cached module —
 * callers wanting a fresh load must restart the host process.
 */
export function unregisterPlugin(category: PluginCategory, type: string): boolean {
  if (!VALID_CATEGORIES.has(category)) return false;
  return registries[category].delete(type);
}

export function getHandler<T extends PluginType>(
  category: PluginCategory, type: string,
): T {
  const handler = registries[category].get(type);
  if (!handler) {
    throw new Error(
      `${category} type "${type}" not registered.\n` +
      `Install the plugin: bun add @tagma/${category.replace(/s$/, '')}-${type}`
    );
  }
  return handler as T;
}

export function hasHandler(category: PluginCategory, type: string): boolean {
  return registries[category].has(type);
}

// Plugin name must be a scoped npm package or a tagma-prefixed package.
// Reject absolute/relative paths and suspicious patterns to prevent
// arbitrary code execution via crafted YAML configs.
export const PLUGIN_NAME_RE = /^(@[a-z0-9-]+\/[a-z0-9._-]+|tagma-plugin-[a-z0-9._-]+)$/;

export function isValidPluginName(name: unknown): name is string {
  return typeof name === 'string' && PLUGIN_NAME_RE.test(name);
}

/**
 * Parse and validate the `tagmaPlugin` field of a `package.json` blob.
 *
 * Returns the strongly-typed manifest if the field is present and
 * well-formed (`category` is one of the four known categories and `type`
 * is a non-empty string). Returns `null` if the field is absent — that
 * is the host's signal that the package is a library, not a plugin.
 *
 * Throws if the field is present but malformed: that's a packaging bug
 * the plugin author should hear about loudly, not a silent skip.
 *
 * Hosts use this during auto-discovery to decide whether to load a
 * package as a plugin without having to dynamically `import()` it.
 */
export function readPluginManifest(pkgJson: unknown): PluginManifest | null {
  if (!pkgJson || typeof pkgJson !== 'object') return null;
  const raw = (pkgJson as Record<string, unknown>).tagmaPlugin;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object') {
    throw new Error('tagmaPlugin field must be an object with { category, type }');
  }
  const m = raw as Record<string, unknown>;
  const category = m.category;
  const type = m.type;
  if (typeof category !== 'string' || !VALID_CATEGORIES.has(category as PluginCategory)) {
    throw new Error(
      `tagmaPlugin.category must be one of ${[...VALID_CATEGORIES].join(', ')}, got ${JSON.stringify(category)}`
    );
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`tagmaPlugin.type must be a non-empty string, got ${JSON.stringify(type)}`);
  }
  return { category: category as PluginCategory, type };
}

export async function loadPlugins(pluginNames: readonly string[]): Promise<void> {
  for (const name of pluginNames) {
    if (!isValidPluginName(name)) {
      throw new Error(
        `Plugin "${name}" rejected: plugin names must be scoped npm packages ` +
        `(e.g. @tagma/trigger-xyz) or tagma-plugin-* packages. ` +
        `Relative/absolute paths are not allowed.`
      );
    }
    const mod = await import(name);
    if (!mod.pluginCategory || !mod.pluginType || !mod.default) {
      throw new Error(
        `Plugin "${name}" must export pluginCategory, pluginType, and default`
      );
    }
    registerPlugin(mod.pluginCategory, mod.pluginType, mod.default);
  }
}

export function listRegistered(category: PluginCategory): string[] {
  return [...registries[category].keys()];
}
