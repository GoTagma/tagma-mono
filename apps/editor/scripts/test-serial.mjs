import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const slowTestTimeouts = new Map([
  ['tests/editor-staging.test.ts', '30000'],
  ['tests/plugin-install-load.test.ts', '30000'],
  ['tests/workflow-integration.test.ts', '30000'],
  ['tests/workflow-run-route.test.ts', '30000'],
]);

function normalizePath(path) {
  return path.replaceAll('\\', '/').split(sep).join('/');
}

export function discoverTestFiles(testsDir, cwd = process.cwd()) {
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
        files.push(normalizePath(relative(cwd, full)));
      }
    }
  }

  walk(testsDir);
  return files.sort();
}

function hasTimeoutArg(args) {
  return args.some((arg) => arg === '--timeout' || arg.startsWith('--timeout='));
}

export function buildBunTestArgs(file, extraArgs = []) {
  const args = ['test', file];
  const timeout = slowTestTimeouts.get(normalizePath(file));
  if (timeout && !hasTimeoutArg(extraArgs)) {
    args.push('--timeout', timeout);
  }
  return [...args, ...extraArgs];
}

export function parseRunnerArgs(args) {
  const fileSelectors = [];
  const bunArgs = [];

  function addFileSelector(selector) {
    if (!selector || selector.startsWith('--')) {
      throw new Error('--file requires a test file path');
    }
    fileSelectors.push(selector);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file') {
      addFileSelector(args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--file=')) {
      addFileSelector(arg.slice('--file='.length));
    } else {
      bunArgs.push(arg);
    }
  }

  return { fileSelectors, bunArgs };
}

export function selectTestFiles(testFiles, fileSelectors) {
  if (fileSelectors.length === 0) {
    return testFiles;
  }

  const selectors = fileSelectors.map((selector) => normalizePath(selector).replace(/^\.\/+/, ''));
  const matchesSelector = (file, selector) => {
    const normalizedFile = normalizePath(file);
    return normalizedFile === selector || normalizedFile.endsWith(`/${selector}`);
  };

  const selectedFiles = new Set();
  for (const selector of selectors) {
    const matches = testFiles.filter((file) => matchesSelector(file, selector));
    if (matches.length === 0) {
      throw new Error(`No editor test file matched --file: ${selector}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous editor test file selector --file: ${selector} (matches: ${matches.join(', ')})`,
      );
    }
    selectedFiles.add(matches[0]);
  }

  return testFiles.filter((file) => selectedFiles.has(file));
}

function run() {
  const cwd = process.cwd();
  const discoveredFiles = discoverTestFiles(join(cwd, 'tests'), cwd);
  if (discoveredFiles.length === 0) {
    console.error('No editor test files found under tests/.');
    process.exit(1);
  }

  const { fileSelectors, bunArgs } = parseRunnerArgs(process.argv.slice(2));
  const testFiles = selectTestFiles(discoveredFiles, fileSelectors);
  let failures = 0;

  for (const file of testFiles) {
    console.log(`\n::group::${file}`);
    const result = spawnSync(process.execPath, buildBunTestArgs(file, bunArgs), {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    console.log('::endgroup::');

    if (result.status !== 0) {
      failures += 1;
      const exit = result.signal ? `signal ${result.signal}` : `exit ${result.status ?? 'unknown'}`;
      console.error(`${file} failed (${exit})`);
    }
  }

  if (failures > 0) {
    console.error(`${failures} editor test file(s) failed.`);
    process.exit(1);
  }
}

if (process.argv[1] && thisFile === resolve(process.argv[1])) {
  run();
}
