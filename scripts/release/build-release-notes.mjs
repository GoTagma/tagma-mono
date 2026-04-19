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

const REPO = 'GoTagma/tagma-mono';
const TAG = `desktop-v${version}`;

const PLATFORMS = [
  { match: /^Tagma-mac-arm64\.dmg$/, label: 'macOS (Apple Silicon)' },
  { match: /^Tagma-mac-x64\.dmg$/, label: 'macOS (Intel)' },
  { match: /^Tagma-win-x64\.exe$/, label: 'Windows (x64)' },
  { match: /^Tagma-linux-x86_64\.AppImage$/, label: 'Linux (x86_64)' },
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
