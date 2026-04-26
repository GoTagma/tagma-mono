import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type {
  CapabilityHandler,
  PluginCategory,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
  PluginManifest,
  TagmaPlugin,
} from './types';

type PluginType = CapabilityHandler;

const CAPABILITY_CATEGORIES = [
  'drivers',
  'triggers',
  'completions',
  'middlewares',
] as const satisfies readonly PluginCategory[];

const VALID_CATEGORIES: ReadonlySet<PluginCategory> = new Set(CAPABILITY_CATEGORIES);
const PLUGIN_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface RegisteredCapability {
  readonly category: PluginCategory;
  readonly type: string;
  readonly result: RegisterResult;
}

function singularCategory(category: PluginCategory): string {
  switch (category) {
    case 'drivers':
      return 'driver';
    case 'triggers':
      return 'trigger';
    case 'completions':
      return 'completion';
    case 'middlewares':
      return 'middleware';
  }
}

/**
 * Minimal contract enforcement so a malformed plugin fails fast at
 * registration time rather than crashing the engine mid-run.
 *
 * For drivers we materialize `capabilities` and assert each field is a
 * boolean —otherwise a plugin author can write
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
      // Materialize capabilities —this triggers any throwing getter NOW
      // instead of during preflight.
      let caps: unknown;
      try {
        caps = h.capabilities;
      } catch (err) {
        throw new Error(
          `drivers plugin "${h.name}" capabilities accessor threw: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      if (!caps || typeof caps !== 'object') {
        throw new Error(`drivers plugin "${h.name}" must declare capabilities object`);
      }
      const c = caps as Record<string, unknown>;
      for (const field of ['sessionResume', 'systemPrompt', 'outputFormat'] as const) {
        if (typeof c[field] !== 'boolean') {
          throw new Error(
            `drivers plugin "${h.name}".capabilities.${field} must be a boolean (got ${typeof c[field]})`,
          );
        }
      }
      // Optional methods, but if present must be functions.
      for (const opt of ['parseResult', 'resolveModel', 'resolveTools'] as const) {
        if (h[opt] !== undefined && typeof h[opt] !== 'function') {
          throw new Error(`drivers plugin "${h.name}".${opt} must be a function or undefined`);
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
      if (typeof h.enhanceDoc !== 'function') {
        throw new Error(
          `middlewares plugin "${h.name}" must export enhanceDoc()`,
        );
      }
      break;
  }
}

export type RegisterResult = 'registered' | 'replaced' | 'unchanged';

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
 * is a non-empty string). Returns `null` if the field is absent —that
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
      `tagmaPlugin.category must be one of ${[...VALID_CATEGORIES].join(', ')}, got ${JSON.stringify(category)}`,
    );
  }
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`tagmaPlugin.type must be a non-empty string, got ${JSON.stringify(type)}`);
  }
  if (!PLUGIN_TYPE_RE.test(type)) {
    throw new Error(
      `tagmaPlugin.type must match ${PLUGIN_TYPE_RE} (letters, digits, underscores, hyphens; no paths or dots), got ${JSON.stringify(type)}`,
    );
  }
  return { category: category as PluginCategory, type };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTagmaPlugin(value: unknown): value is TagmaPlugin {
  if (!isRecord(value)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  if (value.capabilities !== undefined && !isRecord(value.capabilities)) return false;
  if (value.setup !== undefined && typeof value.setup !== 'function') return false;
  return true;
}

function hasSupportedCapabilityMap(plugin: TagmaPlugin): boolean {
  if (!plugin.capabilities) return false;
  const capabilities = plugin.capabilities as Record<string, unknown>;
  return CAPABILITY_CATEGORIES.some((category) => capabilities[category] !== undefined);
}

function moduleDefaultPlugin(name: string, mod: unknown): TagmaPlugin {
  if (!isRecord(mod) || !isTagmaPlugin(mod.default) || !hasSupportedCapabilityMap(mod.default)) {
    throw new Error(
      `Plugin "${name}" must default-export a TagmaPlugin with capabilities maps`,
    );
  }
  return mod.default;
}

/**
 * Instance-scoped plugin registry. Each workspace in a multi-tenant sidecar
 * owns its own PluginRegistry, so installing/uninstalling a driver in one
 * workspace cannot clobber another.
 */
export class PluginRegistry {
  private readonly registries = {
    drivers: new Map<string, DriverPlugin>(),
    triggers: new Map<string, TriggerPlugin>(),
    completions: new Map<string, CompletionPlugin>(),
    middlewares: new Map<string, MiddlewarePlugin>(),
  };

