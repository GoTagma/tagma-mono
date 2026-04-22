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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR_TARGETS = [
  { platform: 'win32', arch: 'x64', extension: '.exe' },
  { platform: 'linux', arch: 'x64', extension: '' },
  { platform: 'linux', arch: 'arm64', extension: '' },
  { platform: 'darwin', arch: 'x64', extension: '' },
  { platform: 'darwin', arch: 'arm64', extension: '' },
];

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
}) {
  const tagName = `desktop-v${version}`;
  const distAsset = readRequiredAsset(assetsDir, `editor-dist-${version}.tar.gz`);
  const sidecarTargets = SIDECAR_TARGETS.flatMap(({ platform, arch, extension }) => {
    const filename = `tagma-editor-server-${version}-${platform}-${arch}${extension}`;
    const asset = readOptionalAsset(assetsDir, filename);
    if (!asset) return [];
    return [
      {
        platform,
        arch,
        url: buildReleaseAssetUrl(repoSlug, tagName, asset.filename),
        sha256: asset.sha,
        size: asset.size,
      },
    ];
  });

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
    positional.push(arg);
  }
  const [version, channel, assetsDir, repoSlug, outFile] = positional;
  if (!version || !channel || !assetsDir || !repoSlug || !outFile) {
    throw new Error(
      'usage: build-hotupdate-manifest.mjs <version> <channel> <assets-dir> <repo-slug> <out-file> [--min-shell <version>]',
    );
  }
  return { version, channel, assetsDir, repoSlug, outFile, minShellVersion };
}

export function writeHotupdateManifest(outFile, manifest) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { outFile, ...args } = parseCliArgs(argv);
    const manifest = buildHotupdateManifest(args);
    writeHotupdateManifest(outFile, manifest);
    console.log(`wrote ${outFile}`);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
