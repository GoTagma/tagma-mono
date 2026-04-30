#!/usr/bin/env node
// Generates the editor hot-update manifest for a given desktop release.
// The manifest is the stable detection endpoint clients poll (served from
// tagma-web/public/editor-updates/<channel>/manifest.json). Asset URLs point
// at the corresponding GitHub Release assets so the manifest and payloads are
// versioned together and never drift.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { sign as signEd25519 } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR_TARGETS = [
  { platform: 'win32', arch: 'x64', extension: '.exe' },
  { platform: 'linux', arch: 'x64', extension: '' },
  { platform: 'linux', arch: 'arm64', extension: '' },
  { platform: 'darwin', arch: 'x64', extension: '' },
  { platform: 'darwin', arch: 'arm64', extension: '' },
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function canonicalHotupdateManifestPayload(manifest) {
  const { signature: _signature, ...signedPayload } = manifest;
  return stableStringify(signedPayload);
}

export function signHotupdateManifest(manifest, privateKeyPem) {
  const payload = Buffer.from(canonicalHotupdateManifestPayload(manifest), 'utf-8');
  const signature = signEd25519(null, payload, privateKeyPem).toString('base64');
  return { ...manifest, signature };
}

function readSha256File(assetPath) {
  const shaPath = `${assetPath}.sha256`;
  try {
    return readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  } catch {
    throw new Error(`missing ${assetPath.split(/[\\/]/).pop()}.sha256 in ${dirname(assetPath)}`);
  }
}

function readRequiredAsset(assetsDir, filename) {
  const assetPath = join(assetsDir, filename);
  let size;
  try {
    size = statSync(assetPath).size;
  } catch {
    throw new Error(`missing ${filename} in ${assetsDir}`);
  }
  const sha = readSha256File(assetPath);
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new Error(`bad sha256 in ${assetPath}.sha256: ${sha}`);
  }
  return { filename, size, sha: sha.toLowerCase() };
}

function readOptionalAsset(assetsDir, filename) {
  const assetPath = join(assetsDir, filename);
  if (!existsSync(assetPath)) return null;
  return readRequiredAsset(assetsDir, filename);
}

function buildReleaseAssetUrl(repoSlug, tagName, filename) {
  return `https://github.com/${repoSlug}/releases/download/${tagName}/${filename}`;
}

export function buildHotupdateManifest({
  version,
  channel,
  assetsDir,
  repoSlug,
  minShellVersion,
  allowPartialSidecars = false,
}) {
  const tagName = `desktop-v${version}`;
  const distAsset = readRequiredAsset(assetsDir, `editor-dist-${version}.tar.gz`);
  const sidecarTargets = [];
  const missingTargets = [];
  for (const { platform, arch, extension } of SIDECAR_TARGETS) {
    const filename = `tagma-editor-server-${version}-${platform}-${arch}${extension}`;
    const asset = readOptionalAsset(assetsDir, filename);
    if (!asset) {
      missingTargets.push({ platform, arch, filename });
      continue;
    }
    sidecarTargets.push({
      platform,
      arch,
      url: buildReleaseAssetUrl(repoSlug, tagName, asset.filename),
      sha256: asset.sha,
      size: asset.size,
    });
  }

  if (missingTargets.length > 0) {
    // The editor UI's primary "Update Tagma" button requires sidecar.canUpdate
    // (VersionStatusBar.tsx bundleCanUpdate gate), and each platform/arch needs
    // its own asset to set canUpdate true on that machine. A missing target
    // silently disables Update Tagma on the affected platform — Windows users
    // would see editor.canUpdate but sidecar.canUpdate = false and have to
    // hunt for the advanced editor-only flow. Hard fail by default so a CI
    // pipeline that drops one artifact can't ship a half-broken manifest;
    // callers that intentionally publish editor-only or single-platform
    // builds opt in via `allowPartialSidecars: true` (CLI:
    // --allow-partial-sidecars).
    const lines = missingTargets.map(
      (t) => `  - ${t.platform}/${t.arch} (expected ${t.filename})`,
    );
    const summary =
      sidecarTargets.length === 0
        ? `no sidecar binaries found in ${assetsDir}`
        : `${missingTargets.length}/${SIDECAR_TARGETS.length} sidecar targets missing in ${assetsDir}`;
    if (!allowPartialSidecars) {
      throw new Error(
        `[build-hotupdate-manifest] ${summary}. Pass --allow-partial-sidecars ` +
          `to publish anyway (Update Tagma will be unavailable on the missing ` +
          `platforms — those users will only see editor-only updates via the ` +
          `advanced UI). Missing targets:\n${lines.join('\n')}`,
      );
    }
    console.warn(
      `[build-hotupdate-manifest] WARNING: ${summary}. ` +
        `Update Tagma will be disabled on the missing platforms ` +
        `(only advanced editor-only updates remain available there).\n${lines.join('\n')}`,
    );
  }

  return {
    version,
    channel,
    ...(minShellVersion ? { minShellVersion } : {}),
    dist: {
      url: buildReleaseAssetUrl(repoSlug, tagName, distAsset.filename),
      sha256: distAsset.sha,
      size: distAsset.size,
    },
    ...(sidecarTargets.length > 0 ? { sidecar: { targets: sidecarTargets } } : {}),
    releaseNotesUrl: `https://github.com/${repoSlug}/releases/tag/${tagName}`,
  };
}

function parseCliArgs(argv) {
  let minShellVersion;
  let signingKey;
  let allowPartialSidecars = false;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-shell') {
      minShellVersion = argv[++i];
      if (!minShellVersion) {
        throw new Error('--min-shell requires a version argument');
      }
      continue;
    }
    if (arg.startsWith('--min-shell=')) {
      minShellVersion = arg.slice('--min-shell='.length);
      continue;
    }
    if (arg === '--signing-key') {
      signingKey = argv[++i];
      if (!signingKey) {
        throw new Error('--signing-key requires a PEM file path');
      }
      continue;
    }
    if (arg.startsWith('--signing-key=')) {
      signingKey = arg.slice('--signing-key='.length);
      continue;
    }
    if (arg === '--allow-partial-sidecars') {
      allowPartialSidecars = true;
      continue;
    }
    positional.push(arg);
  }
  const [version, channel, assetsDir, repoSlug, outFile] = positional;
  if (!version || !channel || !assetsDir || !repoSlug || !outFile) {
    throw new Error(
      'usage: build-hotupdate-manifest.mjs <version> <channel> <assets-dir> <repo-slug> <out-file> [--min-shell <version>] [--signing-key <private-key.pem>] [--allow-partial-sidecars]',
    );
  }
  return {
    version,
    channel,
    assetsDir,
    repoSlug,
    outFile,
    minShellVersion,
    signingKey,
    allowPartialSidecars,
  };
}

export function writeHotupdateManifest(outFile, manifest) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { outFile, signingKey, ...args } = parseCliArgs(argv);
    const manifest = buildHotupdateManifest(args);
    const privateKeyPem = signingKey
      ? readFileSync(signingKey, 'utf-8')
      : process.env.TAGMA_HOTUPDATE_MANIFEST_PRIVATE_KEY;
    const outputManifest = privateKeyPem
      ? signHotupdateManifest(manifest, privateKeyPem)
      : manifest;
    writeHotupdateManifest(outFile, outputManifest);
    console.log(`wrote ${outFile}`);
    console.log(JSON.stringify(outputManifest, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
