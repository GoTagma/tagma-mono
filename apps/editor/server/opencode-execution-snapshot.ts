import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { PreparedManagedOpencodeDatabase } from './opencode-database.js';
import { resolveOpencodeRuntimePaths } from './opencode-config.js';
import { buildOpencodeInheritedEnv } from './opencode-host-env.js';
import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { createStreamingLoopbackFetch } from './loopback-fetch.js';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(value);
}
function fail(code: string): never {
  throw new Error(`Managed OpenCode effort resolution failed (${code}).`);
}

/** Only model/variant identifiers leave the private native catalog boundary. */
export function projectManagedOpencodeVariantIds(
  value: unknown,
): ReadonlyMap<string, readonly string[]> {
  const providers = record(value)?.providers;
  if (!Array.isArray(providers)) return fail('catalog_unavailable');
  const models = new Map<string, readonly string[]>();
  for (const rawProvider of providers) {
    const provider = record(rawProvider);
    if (!provider || !safeId(provider.id)) continue;
    for (const [modelId, rawModel] of Object.entries(record(provider.models) ?? {})) {
      const model = record(rawModel);
      if (!safeId(modelId) || !model || model.disabled === true) continue;
      const variants = Object.entries(record(model.variants) ?? {})
        .filter(([id, options]) => safeId(id) && record(options)?.disabled !== true)
        .map(([id]) => id);
      models.set(`${provider.id}/${modelId}`, Object.freeze(variants));
    }
  }
  return models;
}

export function resolveManagedOpencodeVariant(
  models: ReadonlyMap<string, readonly string[]>,
  model: string,
  effort: string | undefined,
): string | null {
  // Portable medium deliberately means the provider default, as in the public SDK.
  if (effort === undefined || effort === 'medium') return null;
  const enabled = models.get(model);
  if (!enabled) return fail('model_unavailable');
  if (effort === 'low') {
    if (enabled.includes('minimal')) return 'minimal';
    if (enabled.includes('low')) return 'low';
    return fail('low_variant_unavailable');
  }
  if (!safeId(effort) || !enabled.includes(effort)) return fail('variant_unavailable');
  return effort;
}

function fingerprint(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object)
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const PLATFORM_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
  'LANG',
  'LC_ALL',
]);
function providerEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(buildOpencodeInheritedEnv(env)).filter(([key]) => !PLATFORM_ENV_KEYS.has(key)),
  );
}

/** Private identity covers native config discovery and interpolation inputs, never DB schema ids. */
export function captureManagedOpencodeConfigIdentity(
  cwd: string,
  env: Readonly<Record<string, string>>,
): () => void {
  const paths = resolveOpencodeRuntimePaths(cwd);
  const files = new Map<string, string>();
  const captureFile = (path: string) => {
    try {
      files.set(path, existsSync(path) ? fingerprint(readFileSync(path)) : 'absent');
    } catch {
      return fail('configuration_unavailable');
    }
  };
  captureFile(paths.globalConfigPath);
  captureFile(join(paths.configDir, 'config.json'));
  captureFile(join(paths.configDir, 'opencode.jsonc'));
  captureFile(paths.workspaceConfigPath);
  captureFile(join(paths.dataHome, 'opencode', 'auth.json'));
  // Keep referenced bytes in the generation identity. Relative references are not
  // accepted for catalog binding until their native load coordinate can be proven.
  const content = env.OPENCODE_CONFIG_CONTENT ?? '';
  for (const match of content.matchAll(/\{file:([^}]+)\}/gu)) {
    const path = match[1].startsWith('~/')
      ? resolve(env.HOME, match[1].slice(2))
      : isAbsolute(match[1])
        ? match[1]
        : resolve(cwd, match[1]);
    captureFile(path);
  }
  const inherited = fingerprint(canonical(providerEnv(env)));
  return () => {
    if (fingerprint(canonical(providerEnv(process.env))) !== inherited)
      return fail('provider_environment_changed');
    for (const [path, expected] of files) {
      try {
        if ((existsSync(path) ? fingerprint(readFileSync(path)) : 'absent') !== expected)
          return fail('configuration_changed');
      } catch {
        return fail('configuration_changed');
      }
    }
  };
}

