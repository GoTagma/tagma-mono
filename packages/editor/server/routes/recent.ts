import type express from 'express';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Global recent-workspaces list lives in the user's home directory so it is
 * shared across every Tagma pipeline on this machine (unlike `<workDir>/.tagma`
 * which is per-project). Cross-platform:
 *   - Windows: C:\Users\<user>\.tagma\recent-workspaces.json
 *   - macOS:   ~/.tagma/recent-workspaces.json
 *   - Linux:   ~/.tagma/recent-workspaces.json
 */
const GLOBAL_TAGMA_DIR = join(homedir(), '.tagma');
const RECENT_FILE = join(GLOBAL_TAGMA_DIR, 'recent-workspaces.json');
const MAX_RECENT = 3;

interface RecentEntry {
  path: string;
  openedAt: number;
}

interface RecentFile {
  version: 1;
  recent: RecentEntry[];
}

interface RecentEntryWire extends RecentEntry {
  exists: boolean;
}

const EMPTY: RecentFile = { version: 1, recent: [] };

function ensureDir(): void {
  try {
    mkdirSync(GLOBAL_TAGMA_DIR, { recursive: true });
  } catch {
    /* best-effort — any real error surfaces on the next writeFileSync */
  }
}

function readRecent(): RecentFile {
  if (!existsSync(RECENT_FILE)) return { ...EMPTY };
  try {
    const raw = readFileSync(RECENT_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const recent = (parsed as { recent?: unknown }).recent;
    if (!Array.isArray(recent)) return { ...EMPTY };
    const cleaned: RecentEntry[] = [];
    for (const item of recent) {
      if (!item || typeof item !== 'object') continue;
      const p = (item as { path?: unknown }).path;
      const ts = (item as { openedAt?: unknown }).openedAt;
      if (typeof p !== 'string' || !p) continue;
      cleaned.push({
        path: p,
        openedAt: typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now(),
      });
    }
    return { version: 1, recent: cleaned.slice(0, MAX_RECENT) };
  } catch {
    return { ...EMPTY };
  }
}

function writeRecent(data: RecentFile): void {
  ensureDir();
  try {
    writeFileSync(RECENT_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[recent-workspaces] failed to write', err);
  }
}

/** Case-insensitive path equality on Windows, exact elsewhere. */
function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Register `absPath` as the most-recently-opened workspace. Moves an existing
 * entry to the front instead of duplicating, and trims the tail so the list
 * never grows beyond MAX_RECENT.
 */
export function recordWorkspaceOpen(absPath: string): void {
  if (!absPath) return;
  const normalized = resolve(absPath);
  const data = readRecent();
  const filtered = data.recent.filter((e) => !pathsEqual(e.path, normalized));
  const next: RecentEntry = { path: normalized, openedAt: Date.now() };
  const recent = [next, ...filtered].slice(0, MAX_RECENT);
  writeRecent({ version: 1, recent });
}

function annotate(recent: RecentEntry[]): RecentEntryWire[] {
  return recent.map((e) => {
    let exists = false;
    try {
      exists = existsSync(e.path) && statSync(e.path).isDirectory();
    } catch {
      exists = false;
    }
    return { ...e, exists };
  });
}

export function registerRecentRoutes(app: express.Express): void {
  app.get('/api/recent-workspaces', (_req, res) => {
    const data = readRecent();
    res.json({ recent: annotate(data.recent) });
  });

  app.post('/api/recent-workspaces', (req, res) => {
    const raw = (req.body ?? {}) as { path?: unknown };
    if (typeof raw.path !== 'string' || !raw.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    recordWorkspaceOpen(raw.path);
    const data = readRecent();
    res.json({ recent: annotate(data.recent) });
  });

  app.delete('/api/recent-workspaces', (req, res) => {
    const raw = (req.body ?? {}) as { path?: unknown };
    if (typeof raw.path !== 'string' || !raw.path) {
      return res.status(400).json({ error: 'path is required' });
    }
    const target = resolve(raw.path);
    const data = readRecent();
    const recent = data.recent.filter((e) => !pathsEqual(e.path, target));
    writeRecent({ version: 1, recent });
    res.json({ recent: annotate(recent) });
  });
}
