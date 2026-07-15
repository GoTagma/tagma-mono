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

test('publish-npm validates package selection and runs gates before npm auth', () => {
  const auth = stepIndex(workflow, 'Configure npm auth');
  const requiredSteps = [
    'Validate package selection',
    'Text hygiene',
    'Type check',
    'Test',
    'Lint',
    'Publish metadata check',
  ];

  for (const step of requiredSteps) {
    assert(stepIndex(workflow, step) < auth, `${step} must run before npm auth is configured`);
  }
});

test('publish-npm rejects a missing token before writing npm auth files', () => {
  const auth = stepIndex(workflow, 'Configure npm auth');
  const cleanup = stepIndex(workflow, 'Cleanup npm auth');
  const authBlock = workflow.slice(auth, cleanup);

  assert.match(authBlock, /if \[ -z "\$NPM_TOKEN" \]/);
  assert.match(authBlock, /NPM_TOKEN is required/);
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

  assert.match(script, /node scripts\/run-node-tests\.mjs/);
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
