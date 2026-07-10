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
  return path.split(sep).join('/');
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

function run() {
  const cwd = process.cwd();
  const testFiles = discoverTestFiles(join(cwd, 'tests'), cwd);
  if (testFiles.length === 0) {
    console.error('No editor test files found under tests/.');
    process.exit(1);
  }

  const extraArgs = process.argv.slice(2);
  let failures = 0;

  for (const file of testFiles) {
    console.log(`\n::group::${file}`);
    const result = spawnSync(process.execPath, buildBunTestArgs(file, extraArgs), {
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
