import { isValidPluginName, readPluginManifest as parsePluginManifestField } from '@tagma/sdk';
import type { PluginCategory } from '@tagma/sdk';
import { NPM_REGISTRY, REGISTRY_FETCH_TIMEOUT_MS, registryUrl } from './install.js';

// ── Plugin marketplace (npm registry proxy) ──
//
// The marketplace UI searches the public npm registry for packages that are
// tagged with `keywords:tagma-plugin`, then verifies each candidate by
// fetching its real `package.json` and reading the SDK-defined `tagmaPlugin`
// field. Packages that claim the keyword but don't declare a valid
// `tagmaPlugin` manifest are discarded so the UI only ever shows real
// plugins.
//
// The search results and per-package details are cached in-memory with a
// short TTL. This keeps keystroke-driven search responsive and shields
// the upstream registry from rate-limit pressure.

export const NPM_SEARCH_URL = `${NPM_REGISTRY}/-/v1/search`;
export const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads/point/last-week';
export const MARKETPLACE_CACHE_TTL_MS = 5 * 60 * 1000;
export const MARKETPLACE_SEARCH_LIMIT = 50;
export const MARKETPLACE_CONCURRENCY = 8;
export const VALID_PLUGIN_CATEGORIES: ReadonlySet<PluginCategory> = new Set([
  'drivers',
  'triggers',
  'completions',
  'middlewares',
]);

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function makeCache<T>(): Map<string, CacheEntry<T>> {
  return new Map<string, CacheEntry<T>>();
}

export function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + MARKETPLACE_CACHE_TTL_MS });
}

export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string | null;
  category: PluginCategory;
  type: string;
  keywords: string[];
  author: string | null;
  date: string | null;
  homepage: string | null;
  repository: string | null;
  weeklyDownloads: number | null;
}

export interface MarketplacePackageDetail extends MarketplaceEntry {
  readme: string | null;
  license: string | null;
  versions: string[];
}

export const marketplaceSearchCache = makeCache<MarketplaceEntry[]>();
export const marketplacePackageCache = makeCache<MarketplacePackageDetail>();
export const marketplaceDownloadsCache = makeCache<number | null>();
export const marketplaceManifestCache = makeCache<MarketplacePackageDetail>();

function coerceAuthor(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}

function coerceRepository(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const url = (raw as { url?: unknown }).url;
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

/**
 * Fetch weekly downloads for a package. Returns null if the call fails or
 * the package is not yet indexed — the UI treats null as "unknown" rather
 * than "zero" so unranked plugins are not visually penalized.
 */
export async function fetchWeeklyDownloads(name: string): Promise<number | null> {
  const cached = cacheGet(marketplaceDownloadsCache, name);
  if (cached !== null) return cached;
  try {
    const url = `${NPM_DOWNLOADS_URL}/${name}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      cacheSet(marketplaceDownloadsCache, name, null);
      return null;
    }
    const body = (await res.json()) as { downloads?: unknown; error?: unknown };
    if (typeof body.downloads === 'number' && Number.isFinite(body.downloads)) {
      cacheSet(marketplaceDownloadsCache, name, body.downloads);
      return body.downloads;
    }
    cacheSet(marketplaceDownloadsCache, name, null);
    return null;
  } catch {
    cacheSet(marketplaceDownloadsCache, name, null);
    return null;
  }
}

/**
 * Fetch a package's full manifest from the registry, validate that its
 * `tagmaPlugin` field exists and is well-formed, and shape it into a
 * MarketplacePackageDetail. Returns null when the package is absent, not a
 * valid plugin, or otherwise unusable.
 */
export async function fetchMarketplacePackage(
  name: string,
): Promise<MarketplacePackageDetail | null> {
  if (!isValidPluginName(name)) return null;
  const cached = cacheGet(marketplaceManifestCache, name);
  if (cached) return cached;
  let body: Record<string, unknown>;
  try {
    const res = await fetch(registryUrl(name), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const distTags = body?.['dist-tags'] as Record<string, string> | undefined;
  const latest = distTags?.latest;
  if (typeof latest !== 'string') return null;
  const versions = body?.versions as Record<string, Record<string, unknown>> | undefined;
  const versionEntry = versions?.[latest];
  if (!versionEntry || typeof versionEntry !== 'object') return null;
  let manifest;
  try {
    manifest = parsePluginManifestField(versionEntry);
  } catch {
    // Malformed tagmaPlugin field — plugin authors should hear about this
    // but it's not worth surfacing to marketplace users. Drop it quietly.
    return null;
  }
  if (!manifest || !VALID_PLUGIN_CATEGORIES.has(manifest.category)) return null;
  const downloads = await fetchWeeklyDownloads(name);
  const time = (body?.time ?? {}) as Record<string, string>;
  const detail: MarketplacePackageDetail = {
    name,
    version: latest,
    description: typeof versionEntry.description === 'string' ? versionEntry.description : null,
    category: manifest.category,
    type: manifest.type,
    keywords: coerceStringArray(versionEntry.keywords),
    author: coerceAuthor(versionEntry.author),
    date: typeof time[latest] === 'string' ? time[latest] : null,
    homepage: typeof versionEntry.homepage === 'string' ? versionEntry.homepage : null,
    repository: coerceRepository(versionEntry.repository),
    weeklyDownloads: downloads,
    readme: typeof body.readme === 'string' ? body.readme : null,
    license: typeof versionEntry.license === 'string' ? versionEntry.license : null,
    versions: Object.keys(versions ?? {}).reverse(),
  };
  cacheSet(marketplaceManifestCache, name, detail);
  return detail;
}

/**
 * Run `fetchMarketplacePackage` over a list of names with bounded
 * concurrency so we don't fan out dozens of simultaneous fetches against
 * the registry.
 */
export async function resolveMarketplaceEntries(
  names: readonly string[],
): Promise<MarketplaceEntry[]> {
  const results: MarketplaceEntry[] = [];
  let i = 0;
  async function worker(): Promise<void> {
    while (i < names.length) {
      const idx = i++;
      const name = names[idx];
      const detail = await fetchMarketplacePackage(name);
      if (detail) {
        const { readme: _r, license: _l, versions: _v, ...entry } = detail;
        results.push(entry);
      }
    }
  }
  const pool = Array.from({ length: Math.min(MARKETPLACE_CONCURRENCY, names.length) }, worker);
  await Promise.all(pool);
  return results;
}
