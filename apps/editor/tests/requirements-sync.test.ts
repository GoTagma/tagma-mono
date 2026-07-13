import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractBinariesFromYaml,
  parseRequirementsMd,
  requirementsPath,
  runRequirementsSync,
  serializeRequirementsMd,
  type RequirementsFrontmatter,
} from '../server/requirements-sync';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWorkspace(): { root: string; tagmaDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-req-sync-'));
  tempRoots.push(root);
  const tagmaDir = join(root, '.tagma');
  mkdirSync(tagmaDir, { recursive: true });
  return { root, tagmaDir };
}

function writeYaml(tagmaDir: string, name: string, content: string): string {
  const yamlPath = join(tagmaDir, name);
  writeFileSync(yamlPath, content, 'utf-8');
  return yamlPath;
}

test('extractBinariesFromYaml pulls command first-tokens, dedupes, sorts', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'multi.yaml',
    [
      'pipeline:',
      '  name: multi',
      '  tracks:',
      '    - id: build',
      '      name: Build',
      '      tasks:',
      '        - id: clone',
      '          command: "git clone https://example.com/repo"',
      '        - id: deps',
      '          command: "bun install"',
      '        - id: argv',
      '          command:',
      '            argv: ["bun", "run", "build"]',
      '        - id: shell',
      '          command:',
      '            shell: "FOO=bar python script.py"',
      '    - id: deploy',
      '      name: Deploy',
      '      tasks:',
      '        - id: push',
      '          command: "git push origin main"',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  const names = binaries!.map((b) => b.name);
  expect(names).toEqual(['bun', 'git', 'python']);

  const git = binaries!.find((b) => b.name === 'git')!;
  expect(git.usedBy).toEqual(['build.clone', 'deploy.push']);
  expect(git.probe).toBe('git --version');

  const bun = binaries!.find((b) => b.name === 'bun')!;
  expect(bun.usedBy).toEqual(['build.deps', 'build.argv']);
});

test('extractBinariesFromYaml scans shell command chains without treating builtins as requirements', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'shell-chain.yaml',
    [
      'pipeline:',
      '  name: shell chain',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: chained',
      '          command: "cd src; $env:FOO=bar; git status && bun test | jq ."',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  expect(binaries!.map((b) => b.name)).toEqual(['bun', 'git', 'jq']);
  expect(binaries!.find((b) => b.name === 'git')!.usedBy).toEqual(['main.chained']);
});

test('extractBinariesFromYaml ignores Tagma input placeholder filters', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'input-placeholders.yaml',
    [
      'pipeline:',
      '  name: input placeholders',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: fetch',
      '          command: "powershell -File helper.ps1 -Description {{inputs.description | shellquote}} -Limit {{inputs.limit}}"',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  expect(binaries!.map((binary) => binary.name)).toEqual(['powershell']);
});

test('extractBinariesFromYaml maps prompt-task drivers via DRIVER_BINARIES', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'prompts.yaml',
    [
      'pipeline:',
      '  name: prompts',
      '  driver: claude-code',
      '  tracks:',
      '    - id: review',
      '      name: Review',
      '      tasks:',
      '        - id: read',
      '          prompt: "Read this code"',
      '        - id: write',
      '          driver: codex',
      '          prompt: "Write tests"',
      '        - id: builtin',
      '          driver: opencode',
      '          prompt: "default driver, no extra binary"',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  const names = binaries!.map((b) => b.name);
  expect(names).toContain('claude');
  expect(names).toContain('codex');
  // SDK/CLI runs still execute `opencode run`, so exported pipelines must declare it.
  expect(names).toContain('opencode');

  const opencode = binaries!.find((b) => b.name === 'opencode')!;
  expect(opencode.fromDriver).toBe('opencode');
  expect(opencode.usedBy).toEqual(['review.builtin']);

  const claude = binaries!.find((b) => b.name === 'claude')!;
  expect(claude.fromDriver).toBe('claude-code');
  expect(claude.usedBy).toEqual(['review.read']);
});

test('extractBinariesFromYaml ignores local script paths in commands and hooks', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'scripts.yaml',
    [
      'pipeline:',
      '  name: scripts',
      '  hooks:',
      '    pipeline_start: "scripts/setup.sh"',
      '    task_failure:',
      '      - "./scripts/cleanup.sh"',
      '      - "git stash"',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: run',
      '          command: "./scripts/run.sh"',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  // Only `git` (from task_failure hook) survives — every script-path entry is filtered.
  expect(binaries!.map((b) => b.name)).toEqual(['git']);
  expect(binaries![0]!.usedBy).toEqual(['hooks.task_failure']);
});

test('extractBinariesFromYaml includes output_check completion command dependencies', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'completion.yaml',
    [
      'pipeline:',
      '  name: completion',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: run',
      '          command: "git status"',
      '          completion:',
      '            type: output_check',
      '            check: "jq -e .ok"',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  expect(binaries!.map((b) => b.name)).toEqual(['git', 'jq']);
  expect(binaries!.find((b) => b.name === 'jq')!.usedBy).toEqual([
    'main.run.completion.output_check',
  ]);
});

