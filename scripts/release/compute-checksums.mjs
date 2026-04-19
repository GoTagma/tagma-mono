#!/usr/bin/env node
// Writes <file>.sha256 siblings for every installer in the given directory.
// Args: <dir>
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const INSTALLER_EXT = /\.(dmg|exe|AppImage)$/;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: compute-checksums.mjs <dir>');
  process.exit(2);
}

let count = 0;
for (const name of readdirSync(dir)) {
  if (!INSTALLER_EXT.test(name)) continue;
  const full = join(dir, name);
  if (!statSync(full).isFile()) continue;
  const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
  writeFileSync(`${full}.sha256`, `${hash}  ${name}\n`);
  console.log(`${hash}  ${name}`);
  count++;
}

if (count === 0) {
  console.error(`no installers found in ${dir}`);
  process.exit(1);
}
