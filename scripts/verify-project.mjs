#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  {
    id: 'text',
    name: 'Text hygiene',
    angle: 'conflict markers, UTF-8 BOMs, and mojibake',
    args: ['run', 'check:text'],
  },
  {
    id: 'deps',
    name: 'Dependency & lockfile integrity',
    angle: 'bun.lock presence, frozen-lockfile sync, internal @tagma/* version ranges',
    args: ['run', 'check:deps'],
  },
  {
    id: 'format',
    name: 'Format check',
    angle: 'Prettier drift across packages and apps',
    args: ['run', 'format:check'],
  },
  {
    id: 'types',
    name: 'Type checks',
    angle: 'TypeScript contracts across packages, editor, tests, and Electron',
    args: ['run', 'check'],
  },
  {
    id: 'lint',
    name: 'Lint',
    angle: 'ESLint correctness and warnings',
    args: ['run', 'lint'],
  },
  {
    id: 'tests',
    name: 'Unit and integration tests',
    angle: 'Bun test suites for public packages, editor, and desktop shell',
    args: ['run', 'test'],
  },
  {
    id: 'scripts',
    name: 'Verification tooling self-test',
    angle: 'node:test suite for the dependency-gate semver evaluator',
    args: ['run', 'test:scripts'],
  },
  {
    id: 'build',
    name: 'Full desktop build',
    angle: 'public packages, plugins, editor bundle, sidecar, and Electron compile',
    args: ['run', 'build:desktop'],
    fullOnly: true,
  },
];

const HELP = `Usage: node scripts/verify-project.mjs [options]

Runs project verification from multiple angles and exits non-zero if any gate fails.

Options:
  --quick             Skip full-build-only gates.
  --full              Run every gate. This is the default.
  --fail-fast         Stop after the first failed gate.
  --only=a,b          Run only selected gate ids.
  --skip=a,b          Skip selected gate ids.
  --list              Print gates without running them.
  -h, --help          Show this help.

Gate ids: ${GATES.map((gate) => gate.id).join(', ')}
`;

function parseCsvOption(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    } else if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
    }
  }
  return new Set(
    values
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function commandLine(args) {
  return ['bun', ...args].join(' ');
}

function printGate(gate) {
  console.log(`  - ${gate.id}: ${gate.name}`);
  console.log(`    angle: ${gate.angle}`);
  console.log(`    command: ${commandLine(gate.args)}`);
}

function selectGates(args) {
  const only = parseCsvOption(args, '--only');
  const skip = parseCsvOption(args, '--skip');
  const quick = args.includes('--quick');
  const selected = GATES.filter((gate) => {
    if (quick && gate.fullOnly) return false;
    if (only.size > 0 && !only.has(gate.id)) return false;
    return !skip.has(gate.id);
  });

  const known = new Set(GATES.map((gate) => gate.id));
  const unknown = [...only, ...skip].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown gate id: ${unknown.join(', ')}`);
  }
  if (selected.length === 0) {
    throw new Error('No gates selected.');
  }
  return selected;
}

function runGate(gate) {
  return new Promise((resolveGate) => {
    const startedAt = Date.now();
    console.log('');
    console.log(`[verify] ${gate.name}`);
    console.log(`[verify] angle: ${gate.angle}`);
    console.log(`[verify] command: ${commandLine(gate.args)}`);

    const child = spawn('bun', gate.args, {
      cwd: repoRoot,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      resolveGate({
        gate,
        ok: false,
        durationMs: Date.now() - startedAt,
        detail: error.message,
      });
    });

    child.on('close', (code, signal) => {
      const ok = code === 0;
      resolveGate({
        gate,
        ok,
        durationMs: Date.now() - startedAt,
        detail: ok ? 'ok' : signal ? `signal ${signal}` : `exit ${code}`,
      });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const gates = selectGates(args);
  if (args.includes('--list')) {
    console.log('[verify] selected gates');
    for (const gate of gates) printGate(gate);
    return;
  }

  console.log(`[verify] repo: ${repoRoot}`);
  console.log(`[verify] gates: ${gates.map((gate) => gate.id).join(', ')}`);

  const failFast = args.includes('--fail-fast');
  const results = [];
  for (const gate of gates) {
    const result = await runGate(gate);
    results.push(result);
    if (!result.ok && failFast) break;
  }

  console.log('');
  console.log('[verify] summary');
  for (const result of results) {
    const mark = result.ok ? 'PASS' : 'FAIL';
    console.log(
      `  ${mark} ${result.gate.id} ${formatDuration(result.durationMs)} ${result.detail}`,
    );
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`[verify] failed ${failed.length} of ${results.length} selected gate(s)`);
    process.exitCode = 1;
    return;
  }

  console.log(`[verify] passed ${results.length} selected gate(s)`);
}

main().catch((error) => {
  console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
