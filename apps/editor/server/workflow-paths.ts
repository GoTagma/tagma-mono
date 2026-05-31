import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isPathWithin } from './path-utils.js';
import { sanitizePipelineStem, tagmaDirOf } from './pipeline-paths.js';

const WORKFLOW_SUFFIX_RE = /\.workflow\.ya?ml$/i;

export function sanitizeWorkflowStem(input: unknown): string {
  return sanitizePipelineStem(input);
}

export function isValidWorkflowStem(input: unknown): boolean {
  try {
    sanitizeWorkflowStem(input);
    return true;
  } catch {
    return false;
  }
}

export function workflowsDirOf(workDir: string): string {
  return join(tagmaDirOf(workDir), 'workflows');
}

export function workflowYamlPath(workDir: string, stem: string): string {
  const safe = sanitizeWorkflowStem(stem);
  return join(workflowsDirOf(workDir), `${safe}.workflow.yaml`);
}

export function workflowStemFromYamlBasename(name: string): string {
  return name.replace(WORKFLOW_SUFFIX_RE, '');
}

export interface WorkflowYamlEntry {
  readonly stem: string;
  readonly yamlPath: string;
  readonly yamlBasename: string;
}

export function enumerateWorkflowYamls(workDir: string): WorkflowYamlEntry[] {
  if (!workDir) return [];
  const dir = workflowsDirOf(workDir);
  if (!existsSync(dir)) return [];
  try {
    if (lstatSync(dir).isSymbolicLink()) return [];
  } catch {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: WorkflowYamlEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!WORKFLOW_SUFFIX_RE.test(entry.name)) continue;
    const stem = workflowStemFromYamlBasename(entry.name);
    if (!isValidWorkflowStem(stem)) continue;
    const yamlPath = join(dir, entry.name);
    try {
      const stat = lstatSync(yamlPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch {
      continue;
    }
    out.push({ stem, yamlPath, yamlBasename: entry.name });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
}

export function assertWorkflowYamlPath(workDir: string, absPath: string, label: string): string {
  if (!workDir) {
    throw new Error(`Workspace directory is not set; cannot resolve ${label}.`);
  }
  const resolved = resolve(isAbsolute(absPath) ? absPath : join(workDir, absPath));
  if (!isPathWithin(resolved, workDir)) {
    throw new Error(`${label} is outside the workspace directory.`);
  }
  const workflowsDir = workflowsDirOf(workDir);
  if (!isPathWithin(resolved, workflowsDir)) {
    throw new Error(`${label} must be inside the workspace .tagma/workflows directory.`);
  }
  if (resolve(workflowsDir) === resolved) {
    throw new Error(`${label} cannot be the workflows directory itself.`);
  }
  if (dirname(resolved) !== resolve(workflowsDir)) {
    throw new Error(`${label} must sit directly under .tagma/workflows/.`);
  }
  if (!WORKFLOW_SUFFIX_RE.test(resolved)) {
    throw new Error(`${label} must be a .workflow.yaml or .workflow.yml file.`);
  }
  const stem = workflowStemFromYamlBasename(basename(resolved));
  if (!isValidWorkflowStem(stem)) {
    throw new Error(`${label} has an invalid workflow stem.`);
  }
  for (const segment of [tagmaDirOf(workDir), workflowsDir, resolved]) {
    if (!existsSync(segment)) continue;
    try {
      const stat = lstatSync(segment);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} traverses a symbolic link at ${segment}.`);
      }
      if (segment === workflowsDir && !stat.isDirectory()) {
        throw new Error(`${label} parent must be a directory.`);
      }
      if (segment === resolved && !stat.isFile()) {
        throw new Error(`${label} must be a regular file.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(label)) throw err;
      throw new Error(`${label} could not stat ${segment}: ${(err as Error).message}`);
    }
  }
  return resolved;
}
