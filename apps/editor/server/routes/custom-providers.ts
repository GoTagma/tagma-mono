/**
 * Custom-provider CRUD + model auto-discovery routes.
 *
 * Backs the Connect dialog's "Add custom provider" modal — register an Ollama
 * / LM Studio / vLLM / LocalAI / Exo / internal OpenAI-compatible endpoint
 * without an app restart. The provider definition is written to one of two
 * workspace-local opencode config files:
 *
 *   - global    -> `<workDir>/.tagma/.opencode-runtime/config/opencode/opencode.json`
 *   - workspace → `<workDir>/.tagma/opencode.json` (commit-able for teams
 *                 sharing an internal endpoint)
 *
 * Writes do NOT restart opencode. The renderer orchestrates a single restart
 * after both the config write and (if applicable) the auth.set credential
 * write complete — keeps the user-visible "saving…" window short.
 *
 * The model-discovery endpoint is server-side because the renderer's
 * fetch(localhost:…) is blocked by browser CORS for most local model servers
 * (Ollama, LM Studio, vLLM, etc. don't send Access-Control-Allow-Origin
 * headers). Routing through the editor server avoids that without asking the
 * user to flip a server-side config flag.
 */

import type express from 'express';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import { errorMessage } from '../path-utils.js';
import { takeRateLimitToken } from '../rate-limit.js';
import { requireWorkspace } from '../require-workspace.js';
import {
  CustomProviderValidationError,
  listCustomProviders,
  normalizeCustomProviderId,
  readExistingProviderSecrets,
  redactProviderApiKey,
  removeCustomProvider,
  resolveOpencodeGlobalConfigPath,
  resolveOpencodeWorkspaceConfigPath,
  upsertCustomProvider,
  validateCustomProvider,
  type ConfigScope,
} from '../opencode-config.js';

function parseScope(value: unknown): ConfigScope {
  if (value === 'global' || value === 'workspace') return value;
  throw new CustomProviderValidationError('`scope` must be "global" or "workspace".');
}

// ─── Discover-models hardening ─────────────────────────────────────────────
//
// The endpoint accepts a user-supplied baseURL + apiKey and probes it for a
// model list. Two abuse paths it must close:
//
//   1. Env-var exfiltration. Earlier revisions resolved `{env:VAR}` server-
//      side and used the resolved value as `Authorization: Bearer …`, so
//      anyone with reach into this API could read arbitrary process.env
//      values (e.g. OPENAI_API_KEY) by aiming baseURL at a server they
//      control. Resolution is gone — keys flow through as literal strings.
//   2. SSRF. The fetch must not be steered at link-local, loopback*,
//      private-RFC1918, or cloud-metadata addresses unless the user
//      explicitly aimed at a local LLM server. We allow loopback (Ollama,
//      LM Studio, vLLM, LocalAI all bind there) but reject the metadata
//      endpoint, AWS IMDS, GCP/Azure equivalents, and any private IP that
//      isn't loopback.
//
// Redirects are disabled — a 30x to a banned host would otherwise re-open
// the same SSRF channel the host check just closed.

const ENV_REFERENCE_RE = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.goog',
]);

function normalizeParsedHostname(host: string): string {
  const lower = host.trim().toLowerCase();
  // Node's URL.hostname includes brackets for IPv6 literals (e.g.
  // "[::1]"). node:net.isIP expects the raw address, so unwrap here before
  // classifying loopback / metadata / private ranges.
  if (lower.startsWith('[') && lower.endsWith(']')) return lower.slice(1, -1);
  return lower;
}

function isLoopbackHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
  if (lower === 'ip6-localhost' || lower === 'ip6-loopback') return true;
  return false;
}

function isLoopbackIp(ip: string): boolean {
  if (ip === '::1') return true;
  if (ip === '0:0:0:0:0:0:0:1') return true;
  if (ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('127.')) return true;
  return false;
}

/**
 * Reject private / link-local / reserved IPs that a remote attacker would
 * use to pivot from this sidecar into the user's LAN or a cloud-metadata
 * endpoint. Loopback is allowed because users legitimately point this at
 * Ollama/LM Studio on 127.0.0.1.
 */
