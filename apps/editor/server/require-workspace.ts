// ─────────────────────────────────────────────────────────────────────────────
// server/require-workspace.ts — Per-request workspace resolution
// ─────────────────────────────────────────────────────────────────────────────
//
// One sidecar serves every Electron window. Each renderer stamps an
// `X-Tagma-Workspace: <absolute-path>` header onto its fetches so the server
// knows which live `WorkspaceState` to mutate. EventSource can't set custom
// headers, so the middleware also accepts the workspace key via a `?ws=`
// query parameter as a fallback for SSE endpoints (`/api/state/events`,
// `/api/run/events`).
//
// Windows that haven't picked a workspace yet (the Welcome page) send no
// header / no query — those requests get `req.workspace = null`. Routes that
// actually need a workspace call `requireWorkspace(req, res)` which either
// returns the state or sends 400 "workspace required".
// ─────────────────────────────────────────────────────────────────────────────

import type { NextFunction, Request, Response } from 'express';
import {
  DEFAULT_WORKSPACE_KEY,
  normalizeWorkspaceKey,
  workspaceRegistry,
  isValidWorkspaceKey,
} from './workspace-registry.js';
import type { WorkspaceState } from './workspace-state.js';

// Module augmentation so route handlers can read `req.workspace` without an
// explicit cast. Keeping the field nullable matches the runtime contract —
// the middleware unconditionally sets it, so TS callers still have to decide
// how to handle the no-workspace case.
//
// Augmenting the global `Express.Request` (not `express-serve-static-core`)
// keeps this working even when the transitive `@types/express-serve-static-core`
// package isn't hoisted into this workspace's node_modules.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace: WorkspaceState | null;
    }
  }
}

/**
 * Express middleware. Reads `X-Tagma-Workspace` (header) or `?ws=` (query)
 * from the incoming request, looks up the matching `WorkspaceState` (creating
 * it on first touch), and attaches it as `req.workspace`. Absent / empty
 * values leave `req.workspace` as `null` — the welcome / no-workspace case.
 *
 * Register once in `index.ts` before any route group so every handler sees a
 * consistent `req.workspace` value.
 */
export function resolveWorkspace(req: Request, _res: Response, next: NextFunction): void {
  const raw =
    (typeof req.headers['x-tagma-workspace'] === 'string'
      ? req.headers['x-tagma-workspace']
      : Array.isArray(req.headers['x-tagma-workspace'])
        ? req.headers['x-tagma-workspace'][0]
        : undefined) ?? (typeof req.query.ws === 'string' ? req.query.ws : undefined);

  if (!raw || raw.trim().length === 0) {
    req.workspace = null;
    return next();
  }

  const key = normalizeWorkspaceKey(raw);
  // Path validation: a typo'd / stale / non-existent key must not spin up a
  // long-lived WorkspaceState (each one holds a PluginRegistry, FileWatcher,
  // and SSE subscriber list). Treat an invalid key as "no workspace bound"
  // — routes that actually need one will 400 via requireWorkspace().
  if (!isValidWorkspaceKey(key)) {
    console.warn(
      '[workspace-invalid]',
      req.method,
      req.path,
      'raw=',
      JSON.stringify(raw),
      'normalized=',
      JSON.stringify(key),
    );
    req.workspace = null;
    return next();
  }
  req.workspace = workspaceRegistry.getOrCreate(key);
  return next();
}

/**
 * Route-handler helper: return the request's `WorkspaceState`, or send a 400
 * and return `null` when no workspace is bound. Call as:
 *
 *   const ws = requireWorkspace(req, res);
 *   if (!ws) return;
 *
 * …so the compiler can narrow the remainder of the handler to the non-null
 * `WorkspaceState`.
 */
export function requireWorkspace(req: Request, res: Response): WorkspaceState | null {
  if (req.workspace) {
    if (req.workspace.key !== DEFAULT_WORKSPACE_KEY && !req.workspace.workDir) {
      console.error(
        '[workspace-invalid-state]',
        req.method,
        req.path,
        'key=',
        JSON.stringify(req.workspace.key),
      );
      res.status(500).json({
        error: 'Workspace state is missing its working directory. Reopen the workspace and retry.',
      });
      return null;
    }
    return req.workspace;
  }
  const rawHeader = req.headers['x-tagma-workspace'];
  const rawQuery = typeof req.query.ws === 'string' ? req.query.ws : undefined;
  console.warn(
    '[workspace-miss]',
    req.method,
    req.path,
    'header=',
    JSON.stringify(rawHeader ?? null),
    'query.ws=',
    JSON.stringify(rawQuery ?? null),
  );
  res.status(400).json({
    error:
      'No workspace bound to this request. Set the X-Tagma-Workspace header ' +
      '(or ?ws= query param for SSE) to the absolute workspace path.',
  });
  return null;
}
