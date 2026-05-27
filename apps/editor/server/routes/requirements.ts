// ─────────────────────────────────────────────────────────────────────────────
// routes/requirements.ts — read-only access to per-pipeline requirements docs.
// ─────────────────────────────────────────────────────────────────────────────
//
// `GET /api/requirements?path=<abs path inside workspace>` returns the parsed
// `*.requirements.md` for a given pipeline YAML. Used by the pre-run
// "Requirements missing" modal to render install snippets from the markdown
// body.
//
// Read-only — never mutates anything. The watcher / preflight modules own
// rewriting the file.

import type express from 'express';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorMessage, isPathWithin } from '../path-utils.js';
import { requireWorkspace } from '../require-workspace.js';
import { parseRequirementsMd, requirementsPath } from '../requirements-sync.js';

export function registerRequirementsRoutes(app: express.Express): void {
  app.get('/api/requirements', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;

    // Resolve the path against the workspace YAML when no `?path=` is supplied,
    // so the pre-run modal can call this with no arguments and get the current
    // pipeline's requirements without a round-trip.
    let target: string;
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (raw.length > 0) {
      target = resolve(raw);
    } else {
      if (!ws.yamlPath) {
        return res.status(404).json({ error: 'No pipeline YAML is bound to this workspace' });
      }
      target = requirementsPath(ws.yamlPath);
    }

    if (!ws.workDir || !isPathWithin(target, ws.workDir)) {
      return res.status(403).json({ error: 'Requirements path is outside the workspace' });
    }
    if (!/\.requirements\.md$/i.test(target)) {
      return res.status(400).json({ error: 'Path must end in .requirements.md' });
    }
    if (!existsSync(target)) {
      return res.status(404).json({ error: 'Requirements file does not exist yet' });
    }
    if (lstatSync(target).isSymbolicLink()) {
      return res.status(403).json({ error: 'Refusing to read symbolic link' });
    }
    if (!statSync(target).isFile()) {
      return res.status(400).json({ error: 'Requirements path is not a regular file' });
    }

    try {
      const raw = readFileSync(target, 'utf-8');
      const parsed = parseRequirementsMd(raw);
      res.json({
        path: target,
        raw,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
