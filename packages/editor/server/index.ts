import express from 'express';
import cors from 'cors';
import {
  bootstrapBuiltins,
  parseYaml,
} from '@tagma/sdk';
import {
  S,
  bumpRevision,
  getState,
  broadcastStateEvent,
  closeStateEventClients,
  lenientParseYaml,
} from './state.js';
import {
  stopWatching as stopFileWatching,
  onFileWatcherEvent,
  markSynced as markWatcherSynced,
  type ExternalChangeEvent,
} from './file-watcher.js';
import { invalidatePluginCache } from './plugins/loader.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerRunRoutes, shutdownRuns } from './routes/run.js';

// Register built-in plugins so we can list available drivers etc.
bootstrapBuiltins();

const app = express();
// ── C2: Tighten CORS ──
// The server hosts powerful local file-system endpoints (open / save-as /
// delete-file / import / export / fs/list). Default cors() echoes any Origin,
// which lets a malicious page in another browser tab CSRF the user's machine.
// Restrict to the editor's own dev/prod origins; override via TAGMA_ALLOWED_ORIGINS
// (comma-separated) when running in a trusted multi-machine setup.
const PORT = parseInt(process.env.PORT ?? '3001');
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const EXTRA_ALLOWED_ORIGINS = (process.env.TAGMA_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);
app.use(
  cors({
    origin: (origin, cb) => {
      // Same-origin requests (server-side fetch, curl, browser navigation
      // to /api/* directly) have no Origin header — those are allowed.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error(`CORS rejected: ${origin}`));
    },
    credentials: false,
  }),
);
app.use(express.json({ limit: '5mb' }));

// ── Revision / ETag (C6) ──
//
// `stateRevision` increments on every successful mutation. Clients track their
// last-seen revision and send `If-Match: <revision>` (or body field
// `expectedRevision`) on mutations. If the numbers don't match, the server
// responds 409 with `{ error, currentState }` so the client can re-apply.
//
// Contract (documented here for future pipeline-store integration):
//   Request  → headers: { 'If-Match': '<number>' }
//              body:    { ..., expectedRevision?: number }
//   Success  → 2xx JSON, state includes `revision` field incremented by 1+
//   Conflict → 409 JSON: { error: 'revision mismatch', currentState: ServerState }
//
// Group 5 leaves client consumption for a future cycle; pipeline-store is
// owned by other groups and must not be touched here.

// ── Mutation middleware: revision bump + If-Match check (C6) ──
//
// Applied via `app.use` BEFORE any mutation routes are registered (see order
// below). The middleware is a no-op for GET/HEAD/OPTIONS and for non-/api
// paths. For mutations it:
//   1. Validates `If-Match` / `expectedRevision` against `stateRevision`
//   2. On mismatch → 409 with the current ServerState
//   3. On match (or when no expectation provided) → hooks `res.on('finish')`
//      to bump `stateRevision` after a successful 2xx response
//
// Requests that did not send an expectation are still accepted (backward
// compat for older clients) but will still bump the revision on success.
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (!MUTATION_METHODS.has(req.method)) return next();

  // Skip If-Match checks on endpoints that Group 4 owns and on plugin/FS
  // utilities where revision doesn't carry meaning.
  const skipRoutes = [
    '/api/run/',
    '/api/plugins/',
    '/api/fs/',
    '/api/state/events',
    '/api/layout',
    '/api/editor-settings',
  ];
  if (skipRoutes.some((p) => req.path.startsWith(p))) return next();

  const headerMatch = req.header('If-Match');
  const bodyExpected =
    req.body && typeof req.body === 'object' && 'expectedRevision' in req.body
      ? Number((req.body as Record<string, unknown>).expectedRevision)
      : undefined;
  const expected =
    headerMatch !== undefined && headerMatch !== ''
      ? Number(headerMatch)
      : bodyExpected;

  // B3: Reject non-numeric If-Match values with 400 instead of silently
  // bypassing the revision check (NaN is not finite → check was skipped).
  if (expected !== undefined && !Number.isFinite(expected)) {
    return res.status(400).json({ error: 'If-Match header must be a numeric revision' });
  }

  if (expected !== undefined && expected !== S.stateRevision) {
    return res.status(409).json({
      error: 'revision mismatch',
      expected,
      current: S.stateRevision,
      currentState: getState(),
    });
  }

  // Strip `expectedRevision` from body so downstream handlers never see it
  // as a stray field (avoids accidentally persisting it into YAML).
  if (req.body && typeof req.body === 'object' && 'expectedRevision' in req.body) {
    delete (req.body as Record<string, unknown>).expectedRevision;
  }

  // Bump pre-emptively so the getState() embedded in the response body already
  // carries the new revision. If the handler errors (4xx/5xx) we roll back so
  // clients don't see a phantom jump.
  const pre = S.stateRevision;
  bumpRevision();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      S.stateRevision = pre;
    }
  });

  next();
});

// Wire the file-watcher into the SSE broadcaster. When the watcher detects
// an external change with clean in-memory state, auto-reload the YAML and
// push the new state to subscribers.
onFileWatcherEvent((event: ExternalChangeEvent) => {
  // M6: Invalidate plugin caches on any external YAML change so discovery
  // re-scans on the next request.
  invalidatePluginCache();
  if (event.type === 'external-change') {
    try {
      S.config = parseYaml(event.content);
    } catch {
      try {
        S.config = lenientParseYaml(event.content, 'Untitled');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[file-watcher] failed to parse reloaded YAML', err);
        broadcastStateEvent({ type: 'external-conflict', path: event.path, error: 'parse-failed' });
        return;
      }
    }
    bumpRevision();
    markWatcherSynced(event.content, null);
    broadcastStateEvent({ type: 'external-change', newState: getState() });
  } else if (event.type === 'external-conflict') {
    broadcastStateEvent({ type: 'external-conflict', path: event.path });
  }
});

// Register route groups. Order matches the original file so anything that
// relies on Express's first-match semantics still wins in the same place.
registerPipelineRoutes(app);
registerPluginRoutes(app);
registerWorkspaceRoutes(app);
registerRunRoutes(app);

// ── B5: Global error handler ──
// Catches unhandled errors in route handlers so the process doesn't crash.
// Must be registered after all routes (Express identifies error handlers by
// their 4-parameter signature).
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// C1: Bind to 127.0.0.1 by default so the LAN can't reach the local file-system
// endpoints. HOST may be set explicitly (e.g. "0.0.0.0") for trusted multi-machine
// setups, but those should also enable TAGMA_ALLOWED_ORIGINS + token auth.
const server = app.listen(PORT, HOST, () => {
  console.log(`Tagma Editor server running on http://${HOST}:${PORT}`);
});

// ── B6: Graceful shutdown ──
function gracefulShutdown() {
  console.log('[server] shutting down...');
  // Abort any active pipeline run + close run SSE connections
  shutdownRuns();
  // Close file watcher
  stopFileWatching();
  // Close state event SSE clients
  closeStateEventClients();
  // Close HTTP server
  server.close(() => {
    console.log('[server] shutdown complete');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
