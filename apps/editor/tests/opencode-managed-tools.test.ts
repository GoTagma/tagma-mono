import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { seedOpencodeArtifacts } from '../server/opencode-seed';

function seedFakePlugin(configDir: string): void {
  const pluginDir = join(configDir, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@opencode-ai/plugin',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    }),
    'utf8',
  );
  writeFileSync(
    join(pluginDir, 'dist', 'index.js'),
    [
      'const schemaNode = new Proxy(function schemaNode() { return schemaNode; }, {',
      '  get() { return schemaNode; },',
      '  apply() { return schemaNode; },',
      '});',
      'const schema = new Proxy({}, { get() { return () => schemaNode; } });',
      'const tool = Object.assign((definition) => definition, { schema });',
      'export { tool };',
    ].join('\n'),
    'utf8',
  );
}

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
    seedFakePlugin(runtime.configDir);

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
        'const output = await loaded[0].execute({',
        '  manifest: { pipeline: { name: "Cross platform" }, sections: [] },',
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
});
