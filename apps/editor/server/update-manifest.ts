import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

export interface HotupdateAsset {
  url: string;
  sha256: string;
  size: number;
}

export interface SidecarTargetAsset extends HotupdateAsset {
  platform: NodeJS.Platform;
  arch: string;
}

export interface HotupdateManifest {
  version: string;
  channel: string;
  minShellVersion?: string;
  dist: HotupdateAsset;
  sidecar?: {
    targets: SidecarTargetAsset[];
  };
  releaseNotesUrl?: string;
  signature?: string;
}

const MANIFEST_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_JSON_BYTES = 1024 * 1024;
export const MANIFEST_CACHE_TTL_MS = 60 * 1000;
const MAX_DIST_TARBALL_BYTES = 100 * 1024 * 1024;
const MAX_SIDECAR_BINARY_BYTES = 300 * 1024 * 1024;
const SEMVER_VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

let manifestCache: { url: string; value: HotupdateManifest; fetchedAt: number } | null = null;

export function isValidHotupdateVersion(version: string): boolean {
  return SEMVER_VERSION_RE.test(version);
}

export function assertValidHotupdateVersion(version: string, label = 'version'): void {
  if (!isValidHotupdateVersion(version)) {
    throw new Error(`${label} must be a semver string like 1.2.3 or 1.2.3-alpha.1`);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalHotupdateManifestPayload(manifest: Partial<HotupdateManifest>): string {
  const { signature: _signature, ...signedPayload } = manifest;
  return stableStringify(signedPayload);
}

function createManifestPublicKey(raw: string) {
  const trimmed = raw.trim().replace(/\\n/g, '\n');
  if (trimmed.startsWith('-----BEGIN')) {
    return createPublicKey(trimmed);
  }
  const der = Buffer.from(trimmed.replace(/^ed25519:/i, ''), 'base64');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyHotupdateManifestSignature(
  body: Partial<HotupdateManifest>,
  url: string,
  publicKey: string | undefined = process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY,
): void {
  if (!publicKey || !publicKey.trim()) {
    if (
      url.startsWith('file://') ||
      process.env.TAGMA_SIDECAR_ACTIVE_SOURCE === 'dev' ||
      process.env.TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES === '1'
    ) {
      return;
    }
    throw new Error(
      `Manifest signature verification requires TAGMA_UPDATE_MANIFEST_PUBLIC_KEY for ${url}`,
    );
  }
  if (typeof body.signature !== 'string' || !body.signature.trim()) {
    throw new Error(`Manifest at ${url} is not signed`);
  }
  const signature = Buffer.from(body.signature, 'base64');
  const payload = Buffer.from(canonicalHotupdateManifestPayload(body), 'utf-8');
  const ok = verifyEd25519(null, payload, createManifestPublicKey(publicKey), signature);
  if (!ok) {
    throw new Error(`Manifest signature verification failed for ${url}`);
  }
}

function validateAsset(
  asset: Partial<HotupdateAsset>,
  url: string,
  label: string,
  maxBytes: number,
): void {
  if (typeof asset.url !== 'string') {
    throw new Error(`Manifest at ${url} has bad ${label}.url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(asset.url);
  } catch {
    throw new Error(`Manifest at ${url} has bad ${label}.url`);
  }
  const allowFileAssets =
    url.startsWith('file://') || process.env.TAGMA_UNSAFE_ALLOW_FILE_UPDATE_URLS === '1';
  if (parsed.protocol !== 'https:' && !(allowFileAssets && parsed.protocol === 'file:')) {
    throw new Error(`Manifest at ${url} has bad ${label}.url (HTTPS required)`);
  }
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
    throw new Error(`Manifest at ${url} has bad ${label}.sha256 (want 64 hex chars)`);
  }
  if (typeof asset.size !== 'number' || !Number.isFinite(asset.size) || asset.size <= 0) {
    throw new Error(`Manifest at ${url} has bad ${label}.size`);
  }
  if (asset.size > maxBytes) {
    throw new Error(
      `Manifest at ${url} advertises a ${label} asset of ${asset.size} bytes, exceeds ${maxBytes} byte cap`,
    );
  }
}

export function validateHotupdateManifest(body: Partial<HotupdateManifest>, url: string): void {
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error(`Manifest at ${url} missing "version"`);
  }
  try {
    assertValidHotupdateVersion(body.version, `Manifest at ${url} version`);
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  if (typeof body.channel !== 'string' || !body.channel) {
    throw new Error(`Manifest at ${url} missing "channel"`);
  }
  if (body.minShellVersion !== undefined) {
    if (typeof body.minShellVersion !== 'string' || !body.minShellVersion) {
      throw new Error(`Manifest at ${url} has bad "minShellVersion"`);
    }
    try {
      assertValidHotupdateVersion(body.minShellVersion, `Manifest at ${url} minShellVersion`);
    } catch (err) {
      throw new Error(errorMessage(err));
    }
  }
  if (body.signature !== undefined && typeof body.signature !== 'string') {
    throw new Error(`Manifest at ${url} has bad "signature"`);
  }
  const dist = body.dist;
  if (!dist || typeof dist !== 'object') {
    throw new Error(`Manifest at ${url} missing "dist"`);
  }
  validateAsset(dist, url, 'dist', MAX_DIST_TARBALL_BYTES);

  const sidecar = body.sidecar;
  if (sidecar == null) return;
  if (typeof sidecar !== 'object' || !Array.isArray(sidecar.targets)) {
    throw new Error(`Manifest at ${url} has bad "sidecar.targets"`);
  }
  for (const [index, target] of sidecar.targets.entries()) {
    if (!target || typeof target !== 'object') {
      throw new Error(`Manifest at ${url} has bad sidecar.targets[${index}]`);
    }
    if (typeof target.platform !== 'string' || !target.platform) {
      throw new Error(`Manifest at ${url} has bad sidecar.targets[${index}].platform`);
    }
    if (typeof target.arch !== 'string' || !target.arch) {
      throw new Error(`Manifest at ${url} has bad sidecar.targets[${index}].arch`);
    }
    validateAsset(target, url, `sidecar.targets[${index}]`, MAX_SIDECAR_BINARY_BYTES);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the manifest URL for either the editor or the sidecar update flow.
 *
 * Editor and sidecar each carry their own TAGMA_*_UPDATE_MANIFEST_BASE_URL +
 * TAGMA_*_UPDATE_CHANNEL pair so a deploy can canary one side without dragging
 * the other along. Callers MUST pass the kind that matches their route:
 *
 *   - editor.ts  → 'editor'
 *   - sidecar.ts → 'sidecar'
 *   - release.ts → 'editor' (release endpoint pins to one canonical manifest;
 *                  the editor pair is treated as the source of truth)
 *
 * The opposite kind's env is consulted as a fallback so existing single-pair
 * deployments (where only TAGMA_EDITOR_* is set, like dev-bootstrap) keep
 * working — but a sidecar-only override no longer leaks into the editor route
 * (and vice versa) once both pairs are explicitly populated.
 */
export function resolveHotupdateManifestUrl(kind: 'editor' | 'sidecar' = 'editor'): string | null {
  const editorBase = process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL;
  const sidecarBase = process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL;
  const editorChannel = process.env.TAGMA_EDITOR_UPDATE_CHANNEL;
  const sidecarChannel = process.env.TAGMA_SIDECAR_UPDATE_CHANNEL;
  // Pair the channel with whichever base actually got selected. Picking them
  // independently broke the canary-one-side goal: e.g. resolving for 'editor'
  // when only TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL is set used to combine
  // the sidecar base with the editor channel (or vice versa), producing a
  // mixed URL that points nowhere meaningful.
  let base: string | undefined;
  let channel: string | undefined;
  if (kind === 'sidecar') {
    if (sidecarBase) {
      base = sidecarBase;
      channel = sidecarChannel;
    } else if (editorBase) {
      base = editorBase;
      channel = editorChannel;
    }
  } else {
    if (editorBase) {
      base = editorBase;
      channel = editorChannel;
    } else if (sidecarBase) {
      base = sidecarBase;
      channel = sidecarChannel;
    }
  }
  if (!base || !base.trim()) return null;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${channel ?? 'stable'}/manifest.json`;
}

export async function fetchHotupdateManifest(
  url: string,
  force = false,
  externalSignal?: AbortSignal,
): Promise<HotupdateManifest> {
  const now = Date.now();
  if (
    !force &&
    manifestCache &&
    manifestCache.url === url &&
    now - manifestCache.fetchedAt < MANIFEST_CACHE_TTL_MS
  ) {
    return manifestCache.value;
  }
  const timeoutSignal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const prefix = `Manifest fetch failed for ${url}`;
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`${prefix}: HTTP ${res.status}`);
    const contentLength = res.headers.get('content-length');
    if (contentLength) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MANIFEST_JSON_BYTES) {
        throw new Error(
          `Manifest at ${url} is too large (${declaredBytes} bytes, cap ${MAX_MANIFEST_JSON_BYTES})`,
        );
      }
    }
    text = await res.text();
  } catch (err) {
    if (externalSignal?.aborted) throw err;
    if (timeoutSignal.aborted) {
      throw new Error(`${prefix}: timed out after ${MANIFEST_TIMEOUT_MS / 1000}s`);
    }
    if (err instanceof Error) {
      if (err.message.startsWith(prefix)) throw err;
      throw new Error(`${prefix}: ${err.message}`);
    }
    throw new Error(`${prefix}: ${String(err)}`);
  }
  const bodyBytes = Buffer.byteLength(text, 'utf8');
  if (bodyBytes > MAX_MANIFEST_JSON_BYTES) {
    throw new Error(
      `Manifest at ${url} is too large (${bodyBytes} bytes, cap ${MAX_MANIFEST_JSON_BYTES})`,
    );
  }
  let body: Partial<HotupdateManifest>;
  try {
    body = JSON.parse(text) as Partial<HotupdateManifest>;
  } catch {
    throw new Error(`Manifest at ${url} is not valid JSON`);
  }
  validateHotupdateManifest(body, url);
  verifyHotupdateManifestSignature(body, url);
  const value = body as HotupdateManifest;
  manifestCache = { url, value, fetchedAt: now };
  return value;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseComparableSemver(a);
  const pb = parseComparableSemver(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = pa[key] - pb[key];
    if (delta !== 0) return delta;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const delta = comparePrereleaseIdentifier(ia, ib);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseComparableSemver(version: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} {
  const withoutBuild = version.split('+', 1)[0] ?? '';
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prerelease = dash === -1 ? '' : withoutBuild.slice(dash + 1);
  const [major = 0, minor = 0, patch = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return {
    major,
    minor,
    patch,
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  if (a === b) return 0;
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : 1;
}

export function pickSidecarTarget(
  manifest: HotupdateManifest,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SidecarTargetAsset | null {
  const targets = manifest.sidecar?.targets ?? [];
  return targets.find((target) => target.platform === platform && target.arch === arch) ?? null;
}
