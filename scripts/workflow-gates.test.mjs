import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish-npm.yml', import.meta.url),
  'utf8',
);
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseDesktopWorkflow = readFileSync(
  new URL('../.github/workflows/release-desktop.yml', import.meta.url),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function stepIndex(text, name) {
  const needle = `- name: ${name}`;
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `missing workflow step: ${name}`);
  return index;
}

function stepBlock(text, name, nextName) {
  const start = stepIndex(text, name);
  const end = stepIndex(text, nextName);
  assert(start < end, `${name} must appear before ${nextName}`);
  return text.slice(start, end);
}

test('publish-npm validates only public npm packages before npm auth', () => {
  const selection = stepIndex(workflow, 'Validate package selection');
  const validation = stepIndex(workflow, 'Validate npm packages');
  const auth = stepIndex(workflow, 'Configure npm auth');
  const validationBlock = workflow.slice(validation, auth);
  const requiredCommands = [
    'bun run check:deps',
    'bun run check:publish',
    'bun run check:public',
    'bun run test:public',
    'bun run lint:public',
  ];

  assert(selection < validation, 'package selection must be validated before npm package gates');
  assert(validation < auth, 'npm package gates must run before npm auth is configured');

  let previous = -1;
  for (const command of requiredCommands) {
    const index = validationBlock.indexOf(command);
    assert.notEqual(index, -1, `missing npm validation command: ${command}`);
    assert(previous < index, `${command} must run in npm validation order`);
    previous = index;
  }

  assert.doesNotMatch(validationBlock, /^\s*bun run (?:check|test|lint)\s*$/m);
  assert.doesNotMatch(validationBlock, /tagma-editor|tagma-desktop/);
  assert.doesNotMatch(
    workflow,
    /^\s*- name: (?:Install dependencies|Text hygiene|Type check|Test|Lint|Publish metadata check)\s*$/m,
  );
});

