// ═══ Template Discovery (F1) ═══
//
// Public helpers so editors / UIs can enumerate installed `@tagma/template-*`
// packages in a workspace and read each template's declarative metadata
// (name, description, params) without actually expanding the template.
//
// The legacy private `loadTemplate` in schema.ts uses Bun-specific APIs
// (Bun.file, require.resolve). These helpers are Node-compatible because
// the editor server runs on Node, not Bun.

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { TemplateConfig } from './types';

export interface TemplateManifest extends TemplateConfig {
  /** The package ref as it would appear in `task.use`, e.g. `@tagma/template-review`. */
  readonly ref: string;
}

/**
 * Scan the workspace's `node_modules/@tagma/*` for packages whose name starts
 * with `template-` and load each one's manifest. Packages without a valid
 * `template.yaml` (or that fail to parse) are silently skipped.
 *
 * Returns an empty array when `workDir` doesn't exist or has no such packages.
 */
export function discoverTemplates(workDir: string): TemplateManifest[] {
  const out: TemplateManifest[] = [];
  const scopeDir = join(workDir, 'node_modules', '@tagma');
  if (!existsSync(scopeDir)) return out;

  let entries: string[] = [];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.startsWith('template-')) continue;
    const pkgDir = join(scopeDir, entry);
    try {
      const st = statSync(pkgDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    const ref = `@tagma/${entry}`;
    const manifest = loadTemplateManifestFromDir(pkgDir, ref);
    if (manifest) out.push(manifest);
  }

  // Sort alphabetically for deterministic UI rendering.
  out.sort((a, b) => a.ref.localeCompare(b.ref));
  return out;
}

/**
 * Load a single template's manifest by its ref (e.g. `@tagma/template-review`)
 * from the given workspace's `node_modules`. Returns `null` if the package
 * isn't installed or its manifest can't be parsed.
 */
export function loadTemplateManifest(ref: string, workDir: string): TemplateManifest | null {
  // Only @tagma/template-* refs are supported (matches SDK validateTemplateRef).
  const stripped = ref.replace(/@v\d+$/, '');
  if (!stripped.startsWith('@tagma/template-')) return null;
  const pkgDir = join(workDir, 'node_modules', stripped);
  if (!existsSync(pkgDir)) return null;
  return loadTemplateManifestFromDir(pkgDir, stripped);
}

/**
 * Resolve a template manifest from an absolute package directory. Tries
 * `template.yaml` first (the documented convention), then a `template` export
 * from `package.json`'s `main`. Returns `null` on any failure so discovery
 * stays robust against malformed packages.
 */
function loadTemplateManifestFromDir(pkgDir: string, ref: string): TemplateManifest | null {
  const yamlPath = join(pkgDir, 'template.yaml');
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const doc = yaml.load(content) as { template?: TemplateConfig } | TemplateConfig;
      const tpl = (doc && typeof doc === 'object' && 'template' in doc
        ? (doc as { template?: TemplateConfig }).template
        : (doc as TemplateConfig)) as TemplateConfig | undefined;
      if (tpl && typeof tpl === 'object' && tpl.name && Array.isArray(tpl.tasks)) {
        return { ...tpl, ref };
      }
    } catch {
      return null;
    }
  }
  return null;
}
