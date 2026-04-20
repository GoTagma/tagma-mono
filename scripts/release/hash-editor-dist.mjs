#!/usr/bin/env node
// Deterministic hash of a directory tree. Every build matrix runner
// (mac/linux/win) hashes apps/editor/dist after `bun run build:desktop`; the
// publish job then fails if the three hashes don't agree. That catches the
// hidden premise behind the hot-update pipeline: the Linux-only hot-update
// tarball must be byte-equivalent to the editor-dist that Windows/Mac
// installers ship in extraResources. If a future Vite plugin or dep lands
// OS-specific chunks, the mismatch shows up here instead of silently shipping
// divergent bundles to users who hot-update vs. reinstall.
//
// Output is a single lowercase hex sha256 followed by a newline.
// Args: <dir>
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: hash-editor-dist.mjs <dir>');
  process.exit(2);
}

// Walk depth-first, collect regular files only. Skip symlinks and special
// entries so a cross-OS quirk (e.g. Windows reparse point) doesn't bleed into
// the hash — Vite's output is regular files anyway.
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur);
    } catch (err) {
      throw new Error(`failed to read ${cur}: ${err.message}`);
    }
    for (const name of entries) {
      const full = join(cur, name);
      const s = statSync(full);
      if (s.isDirectory()) {
        stack.push(full);
      } else if (s.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

const files = walkFiles(dir);
// Normalize path separators to `/` and sort so the same tree on Windows and
// Linux hashes to the same value.
const rels = files.map((f) => relative(dir, f).split(sep).join('/')).sort();

const rollup = createHash('sha256');
for (const rel of rels) {
  const absolute = join(dir, ...rel.split('/'));
  const content = readFileSync(absolute);
  const fileHash = createHash('sha256').update(content).digest('hex');
  // Format: "<file-sha256>\0<rel-path>\n". Null separator keeps path from
  // ambiguously concatenating into the hex prefix; newline terminator ensures
  // ["a", "b"] hashes differently from ["ab"] even if both were permitted.
  rollup.update(`${fileHash}\0${rel}\n`);
}

process.stdout.write(rollup.digest('hex') + '\n');