  /**
   * Register a plugin under (category, type). Returns:
   *   - 'registered' on first registration
   *   - 'replaced'   when an existing entry was overwritten with a different handler
   *   - 'unchanged'  when the same handler instance was already present
   *
   * Throws if `category` is unknown, `type` is empty, or `handler` violates
   * the minimum interface contract for the category.
   */
  registerPlugin<T extends PluginType>(
    category: PluginCategory,
    type: string,
    handler: T,
  ): RegisterResult {
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(`Unknown plugin category "${category}"`);
    }
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(`Plugin type must be a non-empty string (category="${category}")`);
    }
    if (!PLUGIN_TYPE_RE.test(type)) {
      throw new Error(
        `Plugin type "${type}" must match ${PLUGIN_TYPE_RE} (letters, digits, underscores, hyphens; no paths or dots)`,
      );
    }
    validateContract(category, handler);
    const registry = this.registries[category] as Map<string, T>;
    const existing = registry.get(type);
    if (existing === handler) return 'unchanged';
    const wasReplaced = existing !== undefined;
    registry.set(type, handler);
    if (wasReplaced) {
      // D18: surface silent shadowing. Hot-reload flows legitimately replace
      // handlers; installing two different plugin packages that both claim
      // the same (category, type) does not —the second wins and breaks the
      // first's consumers with no audit trail. A console.warn is cheap,
      // respects existing callers that rely on 'replaced', and gives ops a
      // grep-able signal when registrations collide unexpectedly.
      console.warn(
        `[tagma-sdk] registerPlugin: replaced existing ${category}/${type} - ` +
          `check for duplicate plugin packages claiming the same type.`,
      );
    }
    return wasReplaced ? 'replaced' : 'registered';
  }

  registerTagmaPlugin(plugin: TagmaPlugin): RegisteredCapability[] {
    if (!isTagmaPlugin(plugin)) {
      throw new Error('TagmaPlugin must be an object with a non-empty "name"');
    }
    if (!plugin.capabilities) {
      throw new Error(`TagmaPlugin "${plugin.name}" must declare capabilities`);
    }

    const registered: RegisteredCapability[] = [];
    const capabilities = plugin.capabilities as Record<string, unknown>;
    for (const category of CAPABILITY_CATEGORIES) {
      const handlers = capabilities[category];
      if (handlers === undefined) continue;
      if (!isRecord(handlers)) {
        throw new Error(
          `TagmaPlugin "${plugin.name}" capabilities.${category} must be an object map`,
        );
      }
      for (const [type, handler] of Object.entries(handlers)) {
        const result = this.registerPlugin(category, type, handler as PluginType);
        registered.push({ category, type, result });
      }
    }

    if (registered.length === 0) {
      throw new Error(
        `TagmaPlugin "${plugin.name}" must declare at least one supported capability`,
      );
    }
    return registered;
  }

  /**
   * Remove a plugin from the in-process registry. Returns true if a plugin
   * was actually removed. Note: ESM module caching is not affected, so
   * re-importing the same file after unregister will yield the cached module —   * callers wanting a fresh load must restart the host process.
   */
  unregisterPlugin(category: PluginCategory, type: string): boolean {
    if (!VALID_CATEGORIES.has(category)) return false;
    return this.registries[category].delete(type);
  }

  getHandler<T extends PluginType>(category: PluginCategory, type: string): T {
    const handler = this.registries[category].get(type);
    if (!handler) {
      throw new Error(
        `${category} type "${type}" not registered.\n` +
          `Install the plugin: bun add @tagma/${singularCategory(category)}-${type}`,
      );
    }
    return handler as T;
  }

  hasHandler(category: PluginCategory, type: string): boolean {
    return this.registries[category].has(type);
  }

  listRegistered(category: PluginCategory): string[] {
    return [...this.registries[category].keys()];
  }

  /**
   * Load and register a list of plugin packages into this registry.
   *
   * @param pluginNames - Validated npm package names to load.
   * @param resolveFrom - Optional absolute path to resolve plugins from (e.g.
   *   the workspace's working directory). When omitted, the default ESM
   *   resolution uses the SDK's own `node_modules`, which will fail for
   *   plugins installed only in the user's workspace. CLI callers should
   *   pass `process.cwd()` or the workspace root so that workspace-local
   *   plugins resolve correctly.
   */
  async loadPlugins(
    pluginNames: readonly string[],
    resolveFrom?: string,
  ): Promise<void> {
    for (const name of pluginNames) {
      if (!isValidPluginName(name)) {
        throw new Error(
          `Plugin "${name}" rejected: plugin names must be scoped npm packages ` +
            `(e.g. @tagma/trigger-xyz) or tagma-plugin-* packages. ` +
            `Relative/absolute paths are not allowed.`,
        );
      }
      let moduleUrl: string = name;
      if (resolveFrom) {
        // Resolve the package entry point relative to the caller's directory
        // so plugins installed in the workspace's node_modules are found
        // even when the SDK itself lives elsewhere (e.g. a global install
        // or a monorepo sibling package).
        const req = createRequire(resolveFrom.endsWith('/') ? resolveFrom : resolveFrom + '/');
        const resolved = req.resolve(name);
        moduleUrl = pathToFileURL(resolved).href;
      }
      const mod = await import(moduleUrl);
      this.registerTagmaPlugin(moduleDefaultPlugin(name, mod));
    }
  }
}
