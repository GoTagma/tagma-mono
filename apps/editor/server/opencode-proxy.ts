import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { createStreamingLoopbackFetch } from './loopback-fetch.js';
import { isPathWithin } from './path-utils.js';

export const OPENCODE_PROXY_BASE_PATH = '/api/opencode/chat/proxy';

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-none-match',
  'last-event-id',
  'x-opencode-directory',
]);

export interface OpencodeProxyRequest {
  baseUrl: string;
  authorization: string;
  requestUrl: string;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

export function sanitizeForwardedOpencodeDirectory(
  headerValue: string | null | undefined,
  tagmaRoot: string,
): string | null {
  if (headerValue == null) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(headerValue);
  } catch {
    throw new Error('OpenCode directory header must be a valid encoded path');
  }
  if (!decoded.trim()) {
    throw new Error('OpenCode directory header must not be empty');
  }

  const resolvedRequested = resolve(decoded);
  if (!existsSync(resolvedRequested)) {
    throw new Error('OpenCode directory header must resolve to an existing directory');
  }
  const requestedStat = lstatSync(resolvedRequested);
  if (!requestedStat.isDirectory()) {
    throw new Error('OpenCode directory header must resolve to a directory');
  }

  const canonicalRoot = realpathSync.native(resolve(tagmaRoot));
  const canonicalRequested = realpathSync.native(resolvedRequested);
  if (!isPathWithin(canonicalRequested, canonicalRoot)) {
    throw new Error('OpenCode directory header must stay within the workspace .tagma directory');
  }

  return encodeURIComponent(canonicalRequested);
}

/**
 * Forward one renderer request to the workspace's OpenCode runtime.
 *
 * Renderer credentials authenticate only to the sidecar. They must never be
 * passed through to OpenCode, so this function uses a strict header allowlist
 * and injects the runtime's own Basic Authorization value. The raw loopback
 * fetch also bypasses machine-level HTTP proxy settings and keeps SSE bodies
 * streaming instead of buffering until the connection closes.
 */
export async function fetchOpencodeProxy(input: OpencodeProxyRequest): Promise<Response> {
  if (!input.requestUrl.startsWith('/') || input.requestUrl.startsWith('//')) {
    throw new Error('OpenCode proxy request URL must be a relative path');
  }

  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const targetUrl = `${baseUrl}/${input.requestUrl.replace(/^\/+/, '')}`;
  const headers = new Headers();
  input.headers.forEach((value, key) => {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('Authorization', input.authorization);

  const method = input.method.toUpperCase();
  return createStreamingLoopbackFetch(baseUrl)(targetUrl, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || input.body === undefined
      ? {}
      : { body: input.body }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function pipeOpencodeProxyResponse(
  response: Response,
  res: import('express').Response,
): Promise<void> {
  res.status(response.status);
  if (response.statusText) res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  res.flushHeaders();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.length > 0) res.write(Buffer.from(value));
  }
  res.end();
}