function interpolatedProviderConfig(env: Readonly<Record<string, string>>): unknown {
  const interpolate = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replace(/\{(env|file):([^}]+)\}/gu, (_match, kind: string, name: string) => {
        if (kind === 'env') return env[name] ?? '';
        // Native relative file expansion depends on the original config file.
        // Fail closed rather than reuse a catalog from an unproven coordinate.
        if (!isAbsolute(name)) return fail('configuration_reference_unverified');
        try {
          return readFileSync(name, 'utf8').trim();
        } catch {
          return fail('configuration_reference_unavailable');
        }
      });
    if (Array.isArray(value)) return value.map(interpolate);
    const object = record(value);
    return object
      ? Object.fromEntries(Object.entries(object).map(([key, item]) => [key, interpolate(item)]))
      : value;
  };
  try {
    return interpolate(record(JSON.parse(env.OPENCODE_CONFIG_CONTENT))?.provider ?? {});
  } catch {
    return fail('configuration_identity_unverified');
  }
}

/** One pair of unpaid native metadata reads for one run's process generation. */
export async function readManagedOpencodeExecutionCatalog(
  handle: { baseUrl: string; cwd: string; auth: { authorization: string } },
  startupEnv: Readonly<Record<string, string>>,
): Promise<unknown> {
  const client = createOpencodeClient({
    baseUrl: handle.baseUrl,
    directory: handle.cwd,
    headers: { Authorization: handle.auth.authorization },
    throwOnError: true,
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
  });
  try {
    const signal = AbortSignal.timeout(10_000);
    const [configuration, catalog] = await Promise.all([
      client.config.get({ signal }),
      client.config.providers({ signal }),
    ]);
    if (
      configuration.error !== undefined ||
      catalog.error !== undefined ||
      !configuration.data ||
      !catalog.data
    )
      return fail('catalog_unavailable');
    if (
      canonical(configuration.data.provider ?? {}) !==
      canonical(interpolatedProviderConfig(startupEnv))
    )
      return fail('configuration_identity_mismatch');
    return catalog.data;
  } catch {
    return fail('catalog_identity_unavailable');
  }
}

export interface ManagedOpencodeExecutionSnapshot {
  resolveVariant(model: string, effort: string | undefined): string | null;
  assertCurrent(): void;
  childEnvironment(
    database: PreparedManagedOpencodeDatabase,
    injected?: Readonly<Record<string, string>>,
  ): Record<string, string>;
  assertCompatibleBase(env: Readonly<Record<string, string>>): void;
}

export function createManagedOpencodeExecutionSnapshot(
  startupEnv: Readonly<Record<string, string>>,
  configuredProviders: unknown,
  assertCurrent: () => void,
): ManagedOpencodeExecutionSnapshot {
  const models = projectManagedOpencodeVariantIds(configuredProviders);
  const pinned = { ...startupEnv };
  delete pinned.OPENCODE_SERVER_USERNAME;
  delete pinned.OPENCODE_SERVER_PASSWORD;
  const relevant = providerEnv(pinned);
  const providerReferences = [
    ...(pinned.OPENCODE_CONFIG_CONTENT ?? '').matchAll(/\{env:([^}]+)\}/gu),
  ].map((match) => match[1]);
  return {
    assertCurrent,
    resolveVariant(model, effort) {
      assertCurrent();
      return resolveManagedOpencodeVariant(models, model, effort);
    },
    assertCompatibleBase(env) {
      if (
        canonical(providerEnv(env)) !== canonical(relevant) ||
        canonical(interpolatedProviderConfig(env)) !== canonical(interpolatedProviderConfig(pinned))
      )
        return fail('run_provider_configuration_changed');
    },
    childEnvironment(database, injected) {
      assertCurrent();
      for (const [key, value] of Object.entries(providerEnv(injected ?? {}))) {
        if (relevant[key] !== value) return fail('task_provider_environment_mismatch');
      }
      for (const key of providerReferences) {
        if (
          injected &&
          Object.prototype.hasOwnProperty.call(injected, key) &&
          injected[key] !== pinned[key]
        )
          return fail('task_provider_reference_mismatch');
      }
      return { ...pinned, OPENCODE_DB: database.databasePath };
    },
  };
}
