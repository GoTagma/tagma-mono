#!/usr/bin/env node
// Reads a changelog markdown file's frontmatter and prints channel metadata
// in GitHub Actions $GITHUB_OUTPUT format.
// Args: <changelog-file>
// Outputs:
//   channel=<alpha|beta|rc|stable|patch>
//   prerelease=<true|false>
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: channel-info.mjs <changelog-file>');
  process.exit(2);
}

const src = readFileSync(path, 'utf8');
const fmMatch = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) {
  console.error(`no frontmatter in ${path}`);
  process.exit(1);
}

const channelMatch = fmMatch[1].match(/^channel:\s*["']?([a-z]+)["']?\s*$/m);
if (!channelMatch) {
  console.error(`no channel field in frontmatter of ${path}`);
  process.exit(1);
}

// A `patch` release is an emergency fix on top of stable and must reach
// stable installers. Collapse to `stable` here so (a) the GitHub Release is
// not flagged prerelease and (b) downstream consumers (hot-update manifest
// path, tagma-web sync) write to the stable channel rather than a phantom
// "patch" channel no installer polls. sync-tagma-web.mjs does the same
// collapse when patching site.config.ts for consistency.
const rawChannel = channelMatch[1];
const channel = rawChannel === 'patch' ? 'stable' : rawChannel;
const prerelease = channel !== 'stable';
process.stdout.write(`channel=${channel}\nprerelease=${prerelease}\n`);