function classifyIp(ip: string): 'loopback' | 'public' | 'blocked' {
  if (isLoopbackIp(ip)) return 'loopback';
  // Cloud metadata — reject before the private-range check fires below.
  if (CLOUD_METADATA_HOSTS.has(ip)) return 'blocked';

  if (ip.includes('.')) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return 'blocked';
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return 'blocked';
    if (a === 172 && b >= 16 && b <= 31) return 'blocked';
    if (a === 192 && b === 168) return 'blocked';
    if (a === 169 && b === 254) return 'blocked'; // link-local + AWS IMDS
    if (a === 100 && b >= 64 && b <= 127) return 'blocked'; // CGNAT
    if (a === 0) return 'blocked';
    if (a >= 224) return 'blocked'; // multicast / reserved
    return 'public';
  }

  // IPv6 — block unspecified (::), link-local (fe80::/10), unique-local
  // (fc00::/7), and multicast (ff00::/8). Anything else is treated as public.
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'blocked';
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return 'blocked';
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'blocked';
  if (lower.startsWith('ff')) return 'blocked';
  return 'public';
}

interface ResolvedHost {
  classification: 'loopback' | 'public';
  resolvedIp: string;
}

/**
 * GET a URL with the destination IP pinned to `resolvedIp` and SNI / Host
 * still set to `url.hostname`. Closes the DNS-rebinding TOCTOU between
 * `resolveAndValidateHost` (where we approved the address) and the request
 * (where Node/undici would otherwise re-resolve and could land on a private
 * IP returned by an attacker-controlled DNS server).
 *
 * The TLS handshake still validates the server cert against `url.hostname`,
 * so a rebound private IP that doesn't have a cert for that hostname fails
 * closed at the TLS layer too — IP pinning is the inner ring; cert
 * validation is the outer ring.
 */
