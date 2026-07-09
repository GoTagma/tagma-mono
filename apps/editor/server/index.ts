// Dev-mode env-var bootstrap MUST run before any other module that reads
// these vars at import time (opencode-lifecycle, routes/opencode, etc.). In
// packaged desktop mode this is a no-op — the electron launcher has already
// populated TAGMA_* via runtime-paths.ts. In dev it back-fills the same vars
// from apps/electron/package.json so dev and release render identically.
import { bootstrapDevEnv } from './dev-bootstrap.js';
bootstrapDevEnv();

import express from 'express';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { S, bumpRevision, getState, closeStateEventClients } from './state.js';
import { resolveWorkspace } from './require-workspace.js';
import { workspaceRegistry } from './workspace-registry.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerRunRoutes, shutdownRuns } from './routes/run.js';
import { registerRecentRoutes } from './routes/recent.js';
import { registerOpencodeRoutes } from './routes/opencode.js';
import { registerCustomProvidersRoutes } from './routes/custom-providers.js';
import { registerRequirementsRoutes } from './routes/requirements.js';
import { registerPythonAgentRoutes } from './routes/python-agent.js';
import { registerSecretsRoutes } from './routes/secrets.js';
import { shutdownOpencode } from './opencode-lifecycle.js';
import { registerEditorRoutes } from './routes/editor.js';
import { registerSidecarRoutes } from './routes/sidecar.js';
import { registerReleaseRoutes } from './routes/release.js';
import { registerHotupdateRoutes } from './routes/hotupdate.js';
import { registerChatBridgeRoutes } from './routes/chat-bridge.js';
import {
  shouldAutoStartBotBridgeOnBoot,
  startConfiguredBotBridge,
  shutdownBotBridge,
} from './chat-bridge/index.js';
import {
  ALLOWED_ORIGINS,
  addLoopbackAllowedOrigins,
  resetAllowedOrigins,
} from './allowed-origins.js';
import { resolveStaticAssetsDir, cleanupStaleUserDist } from './static-assets.js';
import { bypassesRevisionCheck } from './revision-routes.js';
import {
  canBypassYamlEditLock,
  getActiveYamlEditLock,
  isYamlEditLockProtectedMutation,
  publicYamlEditLock,
  shouldBlockYamlEditLockMutation,
} from './yaml-edit-lock.js';

const app = express();
// ── C2: Tighten CORS ──
// The server hosts powerful local file-system endpoints (open / save-as /
// delete-file / import / export / fs/list). Default cors() echoes any Origin,
// which lets a malicious page in another browser tab CSRF the user's machine.
// Restrict to the editor's own dev/prod origins; override via TAGMA_ALLOWED_ORIGINS
// (comma-separated) when running in a trusted multi-machine setup.
const PORT = parseInt(process.env.PORT ?? '3001');
const HOST = process.env.HOST ?? '127.0.0.1';
resetAllowedOrigins(PORT);
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

// ── C8: Optional bearer-token auth ──
//
// When TAGMA_AUTH_TOKEN is set (non-empty), every /api/* request MUST include
// an Authorization: Bearer <token> header matching the configured value. SSE
// endpoints also accept a same-origin `tagma_auth` cookie because EventSource
// cannot set custom headers; legacy `?auth=<token>` remains as a compatibility
// fallback. This protects endpoints (including read-only ones like /api/fs/list)
// from unauthenticated access — essential when binding to 0.0.0.0.
//
// When TAGMA_AUTH_TOKEN is not set, auth is skipped only for loopback dev.
// A network-reachable HOST without auth fails closed unless the operator
// explicitly sets TAGMA_UNSAFE_ALLOW_NETWORK=1.
//
// Token source: TAGMA_AUTH_TOKEN env var (user-supplied). No auto-generation
// — operators are expected to set this before exposing the server outside
// loopback; in dev (loopback-only) leaving it unset is accepted.
const AUTH_TOKEN = process.env.TAGMA_AUTH_TOKEN ?? '';
const AUTH_ENABLED = AUTH_TOKEN.length > 0;

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return rawValue.join('=');
    }
  }
  return null;
}

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (!req.path.startsWith('/api/')) return next();

  const authHeader = req.headers.authorization;
  const isSseEndpoint = req.path === '/api/run/events' || req.path === '/api/state/events';
  const queryToken = isSseEndpoint && typeof req.query.auth === 'string' ? req.query.auth : null;
  const cookieToken = isSseEndpoint ? cookieValue(req.headers.cookie, 'tagma_auth') : null;
  const token =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (cookieToken ?? queryToken);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header. Provide: Bearer <token>' });
  }
  if (!constantTimeEqual(token, AUTH_TOKEN)) {
    return res.status(403).json({ error: 'Invalid auth token' });
  }
  next();
});

