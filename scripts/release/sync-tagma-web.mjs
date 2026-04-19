#!/usr/bin/env node
// Propagates a desktop release into the tagma-web repo:
//   1. Copy CHANGELOG/<version>.md -> src/content/changelog/<version>.md
//      (with an appended "## Downloads" section).
//   2. Patch specific fields in src/site.config.ts (no full rewrite).
// Args: <version> <mono-dir> <web-dir> <assets-dir>
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [version, monoDir, webDir, assetsDir] = process.argv.slice(2);
if (!version || !monoDir || !webDir || !assetsDir) {
  console.error('usage: sync-tagma-web.mjs <version> <mono-dir> <web-dir> <assets-dir>');
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

function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('no frontmatter');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[kv[1]] = val;
  }
  return fm;
}

function buildDownloadsTable(present) {
  const lines = ['## Downloads', '', '| Platform | File | Size | SHA-256 |', '| --- | --- | --- | --- |'];
  for (const p of PLATFORMS) {
    const name = [...present.keys()].find((n) => p.match.test(n));
    if (!name) continue;
    const { size, sha } = present.get(name);
    const url = `https://github.com/${REPO}/releases/download/${TAG}/${name}`;
    lines.push(`| ${p.label} | [${name}](${url}) | ${size} MB | \`${sha}\` |`);
  }
  return lines.join('\n') + '\n';
}

function findAsset(present, re) {
  for (const name of present.keys()) if (re.test(name)) return name;
  return null;
}

const present = new Map();
for (const name of readdirSync(assetsDir)) {
  const full = join(assetsDir, name);
  if (!statSync(full).isFile()) continue;
  if (!/\.(dmg|exe|AppImage)$/.test(name)) continue;
  present.set(name, { size: toMB(statSync(full).size), sha: readChecksum(assetsDir, name) ?? '' });
}
if (present.size === 0) {
  console.error(`no installers found in ${assetsDir}`);
  process.exit(1);
}

// ---- 1. Changelog copy + appended downloads. ----
const srcChangelog = readFileSync(join(monoDir, 'packages/electron/CHANGELOG', `${version}.md`), 'utf8');
const fm = parseFrontmatter(srcChangelog);
if (fm.version !== version) {
  console.error(`changelog version (${fm.version}) != tag version (${version})`);
  process.exit(1);
}

const downloads = buildDownloadsTable(present);
const changelogOut = `${srcChangelog.trimEnd()}\n\n${downloads}`;
const destChangelogDir = join(webDir, 'src/content/changelog');
mkdirSync(destChangelogDir, { recursive: true });
writeFileSync(join(destChangelogDir, `${version}.md`), changelogOut);
console.log(`wrote ${join(destChangelogDir, `${version}.md`)}`);

// ---- 2. Patch site.config.ts. ----
const macArm64Name = findAsset(present, /^Tagma-mac-arm64\.dmg$/);
if (!macArm64Name) {
  console.error('mac-arm64 dmg missing — required for sha256Short/sizeMB');
  process.exit(1);
}
const macArm64 = present.get(macArm64Name);
const macArm64Bytes = statSync(join(assetsDir, macArm64Name)).size;
const sizeMB = Math.round(macArm64Bytes / (1024 * 1024));
const shaHex = macArm64.sha.toUpperCase();
const sha256Short = shaHex.length >= 8 ? `${shaHex.slice(0, 4)}…${shaHex.slice(-4)}` : shaHex;
const today = new Date();
const yyyy = today.getUTCFullYear();
const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
const dd = String(today.getUTCDate()).padStart(2, '0');
const buildDate = `${yyyy}-${mm}-${dd}`;
const build = `${yyyy}.${mm}.${dd}`;

const siteConfigPath = join(webDir, 'src/site.config.ts');
let config = readFileSync(siteConfigPath, 'utf8');

function replaceField(src, name, newLiteral) {
  const re = new RegExp(`(\\b${name}:\\s*)([^,\\n]+)(,?)`);
  if (!re.test(src)) throw new Error(`field ${name} not found in site.config.ts`);
  return src.replace(re, `$1${newLiteral}$3`);
}

// site.config.ts's channel union is narrower than the changelog enum —
// collapse `patch` into `stable` for display purposes.
const siteChannel = fm.channel === 'patch' ? 'stable' : fm.channel;
config = replaceField(config, 'version', JSON.stringify(version));
config = replaceField(
  config,
  'channel',
  `${JSON.stringify(siteChannel)} as 'beta' | 'stable' | 'rc' | 'alpha'`
);
config = replaceField(config, 'build', JSON.stringify(build));
config = replaceField(config, 'buildDate', JSON.stringify(buildDate));
config = replaceField(config, 'sha256Short', JSON.stringify(sha256Short));
config = replaceField(config, 'sizeMB', String(sizeMB));

writeFileSync(siteConfigPath, config);
console.log(`patched ${siteConfigPath}`);