// Exported for unit tests so we can verify the IP pin without standing up
// the whole route. Outside callers should use the discover-models endpoint.
export async function pinnedGet(
  url: URL,
  resolvedIp: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ status: number; ok: boolean; bodyText: string }> {
  const reqLib = url.protocol === 'https:' ? nodeHttps : nodeHttp;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const family: 4 | 6 = resolvedIp.includes(':') ? 6 : 4;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Request aborted'));
      return;
    }
    // Pinning strategy: connect to `resolvedIp` directly via the `host`
    // option (which bypasses DNS entirely — Node uses it as the literal
    // address for the TCP connect). SNI is forced to the original hostname
    // via `servername` so the TLS handshake validates the cert against
    // what the user typed, not against the IP. The Host header is set
    // explicitly so HTTP virtual-host routing also lands on the right
    // origin. This combination closes the DNS-rebinding TOCTOU and is
    // more portable than the `lookup` callback (Bun's node:http compat
    // layer ignores `lookup` in some configurations and falls back to
    // its own resolver / proxy chain).
    const requestHeaders = { ...headers, Host: url.host };
    const sniHost = normalizeParsedHostname(url.hostname);
    const requestOptions: nodeHttp.RequestOptions & { servername?: string } = {
      host: resolvedIp,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: requestHeaders,
      // Without this, undici / Bun may set SNI from `host` (the IP),
      // which would fail cert validation. Setting it to the hostname
      // keeps cert validation aligned with what the user typed. Numeric
      // IP literals do not need SNI.
      ...(isIP(sniHost) === 0 ? { servername: sniHost } : {}),
      family,
      // Disable the default agent: it's connection-pooled per (host, port)
      // and may also pick up HTTP(S)_PROXY from the environment. We want a
      // direct TCP connect to `resolvedIp` with no proxy intermediation —
      // the whole pin would otherwise be defeated by a proxy that
      // re-resolves the hostname server-side.
      agent: false,
    };
    const req = reqLib.request(requestOptions, (response) => {
      // Mirror fetch `redirect: 'error'`. A 30x to a banned host would
      // otherwise bypass the SSRF host check.
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error(`Refusing to follow ${status} redirect`));
        return;
      }
      let bodyText = '';
      let received = 0;
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => {
        received += Buffer.byteLength(chunk, 'utf-8');
        if (received > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Response body exceeded 4MB cap'));
          return;
        }
        bodyText += chunk;
      });
      response.on('end', () => {
        resolve({
          status,
          ok: status >= 200 && status < 300,
          bodyText,
        });
      });
      response.on('error', reject);
    });
    const onAbort = () => {
      req.destroy(new Error('Request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.on('error', reject);
    // Independent socket-level timeout in case the connect / first byte
    // hangs without the outer abort firing first.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

async function resolveAndValidateHost(rawHost: string): Promise<ResolvedHost> {
  const host = normalizeParsedHostname(rawHost);
  if (CLOUD_METADATA_HOSTS.has(host)) {
    throw new CustomProviderValidationError(
      `Refusing to discover models against cloud-metadata host "${host}".`,
    );
  }
  if (isLoopbackHostname(host)) {
    return { classification: 'loopback', resolvedIp: '127.0.0.1' };
  }
  // Already a numeric IP — classify directly without DNS.
  const literal = isIP(host);
  if (literal !== 0) {
    const cls = classifyIp(host);
    if (cls === 'blocked') {
      throw new CustomProviderValidationError(
        `Refusing to discover models against private/reserved IP "${host}".`,
      );
    }
    return { classification: cls, resolvedIp: host };
  }
  // Resolve via DNS, then classify every returned address. We require all
  // addresses to be either loopback or public — a hostname that resolves to
  // both 127.0.0.1 and 192.168.0.5 is rejected as ambiguous.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch (err) {
    throw new CustomProviderValidationError(`Could not resolve "${host}": ${errorMessage(err)}`);
  }
  if (addresses.length === 0) {
    throw new CustomProviderValidationError(`No DNS records for "${host}".`);
  }
  let allLoopback = true;
  let allPublic = true;
  for (const { address } of addresses) {
    const cls = classifyIp(address);
    if (cls === 'blocked') {
      throw new CustomProviderValidationError(
        `Refusing to discover models — "${host}" resolves to private/reserved IP "${address}".`,
      );
    }
    if (cls === 'loopback') allPublic = false;
    else allLoopback = false;
  }
  if (allLoopback) {
    throw new CustomProviderValidationError(
      `Refusing to discover models through hostname "${host}" because it resolves to loopback. ` +
        `Use localhost, 127.0.0.1, or ::1 explicitly for local model servers.`,
    );
  }
  if (allPublic) return { classification: 'public', resolvedIp: addresses[0]!.address };
  throw new CustomProviderValidationError(
    `Refusing to discover models — "${host}" resolves to a mix of loopback and public addresses.`,
  );
}

/**
 * Every scope is workspace-local. Thread the workspace through uniformly so
 * provider writes cannot escape into the user's normal OpenCode home.
 */
export function registerCustomProvidersRoutes(app: express.Express): void {
  app.get('/api/opencode/custom-providers', (req, res) => {
    try {
      const ws = req.workspace;
      const workDir = ws?.workDir ?? null;
      // Always redact the apiKey before returning to the renderer. The raw
      // value lives only on disk; clients must not have a way to read it
      // back via this API.
      const providers = listCustomProviders(workDir).map((entry) => ({
        ...entry,
        def: redactProviderApiKey(entry.def),
      }));
      res.json({
        providers,
        paths: {
          global: workDir ? resolveOpencodeGlobalConfigPath(workDir) : null,
          workspace: workDir ? resolveOpencodeWorkspaceConfigPath(workDir) : null,
        },
      });
    } catch (err) {
      console.error('[custom-providers] GET failed:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.put('/api/opencode/custom-providers/:id', (req, res) => {
    try {
      const body = (req.body ?? {}) as { scope?: unknown; def?: unknown };
      const scope = parseScope(body.scope);
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      if (!ws.workDir) {
        return res.status(400).json({ error: 'Workspace directory is not set' });
      }
      const workDir = ws.workDir;
      const id = normalizeCustomProviderId(String(req.params.id ?? ''));
      const existing = readExistingProviderSecrets(scope, workDir, id);
      const def = validateCustomProvider(id, body.def, {
        scope,
        existingApiKey: existing.apiKey,
        existingHeaders: existing.headers,
      });
      upsertCustomProvider(scope, workDir, id, def);
      res.json({ ok: true, id, scope });
    } catch (err) {
      if (err instanceof CustomProviderValidationError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[custom-providers] PUT failed:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.delete('/api/opencode/custom-providers/:id', (req, res) => {
    try {
      const scope = parseScope(req.query.scope);
      const ws = requireWorkspace(req, res);
      if (!ws) return;
      if (!ws.workDir) {
        return res.status(400).json({ error: 'Workspace directory is not set' });
      }
      const workDir = ws.workDir;
      const id = String(req.params.id ?? '');
      const removed = removeCustomProvider(scope, workDir, id);
      if (!removed) {
        return res
          .status(404)
          .json({ error: `Custom provider "${id}" not found in ${scope} config.` });
      }
      res.json({ ok: true, id, scope });
    } catch (err) {
      if (err instanceof CustomProviderValidationError) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[custom-providers] DELETE failed:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Model discovery proxy ──────────────────────────────────────────────
  //
  // Probes the user's baseURL for a model list, trying multiple known shapes
  // so the same button works across local LLM servers:
  //
  //   1. `{baseURL}/models`  — OpenAI-compatible. Covers LM Studio (:1234/v1),
  //                            vLLM (:8000/v1), LocalAI (:8080/v1), and
  //                            Ollama via its OpenAI shim when the user types
  //                            `:11434/v1`.
  //   2. `{origin}/v1/models` — same shape, but reached by stripping any
  //                             non-/v1 path the user typed. Covers people
  //                             who entered a bare origin like Exo's standard
  //                             `:52415` (no /v1 suffix).
  //   3. `{origin}/api/tags`  — Ollama-native fallback for the case where the
  //                             user typed bare `:11434` and the OpenAI shim
  //                             is disabled or absent.
  //
  // First success wins; the response includes `endpoint` + `format` so the
  // UI can hint what worked. On all-failure, the aggregated error names every
  // URL we tried so the user can spot a typo quickly.
  //
  // CORS: this is server-side because the renderer's fetch(localhost:…) is
  // blocked for most local model daemons (none of them send
  // Access-Control-Allow-Origin for arbitrary origins).

  app.post('/api/opencode/custom-providers/discover-models', async (req, res) => {
    // Rate limit per workspace+remote so a runaway script can't spam an
    // external model service through the editor. 30 calls / minute is
    // generous for a human clicking "Verify" but tight enough that
    // accidental loops don't burn through someone's quota.
    const wsKey = req.workspace?.key ?? 'default';
    const decision = takeRateLimitToken(`discover:${wsKey}`, { windowMs: 60_000, max: 30 });
    if (!decision.ok) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(decision.retryAfterMs / 1000)).toString());
      return res.status(429).json({
        error: 'Too many discover-models requests; slow down.',
        retryAfterMs: decision.retryAfterMs,
      });
    }
    try {
      const body = (req.body ?? {}) as { baseURL?: unknown; apiKey?: unknown };
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
      // Cap baseURL/apiKey lengths so a noisy caller can't push the body
      // past the parser's reach in a way that wastes CPU on validation.
      if (baseURL.length > 2_048) {
        return res.status(400).json({ error: '`baseURL` is too long (max 2048 chars).' });
      }
      if (typeof body.apiKey === 'string' && body.apiKey.length > 4_096) {
        return res.status(400).json({ error: '`apiKey` is too long (max 4096 chars).' });
      }
      // apiKey is optional. Local servers (Ollama, LM Studio, …) ignore the
      // Authorization header; cloud servers (OpenAI, OpenRouter, …) need it
      // even just to list models. Doubles as the "Verify" button's transport
      // — the renderer side branches the UI, but the wire shape is shared.
      const rawApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      // SECURITY: never resolve `{env:VAR}` server-side. Earlier revisions
      // did, which let any caller of this endpoint read arbitrary process.env
      // values (including OPENAI_API_KEY etc.) by pointing baseURL at a host
      // they control. The literal `{env:…}` reference is rejected with a
      // clear error so the UI can prompt the user for a real key instead.
      if (ENV_REFERENCE_RE.test(rawApiKey)) {
        return res.status(400).json({
          error:
            '`{env:VAR}` API key references cannot be used for model discovery — paste the actual key instead.',
        });
      }
      // No null bytes / CR / LF in the apiKey — those would let a caller
      // smuggle additional headers through `Authorization: Bearer …`.
      if (/[\r\n\0]/.test(rawApiKey)) {
        return res.status(400).json({ error: '`apiKey` contains invalid control characters.' });
      }
      const apiKey = rawApiKey;
      if (!baseURL) {
        return res.status(400).json({ error: '`baseURL` is required.' });
      }
      let parsed: URL;
      try {
        parsed = new URL(baseURL);
      } catch {
        return res.status(400).json({ error: '`baseURL` is not a valid URL.' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'baseURL must be http:// or https://' });
      }
      // SSRF guard. Resolve the hostname now; reject private/reserved IPs
      // and the cloud-metadata endpoint outright. Loopback is allowed
      // because that is the entire point of the endpoint for Ollama/LM
      // Studio/vLLM users.
      let resolved: ResolvedHost;
      try {
        resolved = await resolveAndValidateHost(parsed.hostname);
      } catch (err) {
        if (err instanceof CustomProviderValidationError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
      // Plain http:// is only allowed for loopback. Sending Bearer tokens
      // over plain HTTP to a remote host would leak the key on the wire.
      if (parsed.protocol === 'http:' && resolved.classification !== 'loopback') {
        return res.status(400).json({
          error:
            'http:// is only allowed for loopback model servers — use https:// for remote endpoints.',
        });
      }

      const origin = `${parsed.protocol}//${parsed.host}`;
      // Strip trailing slashes from the user-supplied path so `/v1/` and `/v1`
      // produce the same first candidate (and so deduping below works).
      const userPath = parsed.pathname.replace(/\/+$/, '');

      type Format = 'openai' | 'ollama';
      const candidates: Array<{ url: URL; format: Format }> = [];
      // 1) Respect the user's path: `…/v1` → `…/v1/models`. Skipped when the
      //    user typed a bare origin (path is empty after trim).
      if (userPath) {
        candidates.push({ url: new URL(`${userPath}/models`, origin), format: 'openai' });
      }
      // 2) Origin-rooted /v1/models — the universal fallback for OpenAI-compat
      //    servers when the user omitted /v1 from baseURL.
      const v1Url = new URL('/v1/models', origin);
      if (!candidates.some((c) => c.url.toString() === v1Url.toString())) {
        candidates.push({ url: v1Url, format: 'openai' });
      }
      // 3) Ollama-native /api/tags — last resort, only matters when the OpenAI
      //    shim isn't in play. Origin-rooted to ignore any /v1 suffix.
      candidates.push({ url: new URL('/api/tags', origin), format: 'ollama' });

      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const errors: string[] = [];
      for (const c of candidates) {
        const controller = new AbortController();
        // 4s per-candidate caps the total worst case at ~12s (3 probes), which
        // matches what the user perceives as "the spinner is hung" without
        // dropping legitimate slow LANs.
        const timeout = setTimeout(() => controller.abort(), 4_000);
        try {
          // We use a lookup-pinned request rather than `fetch(c.url, ...)`
          // because fetch would re-resolve `c.url.hostname` through the OS
          // resolver, opening a DNS-rebinding TOCTOU: validation could see
          // a public address while the connection lands on a private one.
          // `pinnedGet` connects to `resolved.resolvedIp` directly while
          // SNI / Host stay on the hostname so TLS cert validation works.
          const upstream = await pinnedGet(
            c.url,
            resolved.resolvedIp,
            headers,
            4_000,
            controller.signal,
          );
          if (!upstream.ok) {
            errors.push(`${c.url.pathname} → HTTP ${upstream.status}`);
            continue;
          }
          let payload: Record<string, unknown>;
          try {
            const parsedBody = JSON.parse(upstream.bodyText) as unknown;
            if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
              errors.push(`${c.url.pathname} → response body is not a JSON object`);
              continue;
            }
            payload = parsedBody as Record<string, unknown>;
          } catch {
            errors.push(`${c.url.pathname} → response body is not valid JSON`);
            continue;
          }
          const models = parseDiscoveredModels(payload, c.format);
          if (models === null) {
            errors.push(`${c.url.pathname} → unexpected response shape`);
            continue;
          }
          return res.json({
            ok: true,
            models,
            endpoint: c.url.pathname,
            format: c.format,
          });
        } catch (err) {
          errors.push(`${c.url.pathname} → ${errorMessage(err)}`);
        } finally {
          clearTimeout(timeout);
        }
      }
      return res.status(502).json({
        error: `Could not detect models at ${origin}. Tried: ${errors.join('; ')}`,
      });
    } catch (err) {
      console.error('[custom-providers] discover-models failed:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}

/**
 * Normalize the two known model-list response shapes into `{ id, name }[]`:
 *
 *   - OpenAI: `{ object: "list", data: [{ id: "model-id", … }] }`
 *   - Ollama: `{ models: [{ name: "llama3.1:8b", … }] }`
 *
 * Returns `null` when the payload doesn't match the expected shape so the
 * caller can record it as an error and try the next candidate (e.g. when a
 * proxy responds 200 with an HTML login page instead of JSON).
 */
function parseDiscoveredModels(
  payload: Record<string, unknown>,
  format: 'openai' | 'ollama',
): Array<{ id: string; name: string }> | null {
  if (format === 'openai') {
    if (!Array.isArray(payload.data)) return null;
    const out: Array<{ id: string; name: string }> = [];
    for (const raw of payload.data) {
      if (!raw || typeof raw !== 'object') continue;
      const id = (raw as Record<string, unknown>).id;
      if (typeof id !== 'string' || !id) continue;
      out.push({ id, name: id });
    }
    return out;
  }
  // ollama
  if (!Array.isArray(payload.models)) return null;
  const out: Array<{ id: string; name: string }> = [];
  for (const raw of payload.models) {
    if (!raw || typeof raw !== 'object') continue;
    const name = (raw as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name) continue;
    out.push({ id: name, name });
  }
  return out;
}