// ── C7: Host + Origin strict gate (DNS rebinding + CSRF defense) ──
//
// The server binds to loopback by default (C1) and CORS already restricts
// which Origins may READ responses, but CORS does not prevent the *request*
// from executing — a state-changing POST from evil.com still runs its side
// effects before the CORS response filter kicks in. And a DNS-rebinding
// attack can make a browser send requests to 127.0.0.1:3001 with a
// `Host: attacker.com` header, bypassing any Origin-only check.
//
// This middleware enforces two invariants whenever the server is bound to
// loopback (i.e. the user has not explicitly opted out by setting HOST to a
// non-loopback address):
//   1. The `Host` request header MUST resolve to a loopback name. This
//      blocks DNS rebinding even when the browser has cached a malicious
//      DNS answer pointing at 127.0.0.1.
//   2. On mutations, if `Origin` is present it MUST be in ALLOWED_ORIGINS.
//      Browser-originated requests always include Origin on cross-site
//      POSTs, so this is a free CSRF block.
//
// Non-browser tooling (curl, HTTP clients in other processes) with no
// Origin header still passes the Host check because we only fail-close on
// an Origin mismatch, not on its absence — keeping local dev ergonomics
// (e.g. `curl http://127.0.0.1:3001/api/...`) intact.
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BOUND_LOOPBACK = LOOPBACK_BIND_HOSTS.has(HOST);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const UNSAFE_ALLOW_NETWORK_NO_AUTH = process.env.TAGMA_UNSAFE_ALLOW_NETWORK === '1';

if (!AUTH_ENABLED && !BOUND_LOOPBACK && !UNSAFE_ALLOW_NETWORK_NO_AUTH) {
  console.error(
    '[auth] FATAL: refusing to bind a network-reachable server without TAGMA_AUTH_TOKEN.\n' +
      '  Set TAGMA_AUTH_TOKEN=<secret>, bind HOST to 127.0.0.1, or explicitly set TAGMA_UNSAFE_ALLOW_NETWORK=1 for a trusted dev network.',
  );
  process.exit(1);
}

function extractHostname(hostHeader: string): string {
  // Strip IPv6 brackets first so the port-stripping regex doesn't eat the
  // `::1` colons. Input examples:
  //   "127.0.0.1:3001" → "127.0.0.1"
  //   "localhost"      → "localhost"
  //   "[::1]:3001"     → "::1"
  const bracketMatch = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) return bracketMatch[1]!.toLowerCase();
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '::1' ||
    address === '127.0.0.1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

app.use((req, res, next) => {
  if (!BOUND_LOOPBACK) return next();
  const hostHeader = req.headers.host;
  if (!hostHeader) {
    return res.status(403).json({ error: 'missing Host header' });
  }
  const hostname = extractHostname(hostHeader);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    return res.status(403).json({ error: `Host header not allowed: ${hostHeader}` });
  }
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: `Origin not allowed: ${origin}` });
    }
  }
  return next();
});

app.use(express.json({ limit: '5mb' }));

