import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import { stagePinnedOpencodePluginFixture } from './helpers/opencode-native-plugin-fixture';
import { PluginRegistry } from '@tagma/sdk';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml } from '@tagma/sdk/yaml';
import { validateRaw } from '@tagma/sdk/config';
import type { CompletionPlugin } from '@tagma/sdk';

// Copies the pinned plugin and Zod twice and loads generated tools in a child.
// This verifies module/fixture isolation, not a 5s filesystem benchmark.
test('managed OpenCode tools load from the isolated runtime and migrate legacy workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma managed tools 中文-'));
  const tagmaCwd = join(root, '.tagma');
  const runtime = resolveOpencodeRuntimePaths(tagmaCwd);
  const legacyToolsDir = join(tagmaCwd, '.opencode', 'tools');
  const legacyNodeModulesMarker = join(
    tagmaCwd,
    '.opencode',
    'node_modules',
    'zod',
    'legacy-marker.txt',
  );
  const customToolPath = join(legacyToolsDir, 'user_custom.ts');
  const managedToolNames = [
    'tagma_yaml_skeleton.ts',
    'tagma_placement_plan.ts',
    'tagma_trial_plan.ts',
  ] as const;

  try {
    mkdirSync(join(tagmaCwd, '.opencode', 'node_modules', 'zod'), { recursive: true });
    mkdirSync(legacyToolsDir, { recursive: true });
    writeFileSync(legacyNodeModulesMarker, 'preserve me', 'utf8');
    writeFileSync(customToolPath, 'export default {};\n', 'utf8');
    for (const name of managedToolNames) {
      writeFileSync(join(legacyToolsDir, name), 'legacy managed tool\n', 'utf8');
    }

    expect(seedOpencodeArtifacts(tagmaCwd)).toBe(true);
    stagePinnedOpencodePluginFixture(tagmaCwd, '1.18.18');

    for (const extensionRoot of [runtime.configDir, join(tagmaCwd, '.opencode')]) {
      const packageMetadata = JSON.parse(
        readFileSync(join(extensionRoot, 'package.json'), 'utf8'),
      ) as { dependencies: Record<string, string> };
      const packageLock = JSON.parse(
        readFileSync(join(extensionRoot, 'package-lock.json'), 'utf8'),
      ) as { packages: { '': { dependencies: Record<string, string> } } };
      expect(packageMetadata.dependencies['@opencode-ai/plugin']).toBe('1.18.18');
      expect(packageLock.packages[''].dependencies).toEqual(packageMetadata.dependencies);
      expect(
        existsSync(
          join(extensionRoot, 'node_modules', '@opencode-ai', 'plugin', 'dist', 'index.js'),
        ),
      ).toBe(true);
      expect(existsSync(join(extensionRoot, 'node_modules', 'zod', 'index.js'))).toBe(true);
    }

    const managedToolPaths = managedToolNames.map((name) => join(runtime.configDir, 'tools', name));
    for (const path of managedToolPaths) expect(existsSync(path)).toBe(true);
    for (const name of managedToolNames) expect(existsSync(join(legacyToolsDir, name))).toBe(false);
    expect(readFileSync(legacyNodeModulesMarker, 'utf8')).toBe('preserve me');
    expect(readFileSync(customToolPath, 'utf8')).toBe('export default {};\n');

    const verifierPath = join(root, 'verify managed tools.ts');
    writeFileSync(
      verifierPath,
      [
        'import { pathToFileURL } from "node:url";',
        'const paths = process.argv.slice(2);',
        'const loaded = [];',
        'for (const path of paths) {',
        '  const mod = await import(pathToFileURL(path).href);',
        '  if (!mod.default) throw new Error(`missing default export: ${path}`);',
        '  loaded.push(mod.default);',
        '}',
        'if (!loaded[0].args.manifest?._zod) {',
        '  throw new Error("managed tool did not load the pinned OpenCode Zod schema runtime");',
        '}',
        'const output = await loaded[0].execute({',
        '  manifest: {',
        '    pipeline: { name: "Cross platform", atomicity_rationale: "One atomic operation." },',
        '    sections: [',
        '      { id: "track:main", type: "track", summary: "Main", track_identity_rationale: "One execution identity." },',
        '      { id: "task:main.answer", type: "prompt", track: "main", task: "answer", prompt: "Answer.", result_contract: "none", task_boundary_rationale: "One observable responsibility." },',
        '    ],',
        '  },',
        '});',
        'if (!String(output).includes("Cross platform")) {',
        '  throw new Error(`unexpected skeleton output: ${output}`);',
        '}',
      ].join('\n'),
      'utf8',
    );
    const verify = Bun.spawnSync([process.execPath, verifierPath, ...managedToolPaths], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(new TextDecoder().decode(verify.stderr)).toBe('');
    expect(verify.exitCode).toBe(0);

    expect(seedOpencodeArtifacts(tagmaCwd)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('native generated YAML tool rejects missing file completion paths before emitting YAML', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma native yaml file contract-'));
  const tagmaCwd = join(root, '.tagma');
  const runtime = resolveOpencodeRuntimePaths(tagmaCwd);
  const registry = new PluginRegistry();
  bootstrapBuiltins(registry);
  const fileSchema = registry.getHandler<CompletionPlugin>('completions', 'file_exists').schema;
  const knownTypes = {
    completions: ['file_exists'],
    schemas: { completions: { file_exists: fileSchema } },
  };
  try {
    seedOpencodeArtifacts(tagmaCwd);
    stagePinnedOpencodePluginFixture(tagmaCwd, '1.18.18');
    const verifierPath = join(root, 'verify native file contracts.ts');
    writeFileSync(
      verifierPath,
      `import { pathToFileURL } from "node:url";
const generated = (await import(pathToFileURL(process.argv[2]).href)).default;
if (!generated.args.manifest?._zod) throw new Error("Expected pinned OpenCode Zod runtime");
const observations = [];
for (const taskType of ["command", "prompt"]) {
  for (const contract of ["file", "native-output-and-file"]) {
    for (const path of [undefined, "   ", "reports/result.md"]) {
      const manifest = {
        pipeline: { name: "File contract", atomicity_rationale: "One atomic file publication." },
        sections: [
          { id: "track:main", type: "track", track: "main", track_identity_rationale: "One execution identity." },
          {
            id: "task:main.publish", type: taskType, track: "main", task: "publish",
            ...(taskType === "command" ? { command: "write-report" } : { prompt: "Write the report." }),
            permissions: { read: true, write: true, execute: false },
            task_boundary_rationale: "One independently observable file result.",
            result_contract: contract,
            ...(contract === "native-output-and-file" ? { outputs: ["report"] } : {}),
            completion: { type: "file_exists", ...(path === undefined ? {} : { path }) },
          },
        ],
      };
      const args = { manifest: generated.args.manifest.parse(manifest) };
      let result;
      let error;
      try { result = JSON.parse(await generated.execute(args)); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      if (path === "reports/result.md") {
        if (error || !result?.yaml) throw new Error("Valid file path was rejected: " + error);
      } else if (!error?.includes("completion.path must be a non-empty string")) {
        throw new Error("Expected immediate completion.path rejection for " + taskType + ":" + contract + "; received " + (error ?? "successful YAML"));
      }
      observations.push({ taskType, contract, path: path ?? null, ...(error ? { error } : { yaml: result.yaml }) });
    }
  }
}
console.log(JSON.stringify(observations));
`,
      'utf8',
    );
    const verify = Bun.spawnSync(
      [process.execPath, verifierPath, join(runtime.configDir, 'tools', 'tagma_yaml_skeleton.ts')],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(new TextDecoder().decode(verify.stderr)).toBe('');
    expect(verify.exitCode).toBe(0);
    const observations = JSON.parse(new TextDecoder().decode(verify.stdout)) as Array<{
      path: string | null;
      error?: string;
      yaml?: string;
    }>;
    expect(observations).toHaveLength(12);
    expect(observations.filter((item) => item.error)).toHaveLength(8);
    for (const item of observations.filter((candidate) => candidate.yaml)) {
      expect(validateRaw(parseYaml(item.yaml!), knownTypes)).toEqual([]);
    }

    // The compiler remains authoritative for hand-written/previously persisted YAML.
    for (const path of [undefined, '   ']) {
      const errors = validateRaw(
        {
          name: 'Invalid file completion',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                {
                  id: 'publish',
                  command: 'write-report',
                  completion: { type: 'file_exists', ...(path === undefined ? {} : { path }) },
                },
              ],
            },
          ],
        },
        knownTypes,
      );
      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining('completion.path') }),
      ]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
