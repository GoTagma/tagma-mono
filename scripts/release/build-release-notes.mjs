#!/usr/bin/env node
// Prints the GitHub Release body: a "## Downloads" section with pinned
// download URLs, sizes, and sha256 hashes. No hand-written notes —
// the Archive page on tagma-web is the canonical version index.
// Args: <version> <assets-dir>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [version, assetsDir] = process.argv.slice(2);
if (!version || !assetsDir) {
  console.error('usage: build-release-notes.mjs <version> <assets-dir>');
  process.exit(2);
}

// GITHUB_REPOSITORY is always set in GitHub Actions ("<owner>/<repo>").
// Refusing to default avoids publishing notes that point at the wrong fork
// after an org rename or when someone runs the release workflow from a fork.
const REPO = process.env.GITHUB_REPOSITORY;
if (!REPO) {
  console.error('GITHUB_REPOSITORY env var is required (set automatically on GitHub Actions)');
  process.exit(1);
}
const TAG = `desktop-v${version}`;

// Filenames are version-prefixed (`Tagma-<version>-<os>-<arch>.<ext>`) so users
// can tell builds apart from the filename alone. Keep the regex in lock-step
// with `artifactName` in apps/electron/package.json.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const v = escapeRegex(version);
// Arch token differs per Linux target (electron-builder convention):
// AppImage → x86_64, deb → amd64, rpm → x86_64, tar.gz → x64. Match broadly
// on `[^.]+` so a future arch-token rename doesn't silently drop rows.
const PLATFORMS = [
  { match: new RegExp(`^Tagma-${v}-mac-arm64\\.dmg$`), label: 'macOS (Apple Silicon)' },
  { match: new RegExp(`^Tagma-${v}-mac-x64\\.dmg$`), label: 'macOS (Intel)' },
  { match: new RegExp(`^Tagma-${v}-win-x64\\.exe$`), label: 'Windows (x64)' },
  { match: new RegExp(`^Tagma-${v}-linux-[^.]+\\.AppImage$`), label: 'Linux — AppImage' },
  { match: new RegExp(`^Tagma-${v}-linux-[^.]+\\.deb$`), label: 'Linux — Debian / Ubuntu (.deb)' },
  { match: new RegExp(`^Tagma-${v}-linux-[^.]+\\.rpm$`), label: 'Linux — Fedora / RHEL (.rpm)' },
  { match: new RegExp(`^Tagma-${v}-linux-[^.]+\\.tar\\.gz$`), label: 'Linux — Tarball (.tar.gz)' },
];

function readChecksum(dir, name) {
  try {
    return readFileSync(join(dir, `${name}.sha256`), 'utf8').trim().split(/\s+/)[0];
  } catch {
    return null;
  }
}

function toMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const present = new Set(readdirSync(assetsDir));

const lines = [];
lines.push('## Downloads');
lines.push('');
lines.push('| Platform | File | Size | SHA-256 |');
lines.push('| --- | --- | --- | --- |');
for (const p of PLATFORMS) {
  const name = [...present].find((n) => p.match.test(n));
  if (!name) continue;
  const size = toMB(statSync(join(assetsDir, name)).size);
  const sha = readChecksum(assetsDir, name) ?? '';
  const url = `https://github.com/${REPO}/releases/download/${TAG}/${name}`;
  lines.push(`| ${p.label} | [${name}](${url}) | ${size} MB | \`${sha}\` |`);
}

process.stdout.write(lines.join('\n') + '\n');