// ── Per-request workspace resolution ──
//
// The multi-tenant sidecar hosts one WorkspaceState per workspace path. Every
// renderer stamps `X-Tagma-Workspace: <abs-path>` (or `?ws=` for EventSource)
// onto its requests; this middleware turns that into `req.workspace`, creating
// the state on first touch. Must run BEFORE the mutation middleware below so
// that revision / If-Match checks see the correct workspace.
app.use(resolveWorkspace);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    return next();
  }
  if (!isYamlEditLockProtectedMutation(req.path)) return next();

  const ws = req.workspace ?? S;
  const lock = getActiveYamlEditLock(ws);
  if (!lock) return next();
  if (canBypassYamlEditLock(lock, req.get('X-Tagma-Yaml-Lock-Id'))) return next();
  if (
    !shouldBlockYamlEditLockMutation(lock, {
      path: req.path,
      body: req.body,
      currentYamlPath: ws.yamlPath,
      workDir: ws.workDir,
    })
  ) {
    return next();
  }

  return res.status(423).json({
    error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
    lock: publicYamlEditLock(lock),
  });
});

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
  if (bypassesRevisionCheck(req.path)) return next();

  // Skip If-Match checks on endpoints that Group 4 owns and on plugin/FS
  // utilities where revision doesn't carry meaning.
  const skipRoutes = [
    '/api/plugins/',
    '/api/fs/',
    '/api/state/events',
    // POST /api/state/reload is a server-side disk-resync recovery endpoint,
    // not a user-intent mutation: the client calls it when it detects that
    // the server's in-memory state has drifted from disk (e.g., a chat-driven
    // external write hit the `external-conflict` branch and the server never
    // reloaded). The caller's last-seen revision may be arbitrarily stale at
    // that point, so applying the If-Match check would defeat the whole
    // recovery path. The handler bumps revision itself.
    '/api/state/reload',
    '/api/opencode/',
    '/api/editor/',
    // Compile reads YAML off disk and writes a sibling .compile.log — no
    // mutation of ws.config / yamlPath / layout. It was falling through to
    // the generic mutation branch which pre-emptively bumped stateRevision
    // but responded with YamlCompileResult (no `revision` field), so the
    // client's opportunistic setClientRevision couldn't keep lastRevision
    // in sync. The next real mutation (e.g. chat-reconcile's POST /api/open
    // for "Open new YAML") then 409'd on a phantom-advanced baseline.
    '/api/workspace/compile',
    // Workspace lifecycle hook invoked from Electron on window close — no
    // client revision is in flight and the request has no workspace binding.
    '/api/workspace/drop',
    '/api/shutdown',
  ];
  if (skipRoutes.some((p) => req.path.startsWith(p))) return next();

  const headerMatch = req.header('If-Match');
  const bodyExpected =
    req.body && typeof req.body === 'object' && 'expectedRevision' in req.body
      ? Number((req.body as Record<string, unknown>).expectedRevision)
      : undefined;
  const expected =
    headerMatch !== undefined && headerMatch !== '' ? Number(headerMatch) : bodyExpected;

  // B3: Reject non-numeric If-Match values with 400 instead of silently
  // bypassing the revision check (NaN is not finite → check was skipped).
  if (expected !== undefined && !Number.isFinite(expected)) {
    return res.status(400).json({ error: 'If-Match header must be a numeric revision' });
  }

  // Revision is per-workspace. Fall back to the default singleton S when a
  // legacy caller hits a mutation endpoint without the workspace header set —
  // that preserves the original single-tenant semantics for the welcome path.
  const ws = req.workspace ?? S;

  if (expected !== undefined && expected !== ws.stateRevision) {
    return res.status(409).json({
      error: 'revision mismatch',
      expected,
      current: ws.stateRevision,
      currentState: getState(ws),
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
  const pre = ws.stateRevision;
  bumpRevision(ws);
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      ws.stateRevision = pre;
    }
  });

  next();
});

// The file-watcher → SSE bridge is attached per-workspace inside
// `attachFileWatcherBridge` (state.ts), registered as the
// `workspaceRegistry.setOnCreate` hook so it fires for every WorkspaceState
// the registry creates (default sentinel + every real per-path workspace).
// Keeping the listener per-workspace is required so external-change events
// for workspace A only fan out to A's subscribers and reload A's config —
// never B's.

// Detect overwrite-install scenario before we decide which dist dir to serve.
// If the installer is newer than the staged hot-update layer, wipe the layer
// so the fresh bundled copy takes effect. Moved here from the Electron main
// process so the shell can stay frozen.
cleanupStaleUserDist();

// Resolve the dist dir up-front so the editor route group can report which
// one is actually being served. express.static captures its root at
// registration time, so what we pass to registerEditorRoutes below is the
// authoritative "currently live" answer — disk state (does
// TAGMA_EDITOR_USER_DIST_DIR exist now?) can drift from that after a
// hot-update and must not be used to compute activeVersion.
const distDir = resolveStaticAssetsDir(import.meta.dirname);
const servedDistDir = existsSync(distDir) ? distDir : null;

