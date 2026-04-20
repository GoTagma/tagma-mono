#!/usr/bin/env node
// Generates the editor hot-update manifest for a given desktop release.
// The manifest is the stable detection endpoint clients poll (served from
// tagma-web/public/editor-updates/<channel>/manifest.json). Tarball URL points
// at the corresponding GitHub Release asset so the manifest and the payload
// are versioned together and never drift.
//
// Args: <version> <channel> <assets-dir> <repo-slug> <out-file> [--min-shell <version>]
//
// <assets-dir>  — directory containing editor-dist-<version>.tar.gz(.sha256)
//                 (the publish job's flattened release-assets dir).
// <repo-slug>   — e.g. "GoTagma/tagma-mono"; used to build the tarball URL.
// <out-file>    — absolute path where the manifest JSON should be written.
// --min-shell   — optional floor for the installer (electron shell) version
//                 required to apply this bundle. Omit unless this release
//                 depends on an IPC/preload surface only present in a newer
//                 shell; see the manifest-construction block below.
//
// The client-side consumer is packages/editor/server/routes/editor.ts —
// keep this output shape aligned with the EditorManifest interface there.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const rawArgs = process.argv.slice(2);
let minShellVersion;
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--min-shell') {
    minShellVersion = rawArgs[++i];
    if (!minShellVersion) {
      console.error('--min-shell requires a version argument');
      process.exit(2);
    }
  } else if (arg.startsWith('--min-shell=')) {
    minShellVersion = arg.slice('--min-shell='.length);
  } else {
    positional.push(arg);
  }
}

const [version, channel, assetsDir, repoSlug, outFile] = positional;
if (!version || !channel || !assetsDir || !repoSlug || !outFile) {
  console.error(
    'usage: build-hotupdate-manifest.mjs <version> <channel> <assets-dir> <repo-slug> <out-file> [--min-shell <version>]',
  );
  process.exit(2);
}

const tarballName = `editor-dist-${version}.tar.gz`;
const tarballPath = join(assetsDir, tarballName);
const shaPath = `${tarballPath}.sha256`;

let size;
try {
  size = statSync(tarballPath).size;
} catch {
  console.error(`missing ${tarballName} in ${assetsDir}`);
  process.exit(1);
}

let sha;
try {
  // The .sha256 sibling format is "<hex>  <filename>\n" (shasum -a 256 output).
  sha = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
} catch {
  console.error(`missing ${tarballName}.sha256 in ${assetsDir}`);
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(sha)) {
  console.error(`bad sha256 in ${shaPath}: ${sha}`);
  process.exit(1);
}

const tagName = `desktop-v${version}`;
// GitHub Release asset URL pattern. This URL is stable as long as the tag
// is not deleted; renaming the release title doesn't affect it.
const downloadUrl = `https://github.com/${repoSlug}/releases/download/${tagName}/${tarballName}`;
const releaseNotesUrl = `https://github.com/${repoSlug}/releases/tag/${tagName}`;

// minShellVersion represents the oldest installer whose IPC/preload surface
// this bundle still works against — NOT the release version itself. Pinning
// it to `version` would force users to reinstall the installer for every hot
// update, defeating the point of hot updates. Omitting the field entirely
// means any shell can apply this bundle, which is the correct default while
// the IPC surface is stable. Pass --min-shell <ver> only when this release
// depends on a shell feature introduced in that installer version.
const manifest = {
  version,
  channel,
  ...(minShellVersion ? { minShellVersion } : {}),
  dist: {
    url: downloadUrl,
    sha256: sha.toLowerCase(),
    size,
  },
  releaseNotesUrl,
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${outFile}`);
console.log(JSON.stringify(manifest, null, 2));
