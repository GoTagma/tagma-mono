#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), '..');
const shaPattern = /^[a-f0-9]{64}$/;
const defaultCatalog = 'architecture/quality/known-issues.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function safePath(root, value, kind, allowAbsolute = false) {
  if (
    (value !== '' && !nonempty(value)) ||
    (!allowAbsolute && isAbsolute(value)) ||
    value.includes('\0')
  )
    throw new Error('invalid_path');
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('outside_repository');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink_path');
  }
  const stat = lstatSync(absolute);
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()))
    throw new Error('wrong_path_type');
  return absolute;
}

function selectorValid(regression) {
  if (
    !regression ||
    !nonempty(regression.cwd) ||
    !nonempty(regression.file) ||
    !/\.test\.(?:tsx?|[cm]?js)$/.test(regression.file) ||
    !nonempty(regression.namePattern) ||
    !regression.namePattern.startsWith('^') ||
    !regression.namePattern.endsWith('$') ||
    !Number.isSafeInteger(regression.expectedTests) ||
    regression.expectedTests < 1
  )
    return false;
  try {
    new RegExp(regression.namePattern);
    const literal = regression.namePattern.slice(1, -1);
    if (!literal || /[\r\n]/.test(literal)) return false;
    for (let index = 0; index < literal.length; index += 1) {
      if (literal[index] === '\\') {
        if (!'\\^$.*+?()[]{}|'.includes(literal[++index] ?? '\0')) return false;
      } else if ('^$.*+?()[]{}|'.includes(literal[index])) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function appendFailure(receipt, kind, code, issueId, regressionIndex) {
  const entry = { kind, code };
  if (issueId) entry.issueId = issueId;
  if (regressionIndex !== undefined) entry.regressionIndex = regressionIndex;
  receipt.failures.push(entry);
}

function checkFile(receipt, root, reference, unavailableCode, mismatchCode, role) {
  try {
    const absolute = safePath(root, reference.path, 'file', true);
    const bytes = readFileSync(absolute);
    const actual = hash(bytes);
    receipt.files.push({
      role,
      path: relative(root, absolute).split(sep).join('/'),
      sha256: actual,
      bytes: bytes.length,
    });
    if (!shaPattern.test(reference.sha256 ?? ''))
      appendFailure(receipt, 'inventory', `${role}_hash_unknown`);
    else if (actual !== reference.sha256) appendFailure(receipt, 'inventory', mismatchCode);
    return absolute;
  } catch {
    appendFailure(receipt, 'inventory', unavailableCode);
    return null;
  }
}

function validateCatalog(catalog, root, receipt) {
  const selected = [];
  if (
    !catalog ||
    catalog.schemaVersion !== 1 ||
    !Array.isArray(catalog.sources) ||
    !Array.isArray(catalog.issues)
  ) {
    appendFailure(receipt, 'inventory', 'catalog_schema_invalid');
    return selected;
  }
  if (catalog.importComplete !== true) appendFailure(receipt, 'inventory', 'import_incomplete');
  if (catalog.issues.length === 0 || catalog.sources.length === 0)
    appendFailure(receipt, 'inventory', 'inventory_empty');
  const sourceIds = new Set();
  for (const source of catalog.sources) {
    if (!source || !nonempty(source.id) || sourceIds.has(source.id) || !nonempty(source.path)) {
      appendFailure(receipt, 'inventory', 'source_schema_invalid');
      continue;
    }
    sourceIds.add(source.id);
    checkFile(receipt, root, source, 'source_unavailable', 'source_hash_mismatch', 'source');
  }
  const issueIds = new Set();
  for (const issue of catalog.issues) {
    if (!issue || !nonempty(issue.id) || issueIds.has(issue.id)) {
      appendFailure(receipt, 'inventory', 'issue_identity_invalid');
      continue;
    }
    issueIds.add(issue.id);
    if (
      !['verified', 'unknown'].includes(issue.observationVerified) ||
      !['confirmed', 'unknown'].includes(issue.causeConfirmed) ||
      !['title', 'category', 'mechanism', 'status'].every((key) => nonempty(issue[key])) ||
      !['lineage', 'history', 'fixes', 'realTestSelectors'].every((key) =>
        Array.isArray(issue[key]),
      )
    ) {
      appendFailure(receipt, 'inventory', 'issue_schema_invalid', issue.id);
    }
    const first = issue.firstEvidence;
    if (first === null || first === undefined)
      appendFailure(receipt, 'inventory', 'first_evidence_missing', issue.id);
    else if (
      !sourceIds.has(first.sourceId) ||
      !nonempty(first.sourceRevision) ||
      !nonempty(first.acceptancePolicy) ||
      !(nonempty(first.round) || (Number.isSafeInteger(first.round) && first.round > 0)) ||
      !nonempty(first.path) ||
      !shaPattern.test(first.sha256 ?? '')
    ) {
      appendFailure(receipt, 'inventory', 'first_evidence_invalid', issue.id);
    } else
      checkFile(
        receipt,
        root,
        first,
        'first_evidence_unavailable',
        'first_evidence_hash_mismatch',
        'first_evidence',
      );
    if (!Array.isArray(issue.regressions) || issue.regressions.length === 0) {
      appendFailure(receipt, 'inventory', 'regression_mapping_missing', issue.id);
      continue;
    }
    const seen = new Set();
    for (const [index, regression] of issue.regressions.entries()) {
      if (!selectorValid(regression)) {
        appendFailure(receipt, 'inventory', 'regression_selector_invalid', issue.id, index);
        continue;
      }
      try {
        const cwd = safePath(root, regression.cwd, 'directory');
        const file = safePath(root, relative(root, resolve(cwd, regression.file)), 'file');
        const identity = canonical(regression);
        if (seen.has(identity)) {
          appendFailure(receipt, 'inventory', 'regression_mapping_duplicate', issue.id, index);
          continue;
        }
        seen.add(identity);
        const bytes = readFileSync(file);
        receipt.files.push({
          role: 'regression',
          path: relative(root, file).split(sep).join('/'),
          sha256: hash(bytes),
          bytes: bytes.length,
        });
        selected.push({ issueId: issue.id, index, regression, cwd, file });
      } catch {
        appendFailure(receipt, 'inventory', 'regression_path_invalid', issue.id, index);
      }
    }
  }
  receipt.issueCount = issueIds.size;
  receipt.regressionCount = selected.length;
  return selected;
}

function compareHistory(catalog, previous, receipt) {
  if (
    !previous ||
    previous.schemaVersion !== 1 ||
    !Array.isArray(previous.issues) ||
    !Array.isArray(previous.sources)
  ) {
    appendFailure(receipt, 'history', 'baseline_schema_invalid');
    return;
  }
  for (const field of ['intakeEvidence', 'handoff', 'requiredSources']) {
    if (previous[field] === undefined) continue;
    const preserved = Array.isArray(previous[field])
      ? Array.isArray(catalog[field]) &&
        same(catalog[field].slice(0, previous[field].length), previous[field])
      : same(catalog[field], previous[field]);
    if (!preserved) appendFailure(receipt, 'history', 'historical_intake_rewritten');
  }
  for (const source of previous.sources) {
    const current = catalog.sources?.find((entry) => entry.id === source.id);
    if (
      !current ||
      current.path !== source.path ||
      (source.sha256 !== null && current.sha256 !== source.sha256)
    ) {
      appendFailure(receipt, 'history', 'historical_source_rewritten');
    }
  }
  for (const prior of previous.issues) {
    const issue = catalog.issues?.find((entry) => entry.id === prior.id);
    if (!issue) {
      appendFailure(receipt, 'history', 'historical_issue_removed', prior.id);
      continue;
    }
    const stable = ['id', 'category', 'mechanism'];
    if (prior.firstEvidence !== null && prior.firstEvidence !== undefined)
      stable.push('firstEvidence');
    if (stable.some((key) => !same(issue[key], prior[key])))
      appendFailure(receipt, 'history', 'stable_identity_changed', prior.id);
    for (const field of [
      'lineage',
      'history',
      'fixes',
      'realTestSelectors',
      'reportedEvidence',
      'intakeEvidence',
    ]) {
      if (prior[field] === undefined) continue;
      const preserved = Array.isArray(prior[field])
        ? Array.isArray(issue[field]) &&
          same(issue[field].slice(0, prior[field].length), prior[field])
        : same(issue[field], prior[field]);
      if (!preserved) {
        appendFailure(receipt, 'history', `${field}_rewritten`, prior.id);
      }
    }
    if (
      !Array.isArray(prior.regressions) ||
      !Array.isArray(issue.regressions) ||
      prior.regressions.some((old) => !issue.regressions.some((current) => same(old, current)))
    ) {
      appendFailure(receipt, 'history', 'regression_mapping_rewritten', prior.id);
    }
  }
}

async function git(root, args) {
  return new Promise((done) => {
    const processGit = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let fault = false;
    const timer = setTimeout(() => {
      fault = true;
      processGit.kill('SIGKILL');
    }, 10000);
    processGit.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        fault = true;
        processGit.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    processGit.stderr.resume();
    processGit.stdout.on('error', () => {
      fault = true;
    });
    processGit.stderr.on('error', () => {
      fault = true;
    });
    processGit.on('error', () => {
      fault = true;
    });
    processGit.on('close', (status, signal) => {
      clearTimeout(timer);
      done({
        ok: status === 0 && !signal && !fault,
        status,
        fault,
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

async function readBaseline(options, catalog, receipt) {
  const catalogRelative = relative(options.repoRoot, options.catalogAbsolute).split(sep).join('/');
  const headCatalog = await git(options.repoRoot, ['show', `HEAD:${catalogRelative}`]);
  const headTree = await git(options.repoRoot, ['ls-tree', '-z', 'HEAD', '--', catalogRelative]);
  if (!headTree.ok || (headTree.stdout.length > 0 && !headCatalog.ok)) {
    appendFailure(receipt, 'environment', 'git_baseline_observation_failed');
    return;
  }
  if (headCatalog.fault) {
    appendFailure(receipt, 'environment', 'git_baseline_observation_failed');
    return;
  }
  if (options.initialImport) {
    receipt.baseline = { kind: 'explicit-initial-import', catalogAtHead: headCatalog.ok };
    if (options.previousPath) appendFailure(receipt, 'history', 'baseline_options_conflict');
    if (headCatalog.ok) appendFailure(receipt, 'history', 'initial_import_has_baseline');
    return;
  }
  if (headCatalog.ok) {
    try {
      compareHistory(catalog, JSON.parse(headCatalog.stdout), receipt);
    } catch {
      appendFailure(receipt, 'history', 'git_baseline_unreadable');
    }
  }
  try {
    let bytes;
    if (options.previousPath) {
      const previous = safePath(options.repoRoot, options.previousPath, 'file', true);
      if (previous === options.catalogAbsolute) {
        appendFailure(receipt, 'history', 'baseline_is_current_catalog');
        return;
      }
      bytes = readFileSync(previous);
      receipt.baseline = {
        kind: 'explicit-file',
        path: relative(options.repoRoot, previous).split(sep).join('/'),
        sha256: hash(bytes),
      };
    } else if (headCatalog.ok) {
      bytes = Buffer.from(headCatalog.stdout);
      receipt.baseline = {
        kind: 'git-head',
        revision: receipt.revision,
        path: catalogRelative,
        sha256: hash(bytes),
      };
    } else {
      appendFailure(receipt, 'history', 'baseline_missing_requires_initial_import');
      return;
    }
    if (options.previousPath) compareHistory(catalog, JSON.parse(bytes), receipt);
  } catch {
    appendFailure(receipt, 'history', 'baseline_unreadable');
  }
}

function publicSourcePath(path, tracked) {
  const parts = path.split('/');
  if (
    parts.some((part) =>
      [
        'work',
        'node_modules',
        'dist',
        'desktop-dist',
        'release',
        'coverage',
        'generated',
        'build',
        '.tmp',
        '.cache',
        '.tagma',
        '.opencode',
        'user-data',
      ].includes(part),
    )
  )
    return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:sqlite(?:3)?|db|log|pem|key))$/i.test(path))
    return false;
  const publicRootName =
    /^(?:package\.json|bun\.lock|(?:bunfig|tsconfig|eslint|prettier|\.prettier|\.gitattributes|\.gitignore|AGENTS|README)[\w.-]*)$/;
  return (
    (parts.length === 1 && (tracked || publicRootName.test(path))) ||
    ['apps', 'packages', 'scripts', 'architecture', '.agents', '.github'].includes(parts[0])
  );
}

async function sourceFingerprint(root) {
  const [tracked, untracked] = await Promise.all([
    git(root, ['ls-files', '--cached', '-z']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!tracked.ok || !untracked.ok) throw new Error('git_source_inventory_failed');
  const trackedPaths = new Set(tracked.stdout.split('\0').filter(Boolean));
  const paths = [...new Set([...trackedPaths, ...untracked.stdout.split('\0').filter(Boolean)])];
  const rows = [];
  for (const path of paths
    .filter((entry) => publicSourcePath(entry, trackedPaths.has(entry)))
    .sort()) {
    try {
      const file = safePath(root, path, 'file');
      const bytes = readFileSync(file);
      rows.push({
        path,
        sha256: hash(bytes),
        bytes: bytes.length,
        mode: lstatSync(file).mode & 0o777,
      });
    } catch (error) {
      // A tracked deletion is part of the actual source, rather than a read of the old blob.
      if (error.code === 'ENOENT') rows.push({ path, absent: true });
      else throw error;
    }
  }
  if (rows.length === 0) throw new Error('source_inventory_empty');
  return { scheme: 'public-git-visible-v1', fileCount: rows.length, sha256: hash(canonical(rows)) };
}

function xmlValue(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);)/.test(value))
    throw new Error('unknown_xml_entity');
  const decoded = value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);/g, (entity) => {
    const known = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (known[entity] !== undefined) return known[entity];
    const number = entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number(entity.slice(2, -1));
    return String.fromCodePoint(number);
  });
  return decoded;
}

export function parseBunJunit(xml, namePattern, expectedTests) {
  const failed = { passed: false, matched: 0, executed: 0, code: 'junit_execution_unproven' };
  try {
    if (/<!DOCTYPE|<!ENTITY/.test(xml)) return failed;
    const tokens =
      xml.match(/<\?xml[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[a-zA-Z][^>]*>|[^<]+/g) ?? [];
    if (tokens.join('') !== xml) return failed;
    const stack = [];
    const rows = [];
    let roots = 0;
    let rootCounts;
    let current;
    for (const token of tokens) {
      if (token.startsWith('<?xml') || token.startsWith('<![CDATA[') || !token.startsWith('<'))
        continue;
      const closing = token.match(/^<\/([a-z]+)>$/);
      if (closing) {
        const ended = stack.pop();
        if (!ended || ended.tag !== closing[1]) return failed;
        if (ended.tag === 'testcase') {
          rows.push(current);
          current = undefined;
        }
        continue;
      }
      const opening = token.match(/^<([a-z]+)([\s\S]*?)(\s*\/)?\s*>$/);
      if (
        !opening ||
        ![
          'testsuites',
          'testsuite',
          'testcase',
          'skipped',
          'failure',
          'error',
          'system-out',
          'system-err',
        ].includes(opening[1])
      )
        return failed;
      const attrs = {};
      let attrsText = opening[2].trim();
      for (const match of attrsText.matchAll(/([a-zA-Z][\w.-]*)="([^"]*)"/g)) {
        if (Object.hasOwn(attrs, match[1])) return failed;
        attrs[match[1]] = xmlValue(match[2]);
        attrsText = attrsText.replace(match[0], '').trim();
      }
      if (attrsText) return failed;
      const tag = opening[1];
      if (tag === 'testsuites') {
        if (stack.length !== 0 || ++roots !== 1) return failed;
        rootCounts = attrs;
      }
      if (tag === 'testcase') {
        if (current || !nonempty(attrs.name) || !stack.some((entry) => entry.tag === 'testsuite'))
          return failed;
        const suites = stack
          .filter((entry) => entry.tag === 'testsuite')
          .slice(1)
          .map((entry) => entry.attrs.name);
        current = { name: [...suites, attrs.name].join(' '), status: 'pass' };
      }
      if (tag === 'skipped' || tag === 'failure' || tag === 'error') {
        if (!current) return failed;
        current.status = tag === 'skipped' ? 'skip' : 'fail';
      }
      if (!opening[3]) stack.push({ tag, attrs });
      else if (tag === 'testcase') {
        rows.push(current);
        current = undefined;
      }
    }
    if (
      stack.length ||
      roots !== 1 ||
      !rootCounts ||
      Number(rootCounts.tests) !== rows.length ||
      Number(rootCounts.failures) !== rows.filter((row) => row.status === 'fail').length ||
      Number(rootCounts.skipped) !== rows.filter((row) => row.status === 'skip').length
    )
      return failed;
    const expression = new RegExp(namePattern);
    const selected = rows.filter((row) => {
      const match = expression.exec(row.name);
      return match && match.index === 0 && match[0].length === row.name.length;
    });
    const executed = selected.filter((row) => row.status !== 'skip').length;
    return {
      passed:
        selected.length === expectedTests &&
        executed === expectedTests &&
        selected.every((row) => row.status === 'pass'),
      matched: selected.length,
      executed,
      code: selected.some((row) => row.status === 'skip')
        ? 'junit_selected_skip_or_todo'
        : selected.some((row) => row.status === 'fail')
          ? 'junit_assertion_failure'
          : selected.length !== expectedTests
            ? 'junit_count_mismatch'
            : 'junit_verified_execution',
    };
  } catch {
    return failed;
  }
}

export function parseBunOutput(output, namePattern, expectedTests) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r\n', '\n');
  const names = [];
  const summary = { pass: [], fail: [], skip: [], todo: [], ran: [] };
  let unknownStatus = false;
  for (const line of text.split('\n')) {
    const row = line.match(/^\((pass|fail|skip|todo)\) (.+?)(?: \[[\d.]+(?:ms|s)\])?$/);
    if (row) {
      names.push({ status: row[1], name: row[2].replaceAll(' > ', ' ') });
      continue;
    }
    if (/^\([^)]*\) /.test(line)) unknownStatus = true;
    const count = line.match(/^\s*(\d+) (pass|fail|skip|todo)\s*$/);
    if (count) summary[count[2]].push(Number(count[1]));
    const ran = line.match(/^Ran (\d+) tests? across (\d+) files?\. \[[\d.]+(?:ms|s)\]$/);
    if (ran) summary.ran.push({ tests: Number(ran[1]), files: Number(ran[2]) });
  }
  const pattern = new RegExp(namePattern);
  const selected = names.filter((entry) => {
    const match = pattern.exec(entry.name);
    return match && match.index === 0 && match[0].length === entry.name.length;
  });
  const passedCount = selected.filter((entry) => entry.status === 'pass').length;
  const failCount = selected.filter((entry) => entry.status === 'fail').length;
  const unexecuted = selected.filter(
    (entry) => entry.status === 'skip' || entry.status === 'todo',
  ).length;
  const coherent =
    !unknownStatus &&
    summary.pass.length === 1 &&
    summary.fail.length === 1 &&
    summary.skip.length <= 1 &&
    summary.todo.length <= 1 &&
    summary.ran.length === 1 &&
    summary.ran[0].files === 1 &&
    summary.ran[0].tests === names.length &&
    summary.pass[0] === names.filter((entry) => entry.status === 'pass').length &&
    summary.fail[0] === names.filter((entry) => entry.status === 'fail').length &&
    (summary.skip[0] ?? 0) === names.filter((entry) => entry.status === 'skip').length &&
    (summary.todo[0] ?? 0) === names.filter((entry) => entry.status === 'todo').length;
  const passed =
    coherent &&
    selected.length === expectedTests &&
    passedCount === expectedTests &&
    names.length === selected.length &&
    summary.fail[0] === 0 &&
    unexecuted === 0;
  return {
    passed,
    coherent,
    executed: passedCount + failCount,
    matched: selected.length,
    passedCount,
    failCount,
    unexecuted,
    code: passed
      ? 'verified_execution'
      : unexecuted > 0
        ? 'selected_skip_or_todo'
        : failCount > 0
          ? 'test_assertion_failure'
          : /matched 0 tests?/.test(text)
            ? 'selector_no_match'
            : coherent
              ? 'execution_count_mismatch'
              : 'execution_output_unproven',
  };
}

function reducedEnvironment(environment) {
  const env = { ...environment, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of Object.keys(env)) {
    if (
      /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) ||
      /^(?:OPENAI|DEEPSEEK|ANTHROPIC|GEMINI|GOOGLE_APPLICATION_CREDENTIALS|AZURE_OPENAI|AWS_|OPENCODE)/i.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

async function child(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveChild) => {
    const outputs = [];
    let length = 0;
    let captureFault = false;
    let timedOut = false;
    let spawnError = false;
    const processChild = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      processChild.kill('SIGTERM');
    }, timeoutMs);
    const deadline = setTimeout(() => {
      if (timedOut) processChild.kill('SIGKILL');
    }, timeoutMs + 1000);
    const drainDeadline = setTimeout(() => {
      timedOut = true;
      captureFault = true;
      processChild.kill('SIGKILL');
      processChild.stdout.destroy();
      processChild.stderr.destroy();
    }, timeoutMs + 2000);
    const capture = (data) => {
      length += data.length;
      if (length > 16 * 1024 * 1024) {
        captureFault = true;
        processChild.kill('SIGKILL');
      } else outputs.push(data);
    };
    for (const stream of [processChild.stdout, processChild.stderr]) {
      stream.on('data', capture);
      stream.on('error', () => {
        captureFault = true;
      });
    }
    processChild.on('error', () => {
      spawnError = true;
    });
    processChild.on('close', (status, signal) => {
      clearTimeout(timer);
      clearTimeout(deadline);
      clearTimeout(drainDeadline);
      resolveChild({
        status,
        signal,
        spawnError,
        timedOut,
        captureFault,
        output: Buffer.concat(outputs),
        bytes: length,
      });
    });
  });
}