test('extractBinariesFromYaml skips token extraction for multi-line script command blocks', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'ps-multiline.yaml',
    [
      'pipeline:',
      '  name: ps multiline',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: run',
      '          command: |',
      '            try {',
      '                $emails = @()',
      '                $payload | ConvertTo-Json -Depth 5 | Set-Content -Path emails.json -Encoding UTF8',
      '                $report = @{ moved = 0; flagged = 0; categorized = 0; errors = 0 }',
      '            } catch {',
      '                Write-Host "error"',
      '            }',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  // Multi-line script: the shell-ish token scanner cannot reliably tell PS cmdlets,
  // keywords, or `@{ k = v; ... }` hashtable keys apart from real PATH binaries.
  // Bail out instead of fabricating bogus requirements like `try` / `flagged` / `ConvertTo-Json`.
  expect(binaries!.map((b) => b.name)).toEqual([]);
});

test('extractBinariesFromYaml skips token extraction for multi-line command.shell strings', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'shell-multiline.yaml',
    [
      'pipeline:',
      '  name: shell multiline',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: run',
      '          command:',
      '            shell: |',
      '              try {',
      '                  $report = @{ moved = 0; flagged = 0 }',
      '              } catch { Write-Host err }',
      '',
    ].join('\n'),
  );

  const binaries = extractBinariesFromYaml(yamlPath);
  expect(binaries).not.toBeNull();
  expect(binaries!.map((b) => b.name)).toEqual([]);
});

test('extractBinariesFromYaml returns null on YAML parse error so sync skips overwrite', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(tagmaDir, 'bad.yaml', 'pipeline: [unclosed');
  expect(extractBinariesFromYaml(yamlPath)).toBeNull();
});

test('parseRequirementsMd / serializeRequirementsMd round-trip preserves body verbatim', () => {
  const original = [
    '---',
    'schemaVersion: 1',
    'generatedFor: foo.yaml',
    'binaries:',
    '  - name: git',
    '    probe: git --version',
    '    usedBy: [build.clone]',
    'env:',
    '  - name: ANTHROPIC_API_KEY',
    '    required: true',
    'services: []',
    '---',
    '',
    '# Hand-written body',
    '',
    'Multiple paragraphs with `code` and **bold**.',
    '',
    '### `git`',
    'Used in: `build.clone`',
    '',
    '- macOS: `brew install git`',
    '',
  ].join('\n');

  const parsed = parseRequirementsMd(original);
  expect(parsed.frontmatter).not.toBeNull();
  expect(parsed.body).toContain('# Hand-written body');
  expect(parsed.body).toContain('### `git`');

  const reserialized = serializeRequirementsMd(parsed);
  const reparsed = parseRequirementsMd(reserialized);
  expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  // Body should round-trip with no content lost (whitespace at edges may differ).
  expect(reparsed.body.trim()).toBe(parsed.body.trim());
});

test('runRequirementsSync seeds a new file when none exists', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'fresh.yaml',
    [
      'pipeline:',
      '  name: fresh',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: ls',
      '          command: "git status"',
      '',
    ].join('\n'),
  );

  runRequirementsSync(yamlPath);

  const reqPath = requirementsPath(yamlPath);
  expect(existsSync(reqPath)).toBe(true);
  const parsed = parseRequirementsMd(readFileSync(reqPath, 'utf-8'));
  const fm = parsed.frontmatter as RequirementsFrontmatter;
  expect(fm.binaries.map((b) => b.name)).toEqual(['git']);
  expect(fm.env).toEqual([]);
  expect(fm.services).toEqual([]);
  // Initial body template lists each binary as a section so the user sees TODO markers.
  expect(parsed.body).toContain('### `git`');
  expect(parsed.body).toContain('TODO');
});

test('runRequirementsSync preserves body + agent-owned env when YAML changes', () => {
  const { tagmaDir } = makeWorkspace();
  const yamlPath = writeYaml(
    tagmaDir,
    'evolve.yaml',
    [
      'pipeline:',
      '  name: evolve',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: a',
      '          command: "git status"',
      '',
    ].join('\n'),
  );

  // First sync — generates the file.
  runRequirementsSync(yamlPath);
  const reqPath = requirementsPath(yamlPath);

  // User / agent edits the body and adds env vars.
  const initial = parseRequirementsMd(readFileSync(reqPath, 'utf-8'));
  const editedFrontmatter = {
    ...initial.frontmatter,
    env: [{ name: 'GITHUB_TOKEN', required: true, description: 'GitHub PAT for git push' }],
  };
  const editedBody =
    '# Custom body — keep me!\n\n## CLI tools\n\n### `git`\n\n- macOS: `brew install git`\n';
  writeFileSync(
    reqPath,
    serializeRequirementsMd({
      frontmatter: editedFrontmatter as RequirementsFrontmatter,
      body: editedBody,
    }),
  );

  // YAML grows a new binary; sync runs again.
  writeFileSync(
    yamlPath,
    [
      'pipeline:',
      '  name: evolve',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: a',
      '          command: "git status"',
      '        - id: b',
      '          command: "bun install"',
      '',
    ].join('\n'),
    'utf-8',
  );
  runRequirementsSync(yamlPath);

  const after = parseRequirementsMd(readFileSync(reqPath, 'utf-8'));
  const fm = after.frontmatter as RequirementsFrontmatter;
  // Server-owned binaries got recomputed.
  expect(fm.binaries.map((b) => b.name)).toEqual(['bun', 'git']);
  // Agent-owned env preserved.
  expect(fm.env).toEqual([
    { name: 'GITHUB_TOKEN', required: true, description: 'GitHub PAT for git push' },
  ]);
  // Body preserved verbatim — server never rewrites it.
  expect(after.body).toContain('# Custom body');
  expect(after.body).toContain('- macOS: `brew install git`');
  expect(after.body).toContain('### `bun`');
  expect(after.body).toContain('TODO: install instructions for `bun`');
});
