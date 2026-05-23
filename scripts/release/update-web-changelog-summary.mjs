#!/usr/bin/env node
// Manually updates the tagma-web archive entry summary for an already-synced
// desktop release.
//
// Usage:
//   node scripts/release/update-web-changelog-summary.mjs <version> --summary <en> [--summary-zh <zh>] [--web-dir <path>]
//   node scripts/release/update-web-changelog-summary.mjs <version> <summary-en> [summary-zh] [--web-dir <path>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^(?:desktop-v|v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

export function defaultWebDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tagma-web');
}

export function normalizeVersion(rawVersion) {
  const value = String(rawVersion ?? '').trim();
  const match = value.match(VERSION_RE);
  if (!match) {
    throw new Error(
      `invalid version "${value}"; expected 0.6.24, v0.6.24, or desktop-v0.6.24`,
    );
  }
  return match[1];
}

function yamlString(value) {
  const text = normalizeSummaryText(value);
  if (!text.includes('\n')) return JSON.stringify(text);
  return `|-\n${text.split('\n').map((line) => `  ${line}`).join('\n')}`;
}

function normalizeSummaryText(value) {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n+$/g, '');
}

function fieldLineRe(name) {
  return new RegExp(`^${name}\\s*:`);
}

function readFrontmatterScalar(frontmatter, name) {
  const line = frontmatter.split(/\r?\n/).find((item) => fieldLineRe(name).test(item));
  if (!line) return null;
  let value = line.slice(line.indexOf(':') + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function splitFrontmatterDocument(src) {
  const match = src.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('web changelog archive entry has no YAML frontmatter');
  return {
    eol: match[1],
    frontmatter: match[2],
    closingEol: match[4],
    body: match[5],
  };
}

function findFieldIndex(lines, name) {
  return lines.findIndex((line) => fieldLineRe(name).test(line));
}

function fieldEndIndex(lines, startIndex) {
  const line = lines[startIndex] ?? '';
  const value = line.slice(line.indexOf(':') + 1).trim();
  if (!value.startsWith('|') && !value.startsWith('>')) return startIndex + 1;

  let index = startIndex + 1;
  while (index < lines.length) {
    const next = lines[index];
    if (next === '' || /^\s/.test(next)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function upsertStringField(lines, name, value, options = {}) {
  const nextLine = `${name}: ${yamlString(value)}`;
  const existingIndex = findFieldIndex(lines, name);
  if (existingIndex >= 0) {
    lines.splice(existingIndex, fieldEndIndex(lines, existingIndex) - existingIndex, ...nextLine.split('\n'));
    return;
  }

  const beforeIndex =
    typeof options.before === 'string' ? findFieldIndex(lines, options.before) : -1;
  if (beforeIndex >= 0) {
    lines.splice(beforeIndex, 0, nextLine);
    return;
  }

  let afterIndex = -1;
  for (const candidate of options.after ?? []) {
    const index = findFieldIndex(lines, candidate);
    if (index >= 0) afterIndex = index;
  }
  lines.splice(afterIndex + 1, 0, nextLine);
}

export function updateArchiveContent(src, { version, summary, summaryZh }) {
  const parsed = splitFrontmatterDocument(src);
  const existingVersion = readFrontmatterScalar(parsed.frontmatter, 'version');
  if (existingVersion && existingVersion !== version) {
    throw new Error(
      `web changelog archive entry version (${existingVersion}) does not match ${version}`,
    );
  }

  const lines = parsed.frontmatter.split(/\r?\n/);
  upsertStringField(lines, 'summary', summary, {
    before: 'summary_zh',
    after: ['version', 'date', 'channel'],
  });
  if (summaryZh !== undefined) {
    upsertStringField(lines, 'summary_zh', summaryZh, {
      after: ['version', 'date', 'channel', 'summary'],
    });
  }

  return `---${parsed.eol}${lines.join(parsed.eol)}${parsed.eol}---${parsed.closingEol}${parsed.body}`;
}

export function updateWebChangelogSummary({ webDir = defaultWebDir(), version, summary, summaryZh }) {
  const normalizedVersion = normalizeVersion(version);
  if (summary === undefined || String(summary).length === 0) {
    throw new Error('summary is required');
  }

  const archivePath = path.join(
    webDir,
    'src',
    'content',
    'archive',
    `${normalizedVersion}.md`,
  );
  if (!existsSync(archivePath)) {
    throw new Error(`web changelog archive entry not found: ${archivePath}`);
  }

  const current = readFileSync(archivePath, 'utf-8');
  const next = updateArchiveContent(current, {
    version: normalizedVersion,
    summary,
    summaryZh,
  });
  writeFileSync(archivePath, next, 'utf-8');
  return archivePath;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return [value, index + 1];
}

export function parseArgs(args) {
  const options = {
    webDir: defaultWebDir(),
    version: undefined,
    summary: undefined,
    summaryFile: undefined,
    summaryZh: undefined,
    summaryZhFile: undefined,
  };
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };

    if (arg === '--web-dir') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.webDir = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--web-dir=')) {
      options.webDir = arg.slice('--web-dir='.length);
      continue;
    }
    if (arg === '--summary' || arg === '--summary-en') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.summary = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--summary=')) {
      options.summary = arg.slice('--summary='.length);
      continue;
    }
    if (arg.startsWith('--summary-en=')) {
      options.summary = arg.slice('--summary-en='.length);
      continue;
    }
    if (arg === '--summary-file' || arg === '--summary-en-file') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.summaryFile = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--summary-file=')) {
      options.summaryFile = arg.slice('--summary-file='.length);
      continue;
    }
    if (arg.startsWith('--summary-en-file=')) {
      options.summaryFile = arg.slice('--summary-en-file='.length);
      continue;
    }
    if (arg === '--summary-zh') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.summaryZh = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--summary-zh=')) {
      options.summaryZh = arg.slice('--summary-zh='.length);
      continue;
    }
    if (arg === '--summary-zh-file') {
      const [value, nextIndex] = takeValue(args, i, arg);
      options.summaryZhFile = value;
      i = nextIndex;
      continue;
    }
    if (arg.startsWith('--summary-zh-file=')) {
      options.summaryZhFile = arg.slice('--summary-zh-file='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  options.version = positional[0];
  if (options.summary === undefined && positional[1] !== undefined) {
    options.summary = positional[1];
  }
  if (options.summaryZh === undefined && positional[2] !== undefined) {
    options.summaryZh = positional[2];
  }
  if (positional.length > 3) {
    throw new Error(`unexpected positional argument: ${positional[3]}`);
  }
  return options;
}

function usage() {
  return [
    'usage:',
    '  update-web-changelog-summary.mjs <version> --summary <en> [--summary-zh <zh>] [--web-dir <path>]',
    '  update-web-changelog-summary.mjs <version> --summary-file <path> [--summary-zh-file <path>] [--web-dir <path>]',
    '  update-web-changelog-summary.mjs <version> <summary-en> [summary-zh] [--web-dir <path>]',
  ].join('\n');
}

function readTextInput(filePath) {
  return readFileSync(filePath === '-' ? 0 : filePath, 'utf-8');
}

function resolveSummaryInputs(options) {
  if (options.summary !== undefined && options.summaryFile !== undefined) {
    throw new Error('use either --summary or --summary-file, not both');
  }
  if (options.summaryZh !== undefined && options.summaryZhFile !== undefined) {
    throw new Error('use either --summary-zh or --summary-zh-file, not both');
  }
  return {
    ...options,
    summary: options.summaryFile !== undefined ? readTextInput(options.summaryFile) : options.summary,
    summaryZh:
      options.summaryZhFile !== undefined ? readTextInput(options.summaryZhFile) : options.summaryZh,
  };
}

export function main(args = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = resolveSummaryInputs(parseArgs(args));
    if (options.help) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!options.version || options.summary === undefined || String(options.summary).length === 0) {
      io.stderr.write(`${usage()}\n`);
      return 2;
    }
    const archivePath = updateWebChangelogSummary(options);
    io.stdout.write(`updated ${archivePath}\n`);
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