function writeReceipt(root, path, receipt, protectedFiles) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    protectedFiles.has(absolute) ||
    rel.split(sep)[0] !== 'work'
  )
    throw new Error('invalid_receipt_path');
  mkdirSync(dirname(absolute), { recursive: true });
  safePath(root, relative(root, dirname(absolute)), 'directory');
  try {
    safePath(root, relative(root, absolute), 'file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, absolute);
}

export async function runGate(input = {}) {
  const receipt = {
    schemaVersion: 1,
    passed: false,
    startedAt: new Date().toISOString(),
    revision: null,
    catalog: null,
    baseline: null,
    issueCount: 0,
    regressionCount: 0,
    networkIsolation: 'not_claimed',
    providerCredentialEnvironment: 'removed',
    files: [],
    results: [],
    failures: [],
  };
  const options = {
    repoRoot: defaultRoot,
    catalogPath: defaultCatalog,
    bunBin: process.env.KNOWN_ISSUE_BUN_BIN ?? 'bun',
    timeoutMs: 60000,
    ...input,
  };
  let catalog;
  let selected = [];
  let root;
  try {
    root = realpathSync(options.repoRoot);
    options.repoRoot = root;
    const revision = await git(root, ['rev-parse', 'HEAD']);
    if (revision.fault) appendFailure(receipt, 'environment', 'git_revision_observation_failed');
    else if (!revision.ok) appendFailure(receipt, 'environment', 'git_revision_unavailable');
    receipt.revision = revision.ok ? revision.stdout.trim() : null;
    options.catalogAbsolute = safePath(root, options.catalogPath, 'file', true);
    const bytes = readFileSync(options.catalogAbsolute);
    receipt.catalog = {
      path: relative(root, options.catalogAbsolute).split(sep).join('/'),
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    catalog = JSON.parse(bytes);
    receipt.scope = catalog.scope ?? 'historical';
    receipt.historicalCoverageComplete =
      receipt.scope === 'historical' && catalog.importComplete === true;
    if (!['historical', 'current-source'].includes(receipt.scope))
      appendFailure(receipt, 'inventory', 'catalog_scope_invalid');
    selected = validateCatalog(catalog, root, receipt);
    await readBaseline(options, catalog, receipt);
    try {
      receipt.sourceFingerprint = await sourceFingerprint(root);
    } catch {
      appendFailure(receipt, 'environment', 'source_fingerprint_unavailable');
    }
  } catch {
    appendFailure(receipt, 'inventory', 'catalog_unreadable');
  }

  if (receipt.failures.length === 0) {
    const env = reducedEnvironment(options.environment ?? process.env);
    const runtime = spawnSync(options.bunBin, ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    let expectedVersion = '1.3.14';
    try {
      expectedVersion = JSON.parse(
        readFileSync(resolve(root, 'package.json')),
      ).packageManager.match(/^bun@([\d.]+)$/)[1];
    } catch {
      /* Fixture roots use the repository pin. */
    }
    receipt.runtime = {
      expectedVersion,
      version: /^[\d.]+$/.test(runtime.stdout?.trim() ?? '') ? runtime.stdout.trim() : null,
    };
    if (runtime.status !== 0 || receipt.runtime.version !== expectedVersion)
      appendFailure(receipt, 'environment', 'bun_runtime_unavailable_or_wrong_version');
    for (const selection of selected) {
      if (receipt.failures.length > 0) break;
      const { regression, cwd, file, issueId, index } = selection;
      const fileArgument = `./${relative(cwd, file).split(sep).join('/')}`;
      const reportRoot = mkdtempSync(join(tmpdir(), 'tagma-known-issue-junit-'));
      const junitPath = join(reportRoot, 'results.xml');
      const result = await child(
        options.bunBin,
        [
          'test',
          fileArgument,
          '-t',
          regression.namePattern,
          '--reporter=junit',
          `--reporter-outfile=${junitPath}`,
        ],
        { cwd, env, timeoutMs: options.timeoutMs },
      );
      const parsed = parseBunOutput(
        result.output.toString('utf8'),
        regression.namePattern,
        regression.expectedTests,
      );
      let junit = { passed: false, code: 'junit_missing', matched: 0, executed: 0 };
      let junitSha256 = null;
      let junitBytes = 0;
      try {
        if (!lstatSync(junitPath).isFile() || lstatSync(junitPath).isSymbolicLink())
          throw new Error('junit_not_regular');
        const bytes = readFileSync(junitPath);
        junitSha256 = hash(bytes);
        junitBytes = bytes.length;
        junit = parseBunJunit(
          bytes.toString('utf8'),
          regression.namePattern,
          regression.expectedTests,
        );
      } catch {
        /* A missing or malformed report cannot prove a test executed. */
      } finally {
        rmSync(reportRoot, { recursive: true, force: true });
      }
      const qualificationEnvironmentSentinel = result.output
        .toString('utf8')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .match(
          /^error: (qualification_Node_(?:environment_(?:unavailable|invalid_response|not_actual_Node)|fixture_environment_failure))\r?$/m,
        )?.[1];
      let classification = 'execution_unproven';
      let code = parsed.code;
      if (result.spawnError || result.timedOut || result.captureFault || result.signal) {
        classification = 'environment_failure';
        code = result.spawnError
          ? 'child_spawn_failed'
          : result.timedOut
            ? 'child_timeout'
            : result.captureFault
              ? 'output_capture_failure'
              : 'child_signalled';
      } else if (
        /Cannot find (?:module|package)|ModuleNotFound|error: (?:Could not resolve|Cannot resolve)|SyntaxError:/.test(
          result.output.toString('utf8'),
        )
      ) {
        classification = 'environment_failure';
        code = 'test_import_failure';
      } else if (qualificationEnvironmentSentinel) {
        classification = 'environment_failure';
        code = qualificationEnvironmentSentinel;
      } else if (parsed.failCount > 0) classification = 'assertion_failure';
      else if (
        result.status === 0 &&
        parsed.passed &&
        junit.passed &&
        parsed.executed === junit.executed &&
        parsed.matched === junit.matched
      )
        classification = 'pass';
      else if (parsed.passed && !junit.passed) code = junit.code;
      receipt.results.push({
        issueId,
        regressionIndex: index,
        cwd: regression.cwd,
        file: regression.file,
        namePattern: regression.namePattern,
        expectedTests: regression.expectedTests,
        executed: parsed.executed,
        matched: parsed.matched,
        pass: parsed.passedCount,
        fail: parsed.failCount,
        skipOrTodo: parsed.unexecuted,
        status: result.status,
        signal: result.signal,
        classification,
        code,
        outputBytes: result.bytes,
        outputSha256: hash(result.output),
        junitSha256,
        junitBytes,
        junitExecutionVerified: junit.passed,
      });
      if (classification !== 'pass')
        appendFailure(
          receipt,
          classification === 'environment_failure' ? 'environment' : classification,
          code,
          issueId,
          index,
        );
    }
    if (receipt.failures.length === 0) {
      const snapshots = [...receipt.files, { ...receipt.catalog, role: 'catalog' }];
      for (const snapshot of snapshots) {
        try {
          const absolute = safePath(root, snapshot.path, 'file');
          if (hash(readFileSync(absolute)) !== snapshot.sha256)
            appendFailure(receipt, 'integrity', 'input_changed_during_regressions');
        } catch {
          appendFailure(receipt, 'integrity', 'input_unavailable_after_regressions');
        }
      }
      if (receipt.results.length !== selected.length || receipt.results.length === 0)
        appendFailure(receipt, 'integrity', 'execution_inventory_incomplete');
      try {
        if (!same(await sourceFingerprint(root), receipt.sourceFingerprint))
          appendFailure(receipt, 'integrity', 'source_changed_during_regressions');
      } catch {
        appendFailure(receipt, 'integrity', 'source_fingerprint_unavailable_after_regressions');
      }
    }
  }
  receipt.passed = receipt.failures.length === 0;
  receipt.historicalCoverageComplete = receipt.passed && receipt.scope === 'historical';
  receipt.finishedAt = new Date().toISOString();
  if (options.receiptPath && root) {
    try {
      const protectedFiles = new Set(receipt.files.map((file) => resolve(root, file.path)));
      if (options.catalogAbsolute) protectedFiles.add(options.catalogAbsolute);
      if (options.previousPath) protectedFiles.add(resolve(root, options.previousPath));
      writeReceipt(root, options.receiptPath, receipt, protectedFiles);
    } catch {
      appendFailure(receipt, 'environment', 'receipt_write_failed');
      receipt.passed = false;
      receipt.historicalCoverageComplete = false;
    }
  }
  return receipt;
}

export async function checkReceipt(input) {
  const result = { schemaVersion: 1, passed: false, check: 'current-source-receipt', failures: [] };
  try {
    const root = realpathSync(input.repoRoot ?? defaultRoot);
    const path = safePath(root, input.receiptPath, 'file', true);
    const receipt = JSON.parse(readFileSync(path));
    if (
      receipt.schemaVersion !== 1 ||
      receipt.passed !== true ||
      !receipt.catalog ||
      !receipt.sourceFingerprint ||
      !Array.isArray(receipt.results) ||
      receipt.results.length === 0 ||
      receipt.results.some(
        (entry) => entry.classification !== 'pass' || entry.junitExecutionVerified !== true,
      )
    ) {
      appendFailure(result, 'integrity', 'receipt_is_not_verified_pass');
      return result;
    }
    result.receiptSha256 = hash(readFileSync(path));
    if (hash(readFileSync(safePath(root, receipt.catalog.path, 'file'))) !== receipt.catalog.sha256)
      appendFailure(result, 'integrity', 'receipt_catalog_changed');
    for (const file of receipt.files) {
      if (hash(readFileSync(safePath(root, file.path, 'file'))) !== file.sha256)
        appendFailure(result, 'integrity', 'receipt_input_changed');
    }
    const current = await sourceFingerprint(root);
    if (!same(current, receipt.sourceFingerprint))
      appendFailure(result, 'integrity', 'receipt_source_changed');
    result.sourceFingerprint = current;
    result.passed = result.failures.length === 0;
  } catch {
    appendFailure(result, 'integrity', 'receipt_or_source_unreadable');
  }
  return result;
}

function parseArgs(args) {
  const options = {};
  const flags = new Map([
    ['--catalog', 'catalogPath'],
    ['--previous', 'previousPath'],
    ['--receipt', 'receiptPath'],
    ['--bun', 'bunBin'],
    ['--check-receipt', 'checkReceiptPath'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--initial-import') options.initialImport = true;
    else if (flags.has(arg) && nonempty(args[index + 1]) && !args[index + 1].startsWith('--'))
      options[flags.get(arg)] = args[++index];
    else throw new Error('invalid_cli_arguments');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const receipt = options.checkReceiptPath
      ? await checkReceipt({ receiptPath: options.checkReceiptPath })
      : await runGate(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    process.exitCode = receipt.passed ? 0 : 1;
  } catch {
    process.stderr.write('known-issue-regressions: invalid CLI arguments\n');
    process.exitCode = 1;
  }
}