test('publish-npm passes Bun its token without writing npm auth files', () => {
  const auth = stepIndex(workflow, 'Configure npm auth');
  const publish = stepIndex(workflow, 'Publish packages in dependency order');
  const authBlock = workflow.slice(auth, publish);
  const publishBlock = workflow.slice(publish);

  assert.match(authBlock, /NPM_CONFIG_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(authBlock, /if \[ -z "\$NPM_CONFIG_TOKEN" \]/);
  assert.match(authBlock, /NPM_TOKEN is required/);
  assert.match(publishBlock, /NPM_CONFIG_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /_authToken|tee \.npmrc|Cleanup npm auth/);
});

test('publish-npm retries transient failures without overwriting an existing version', () => {
  const publish = stepIndex(workflow, 'Publish packages in dependency order');
  const block = workflow.slice(publish);
  const precheck = block.indexOf('if registry_has_version "$package_dir"');
  const publishAttempt = block.indexOf('if bun run "$script"');
  const postFailureCheck = block.indexOf('if registry_has_version "$package_dir"', precheck + 1);

  assert.match(block, /npm view "\$\{name\}@\$\{version\}" version/);
  assert.match(block, /for attempt in 1 2 3/);
  assert.notEqual(precheck, -1, 'publish must skip a version already in the registry');
  assert.notEqual(publishAttempt, -1, 'publish attempt is missing');
  assert.notEqual(postFailureCheck, -1, 'publish must reconcile an ambiguous failed response');
  assert(precheck < publishAttempt, 'registry precheck must run before publish');
  assert(publishAttempt < postFailureCheck, 'ambiguous-response reconciliation must follow publish');
});

test('ci full-check runs repository hygiene gates before type/test/lint', () => {
  const typeCheck = stepIndex(ciWorkflow, 'Type check');
  const requiredSteps = [
    'Dependency & lockfile integrity',
    'Focused and disabled tests',
    'Phantom imports',
    'Workspace dependency cycles',
    'Secret scan',
    'Format check',
    'Publish metadata check',
  ];

  for (const step of requiredSteps) {
    assert(stepIndex(ciWorkflow, step) < typeCheck, `${step} must run before Type check`);
  }
});

test('ci full-check executes the repository script-test gate', () => {
  const scriptTests = stepIndex(ciWorkflow, 'Script tests');
  const repositoryTests = stepIndex(ciWorkflow, 'Test');
  const block = ciWorkflow.slice(scriptTests, repositoryTests);

  assert(scriptTests < repositoryTests, 'script tests must run before the repository test suite');
  assert.match(block, /run:\s*bun run test:scripts/);
});

test('ci validates the pinned OpenCode database upgrade and downgrade cycle on every desktop OS', () => {
  const managedStart = ciWorkflow.indexOf('  managed-opencode-runtime:');
  const fullCheckStart = ciWorkflow.indexOf('  full-check:');
  assert.notEqual(managedStart, -1, 'missing managed-opencode-runtime job');
  assert.notEqual(fullCheckStart, -1, 'missing full-check job');
  const block = ciWorkflow.slice(managedStart, fullCheckStart);

  assert.match(block, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(block, /fetch-opencode-upgrade-fixture\.mjs/);
  assert.match(block, /TAGMA_OPENCODE_NATIVE_UPGRADE_SMOKE:\s*'1'/);
  assert.match(block, /opencode-managed-upgrade-smoke\.test\.ts/);
});

test('ci fork check runs read-only hygiene gates before public package checks', () => {
  const publicTypeCheck = stepIndex(ciWorkflow, 'Type check public packages');
  const requiredSteps = [
    'Dependency & lockfile integrity',
    'Focused and disabled tests',
    'Phantom imports',
    'Workspace dependency cycles',
    'Secret scan',
    'Format check',
  ];

  for (const step of requiredSteps) {
    const first = ciWorkflow.indexOf(`- name: ${step}`);
    const second = ciWorkflow.indexOf(`- name: ${step}`, first + 1);
    assert.notEqual(second, -1, `missing fork workflow step: ${step}`);
    assert(second < publicTypeCheck, `${step} must run before fork public type check`);
  }
});

test('test:scripts runs both node mjs tests and Bun TypeScript script tests', () => {
  const script = packageJson.scripts?.['test:scripts'];

  assert.match(script, /^node scripts\/run-node-tests\.mjs &&/);
  assert.doesNotMatch(script, /node --test ["']?scripts\/\*\*\/\*\.test\.mjs/);
  assert.match(script, /bun test/);
  assert.match(script, /scripts\/\*\*\/\*\.test\.ts/);
});

test('repository pins formatted text to LF across Windows checkouts', () => {
  const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.bat text eol=crlf$/m);
  assert.match(attributes, /^\*\.cmd text eol=crlf$/m);
});

test('release-desktop stages OpenCode for every hot-update manifest target', () => {
  const block = stepBlock(
    releaseDesktopWorkflow,
    'Stage bundled opencode binary',
    'Stage bundled Bun binary',
  );
  const targets = [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['win32', 'x64'],
  ];

  for (const [platform, arch] of targets) {
    assert.match(
      block,
      new RegExp(`fetch-opencode\\.mjs --platform=${platform} --arch=${arch}\\b`),
      `missing OpenCode staging for ${platform}/${arch}`,
    );
  }
  assert.doesNotMatch(
    block,
    /fetch-opencode\.mjs --platform=linux --arch=arm64\b/,
    'release must not stage linux/arm64 OpenCode unless linux/arm64 is a published hot-update target',
  );
});

test('release-desktop does not publish linux arm64 sidecar-only hot-update assets', () => {
  assert.doesNotMatch(
    releaseDesktopWorkflow,
    /Cross-compile Linux arm64 sidecar|bun-linux-arm64|desktop-dist-arm64/,
    'linux/arm64 sidecars must not be produced without a matching published OpenCode target',
  );
});

test('release-desktop commits a validated bun.lock with the desktop version bump', () => {
  const setupBun = stepIndex(releaseDesktopWorkflow, 'Set up Bun for lockfile synchronization');
  const commitStep = stepIndex(
    releaseDesktopWorkflow,
    'Commit desktop bump, tag, push to tagma-mono',
  );
  const block = stepBlock(
    releaseDesktopWorkflow,
    'Commit desktop bump, tag, push to tagma-mono',
    'Create GitHub Release',
  );
  const applyPackage = block.indexOf('cp overlay/package.json apps/electron/package.json');
  const refreshLock = block.indexOf('bun install --lockfile-only --ignore-scripts');
  const validateLock = block.indexOf('bun run check:deps');
  const stageLock = block.indexOf('git add bun.lock');
  const commit = block.indexOf('git commit -m');

  assert(setupBun < commitStep, 'finalize must install the pinned Bun before updating bun.lock');
  assert.notEqual(applyPackage, -1, 'finalize must apply the released package.json first');
  assert(
    applyPackage < refreshLock,
    'finalize must refresh bun.lock after applying the released package.json',
  );
  assert(
    refreshLock < validateLock,
    'finalize must validate dependency metadata after refreshing bun.lock',
  );
  assert(
    validateLock < stageLock,
    'finalize must validate bun.lock before staging the release transaction',
  );
  assert(stageLock < commit, 'bun.lock must be staged in the same release commit');
});