// Register route groups. Order matches the original file so anything that
// relies on Express's first-match semantics still wins in the same place.
registerPipelineRoutes(app);
registerPluginRoutes(app);
registerWorkspaceRoutes(app);
registerRunRoutes(app);
registerRecentRoutes(app);
registerOpencodeRoutes(app);
registerPythonAgentRoutes(app);
registerCustomProvidersRoutes(app);
registerRequirementsRoutes(app);
registerEditorRoutes(app, servedDistDir);
registerSecretsRoutes(app);
registerSidecarRoutes(app);
registerReleaseRoutes(app);
registerHotupdateRoutes(app);
registerChatBridgeRoutes(app);

app.post('/api/shutdown', (req, res) => {
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'Shutdown is only allowed from loopback' });
  }
  res.json({ ok: true });
  setTimeout(gracefulShutdown, 0).unref?.();
});

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

// Serve Vite build output when dist/ exists (desktop / headless-server mode).
// Must be registered after all /api routes so API paths take priority.
if (servedDistDir) {
  app.use(express.static(servedDistDir));
  // Express 5 migrated to path-to-regexp v8; bare '*' without a parameter name
  // is rejected at route-registration time ("Missing parameter name at index 1").
  // Use the named splat form so this SPA fallback keeps matching every path.
  app.get('/*splat', (_req, res) => res.sendFile(join(servedDistDir, 'index.html')));
}

// C1: Bind to 127.0.0.1 by default so the LAN can't reach the local file-system
// endpoints. HOST may be set explicitly (e.g. "0.0.0.0") for trusted multi-machine
// setups, but those should also enable TAGMA_ALLOWED_ORIGINS + token auth.
const server = app.listen(PORT, HOST, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  addLoopbackAllowedOrigins(ALLOWED_ORIGINS, actualPort);
  console.log(`Tagma Editor server running on http://${HOST}:${actualPort}`);
  // Machine-readable readiness signal consumed by the Electron launcher.
  process.stdout.write(`TAGMA_READY port=${actualPort}\n`);

  if (AUTH_ENABLED) {
    console.log('[auth] Bearer token authentication ENABLED');
  } else if (BOUND_LOOPBACK) {
    console.warn(
      '[auth] Loopback development mode without bearer token. Browser CSRF defenses still apply, but native local processes can reach /api/*.',
    );
  } else if (!BOUND_LOOPBACK) {
    console.warn(
      '[auth] WARNING: server bound to non-loopback address without TAGMA_AUTH_TOKEN because TAGMA_UNSAFE_ALLOW_NETWORK=1.\n' +
        '  All /api/* endpoints are accessible to the network without authentication.\n' +
        '  Set TAGMA_AUTH_TOKEN=<secret> to enable bearer token auth.',
    );
  }
  // Bot bridge startup is intentionally user-driven. Stored credentials are
  // configuration, not permission to connect to a third-party messenger on
  // every app launch.
  if (shouldAutoStartBotBridgeOnBoot()) {
    void startConfiguredBotBridge();
  }
});

// ── B6: Graceful shutdown ──
let shuttingDown = false;

function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down...');
  // Abort any active pipeline run + close run SSE connections (run.ts
  // iterates every workspace's run session internally).
  shutdownRuns();
  // Notify paired bot chats that we're going away, then stop the long-poller.
  // Fire-and-forget — graceful-shutdown's 5 s overall deadline still applies.
  void shutdownBotBridge('Tagma desktop is shutting down');
  // Kill the opencode child if it was spawned on demand.
  shutdownOpencode();
  // Tear down every live workspace: stop its file watcher and drain its
  // state-event SSE subscribers. Iterates the sidecar-wide registry so
  // multi-window workspaces all get cleaned up, not just the default.
  for (const key of workspaceRegistry.keys()) {
    const ws = workspaceRegistry.get(key);
    if (!ws) continue;
    try {
      ws.watcher.stopWatching();
    } catch (err) {
      console.error(`[server] stopWatching failed for ${key}:`, err);
    }
    try {
      closeStateEventClients(ws);
    } catch (err) {
      console.error(`[server] closeStateEventClients failed for ${key}:`, err);
    }
  }
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
process.on('SIGBREAK', gracefulShutdown);
process.on('SIGHUP', gracefulShutdown);
