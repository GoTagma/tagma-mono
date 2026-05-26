#!/usr/bin/env node
// Adds a release summary to an electron CHANGELOG entry from workflow input.
//
// Usage:
//   apply-release-changes.mjs <version> <changelog-file> --changes <json-array-or-lines>
//   apply-release-changes.mjs <version> <changelog-file> --changes-file <path>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeVersion, updateArchiveContent } from './update-web-changelog-summary.mjs';

export function parseReleaseChanges(rawInput) {
  const raw = String(rawInput ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const changes = Array.isArray(parsed) ? parsed : parsed?.changes;
    if (!Array.isArray(changes)) {
      throw new Error('JSON input must be an array of strings or an object with a changes array');
    }
    return changes.map((item) => String(item).trim()).filter(Boolean);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
        .filter(Boolean);
    }
    throw err;
  }
}

export function formatReleaseChangesSummary(changes) {
  return changes.map((change) => `- ${change}`).join('\n');
}

export function applyReleaseChanges({ version, changelogFile, changesInput }) {
  const normalizedVersion = normalizeVersion(version);
  const changes = parseReleaseChanges(changesInput);
  if (changes.length === 0) return { changed: false, changes };

  const current = readFileSync(changelogFile, 'utf-8');
  const next = updateArchiveContent(current, {
    version: normalizedVersion,
    summary: formatReleaseChangesSummary(changes),
  });
  writeFileSync(changelogFile, next, 'utf-8');
  return { changed: next !== current, changes };
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return [value, index + 1];
}

function parseArgs(args) {
  const positional = [];
  const options = { changes: undefined, changesFile: undefined };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--changes') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.changes = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--changes=')) {
      options.changes = arg.slice('--changes='.length);
      continue;
    }
    if (arg === '--changes-file') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.changesFile = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--changes-file=')) {
      options.changesFile = arg.slice('--changes-file='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (options.changes !== undefined && options.changesFile !== undefined) {
    throw new Error('use either --changes or --changes-file, not both');
  }
  return {
    version: positional[0],
    changelogFile: positional[1],
    changesInput:
      options.changesFile !== undefined
        ? readFileSync(options.changesFile === '-' ? 0 : options.changesFile, 'utf-8')
        : options.changes,
  };
}

function usage() {
  return [
    'usage:',
    '  apply-release-changes.mjs <version> <changelog-file> --changes <json-array-or-lines>',
    '  apply-release-changes.mjs <version> <changelog-file> --changes-file <path>',
  ].join('\n');
}

export function main(args = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseArgs(args);
    if (!options.version || !options.changelogFile || options.changesInput === undefined) {
      io.stderr.write(`${usage()}\n`);
      return 2;
    }
    const result = applyReleaseChanges(options);
    io.stdout.write(
      result.changed
        ? `applied ${result.changes.length} release change(s) to ${options.changelogFile}\n`
        : `no release changes to apply to ${options.changelogFile}\n`,
    );
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (directRunPath && directRunPath === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
