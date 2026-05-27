import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { atomicWriteFileSync, isPathWithin } from './path-utils.js';

const STORE_VERSION = 1;
const RUN_VERSION_FILE = 'run-versions.json';

interface RunVersionStore {
  schemaVersion: number;
  entries: Record<string, number>;
}

function storePath(workDir: string): string {
  return join(workDir, '.tagma', RUN_VERSION_FILE);
}

function normalizeKeyPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function yamlRunVersionKey(
  workDir: string,
  yamlPath: string | null | undefined,
): string | null {
  if (!workDir || !yamlPath) return null;
  const root = resolve(workDir);
  const target = resolve(yamlPath);
  if (!isPathWithin(target, root)) return null;
  const rel = normalizeKeyPath(relative(root, target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

function readStore(workDir: string): RunVersionStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(workDir), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return { schemaVersion: STORE_VERSION, entries: {} };
    const candidate = raw as Partial<RunVersionStore>;
    const entries: Record<string, number> = {};
    if (candidate.entries && typeof candidate.entries === 'object') {
      for (const [key, value] of Object.entries(candidate.entries)) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          entries[key] = value;
        }
      }
    }
    return { schemaVersion: STORE_VERSION, entries };
  } catch {
    return { schemaVersion: STORE_VERSION, entries: {} };
  }
}

function writeStore(workDir: string, store: RunVersionStore): void {
  const tagmaDir = join(workDir, '.tagma');
  mkdirSync(tagmaDir, { recursive: true });
  atomicWriteFileSync(storePath(workDir), JSON.stringify(store, null, 2) + '\n');
}

export function readYamlRunVersion(workDir: string, yamlPath: string | null | undefined): number {
  const key = yamlRunVersionKey(workDir, yamlPath);
  if (!key) return 0;
  const store = readStore(workDir);
  return store.entries[key] ?? 0;
}

export function incrementYamlRunVersion(
  workDir: string,
  yamlPath: string | null | undefined,
): number {
  const key = yamlRunVersionKey(workDir, yamlPath);
  if (!key) return 0;
  const store = readStore(workDir);
  const next = (store.entries[key] ?? 0) + 1;
  store.entries[key] = next;
  writeStore(workDir, store);
  return next;
}
