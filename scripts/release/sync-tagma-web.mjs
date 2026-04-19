#!/usr/bin/env node
// Propagates a desktop release into the tagma-web repo:
//   1. Write src/content/archive/<version>.md with minimal frontmatter.
//   2. Patch specific fields in src/site.config.ts (no full rewrite).
// Args: <version> <mono-dir> <web-dir> <assets-dir>
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [version, monoDir, webDir, assetsDir] = process.argv.slice(2);
if (!version || !monoDir || !webDir || !assetsDir) {
  console.error('usage: sync-tagma-web.mjs <version> <mono-dir> <web-dir> <assets-dir>');
  process.exit(2);
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

// ---- 1. Archive entry: minimal frontmatter only, no body. ----
const srcChangelog = readFileSync(join(monoDir, 'packages/electron/CHANGELOG', `${version}.md`), 'utf8');
const fm = parseFrontmatter(srcChangelog);
if (fm.version !== version) {
  console.error(`changelog version (${fm.version}) != tag version (${version})`);
  process.exit(1);
}
if (!fm.date || !fm.channel) {
  console.error('changelog frontmatter missing required field: date or channel');
  process.exit(1);
}

const archiveOut = `---
version: "${fm.version}"
date: "${fm.date}"
channel: "${fm.channel}"
---
`;
const destArchiveDir = join(webDir, 'src/content/archive');
mkdirSync(destArchiveDir, { recursive: true });
writeFileSync(join(destArchiveDir, `${version}.md`), archiveOut);
console.log(`wrote ${join(destArchiveDir, `${version}.md`)}`);

// ---- 2. Patch site.config.ts. ----
// Filename pattern matches `artifactName` in packages/electron/package.json.
const MAC_ARM64 = `Tagma-${version}-mac-arm64.dmg`;
const macArm64Path = join(assetsDir, MAC_ARM64);
let macArm64Sha;
try {
  macArm64Sha = readFileSync(`${macArm64Path}.sha256`, 'utf8').trim().split(/\s+/)[0];
} catch {
  console.error(`missing ${MAC_ARM64}.sha256 in ${assetsDir}`);
  process.exit(1);
}
let macArm64Bytes;
try {
  macArm64Bytes = statSync(macArm64Path).size;
} catch {
  console.error(`missing ${MAC_ARM64} in ${assetsDir}`);
  process.exit(1);
}

const sizeMB = Math.round(macArm64Bytes / (1024 * 1024));
const shaHex = macArm64Sha.toUpperCase();
const sha256Short = shaHex.length >= 8 ? `${shaHex.slice(0, 4)}…${shaHex.slice(-4)}` : shaHex;
// Source the release date from the changelog frontmatter — not `new Date()` —
// so sync-web job timing (retries, queued runs spanning midnight UTC) cannot
// drift the displayed build date away from the actual release tag.
const dateMatch = fm.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
if (!dateMatch) {
  console.error(`changelog frontmatter date must be YYYY-MM-DD, got: ${fm.date}`);
  process.exit(1);
}
const [, yyyy, mm, dd] = dateMatch;
const buildDate = `${yyyy}-${mm}-${dd}`;
const build = `${yyyy}.${mm}.${dd}`;

const siteConfigPath = join(webDir, 'src/site.config.ts');
let config = readFileSync(siteConfigPath, 'utf8');

function fieldRegex(name) {
  return new RegExp(`(\\b${name}:\\s*)([^,\\n]+)(,?)`);
}

function readField(src, name) {
  const m = src.match(fieldRegex(name));
  if (!m) throw new Error(`field ${name} not found in site.config.ts`);
  return m[2];
}

function replaceField(src, name, newLiteral) {
  const re = fieldRegex(name);
  if (!re.test(src)) throw new Error(`field ${name} not found in site.config.ts`);
  return src.replace(re, `$1${newLiteral}$3`);
}

// Read the existing `channel:` line so we can preserve whatever `as '...'`
// union annotation tagma-web currently declares — writing back a hardcoded
// union would silently drift when the web repo widens or narrows the enum.
const existingChannelExpr = readField(config, 'channel');
const asMatch = existingChannelExpr.match(/\bas\s+(.+?)\s*$/);
const channelUnionSuffix = asMatch ? ` as ${asMatch[1]}` : '';
const channelUnionLiterals = asMatch
  ? [...asMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];
// Only collapse `patch` → `stable` if the union doesn't actually accept
// `patch`. Once tagma-web widens its union to include `patch`, the collapse
// goes away on its own.
const siteChannel =
  fm.channel === 'patch' && !channelUnionLiterals.includes('patch') ? 'stable' : fm.channel;
config = replaceField(config, 'version', JSON.stringify(version));
config = replaceField(config, 'channel', `${JSON.stringify(siteChannel)}${channelUnionSuffix}`);
config = replaceField(config, 'build', JSON.stringify(build));
config = replaceField(config, 'buildDate', JSON.stringify(buildDate));
config = replaceField(config, 'sha256Short', JSON.stringify(sha256Short));
config = replaceField(config, 'sizeMB', String(sizeMB));

writeFileSync(siteConfigPath, config);
console.log(`patched ${siteConfigPath}`);
