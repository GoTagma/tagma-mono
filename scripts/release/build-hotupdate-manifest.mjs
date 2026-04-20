#!/usr/bin/env node
// Generates the editor hot-update manifest for a given desktop release.
// The manifest is the stable detection endpoint clients poll (served from
// tagma-web/public/editor-updates/<channel>/manifest.json). Tarball URL points
// at the corresponding GitHub Release asset so the manifest and the payload
// are versioned together and never drift.
//
// Args: <version> <channel> <assets-dir> <repo-slug> <out-file>
//
// <assets-dir>  — directory containing editor-dist-<version>.tar.gz(.sha256)
//                 (the publish job's flattened release-assets dir).
// <repo-slug>   — e.g. "GoTagma/tagma-mono"; used to build the tarball URL.
// <out-file>    — absolute path where the manifest JSON should be written.
//
// The client-side consumer is packages/editor/server/routes/editor.ts —
// keep this output shape aligned with the EditorManifest interface there.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [version, channel, assetsDir, repoSlug, outFile] = process.argv.slice(2);
if (!version || !channel || !assetsDir || !repoSlug || !outFile) {
  console.error(
    'usage: build-hotupdate-manifest.mjs <version> <channel> <assets-dir> <repo-slug> <out-file>',
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

// minShellVersion is pinned to the version being released. Tier A (one
// installer, one hot-update per release) means any shell at this version or
// newer can always apply this bundle — older shells get refused. When tier B
// (hotfix packages between installers) is introduced later, bump this
// manually in the release process to gate features behind a newer shell.
const manifest = {
  version,
  channel,
  minShellVersion: version,
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
