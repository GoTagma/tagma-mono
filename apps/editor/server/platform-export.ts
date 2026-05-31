import { basename, join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { compileYamlContent, parseYaml, serializePipeline } from '@tagma/sdk/yaml';

export type TagmaPlatform = 'windows' | 'linux' | 'mac';
export type PlatformExportStage =
  | 'preparing'
  | 'syncing'
  | 'opencode'
  | 'model'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'writing';

export interface PlatformExportModelPick {
  providerID: string;
  modelID: string;
}

export interface PlatformExportProgress {
  stage: PlatformExportStage;
  detail?: string;
}

interface ConvertOptions {
  baseUrl: string;
  authHeader?: string;
  sourceYaml: string;
  sourceName: string;
  sourcePlatform: TagmaPlatform | null;
  targetPlatform: TagmaPlatform;
  model?: PlatformExportModelPick;
  onProgress?: (event: PlatformExportProgress) => void;
  signal?: AbortSignal;
}

type OpencodeRequest<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

const PLATFORM_LABELS: Record<TagmaPlatform, string> = {
  windows: 'Windows',
  linux: 'Linux',
  mac: 'macOS',
};

const PLATFORM_SHELL_HINTS: Record<TagmaPlatform, string> = {
  windows:
    'Use Windows-friendly commands. Prefer PowerShell syntax, `$env:NAME` environment variables, semicolon command separators only where PowerShell supports them, and Windows path rules when a command literal requires them.',
  linux:
    'Use Linux-friendly commands. Prefer POSIX sh/bash syntax, `$NAME` environment variables, forward slashes, and common GNU/Linux command names when a platform-specific command must change.',
  mac: 'Use macOS-friendly commands. Prefer POSIX sh/bash or zsh-compatible syntax, `$NAME` environment variables, forward slashes, and macOS/darwin command variants when they differ from Linux.',
};

const DISABLED_EXPORT_TOOLS: Record<string, boolean> = {
  bash: false,
  edit: false,
  glob: false,
  grep: false,
  list: false,
  patch: false,
  read: false,
  skill: false,
  write: false,
  task: false,
  webfetch: false,
};

const DEFAULT_PLATFORM_EXPORT_TIMEOUT_MS = 10 * 60_000;
const PLATFORM_EXPORT_TIMEOUT_MS = readPlatformExportTimeoutMs();

function readPlatformExportTimeoutMs(): number {
  const raw = process.env.TAGMA_PLATFORM_EXPORT_TIMEOUT_MS;
  if (!raw) return DEFAULT_PLATFORM_EXPORT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 60_000) return DEFAULT_PLATFORM_EXPORT_TIMEOUT_MS;
  return parsed;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds % 60 === 0) {
    const minutes = totalSeconds / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${totalSeconds} seconds`;
}

export function currentTagmaPlatform(): TagmaPlatform | null {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return 'linux';
  return null;
}

export function normalizeTagmaPlatform(value: unknown): TagmaPlatform | null {
  if (value === 'windows' || value === 'linux' || value === 'mac') return value;
  return null;
}

export function platformDisplayName(platform: TagmaPlatform): string {
  return PLATFORM_LABELS[platform];
}

export function platformExportFileName(sourcePath: string, targetPlatform: TagmaPlatform): string {
  const sourceBase = basename(sourcePath);
  const match = sourceBase.match(/^(.*?)(\.ya?ml)$/i);
  if (!match) return `${sourceBase}.${targetPlatform}.yaml`;
  return `${match[1]}.${targetPlatform}${match[2]}`;
}

export function platformExportPath(
  destDir: string,
  sourcePath: string,
  targetPlatform: TagmaPlatform,
): string {
  return join(destDir, platformExportFileName(sourcePath, targetPlatform));
}

export function parsePlatformExportModelPick(value: unknown): PlatformExportModelPick | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { providerID?: unknown; modelID?: unknown };
  if (typeof raw.providerID !== 'string' || typeof raw.modelID !== 'string') return undefined;
  if (!raw.providerID.trim() || !raw.modelID.trim()) return undefined;
  return { providerID: raw.providerID, modelID: raw.modelID };
}

export function extractPlatformYamlFromReply(reply: string): string {
  const candidates: string[] = [];
  const fenceRe = /```(?:ya?ml)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(reply))) {
    candidates.push(match[1].trim());
  }

  const trimmed = reply.trim();
  candidates.push(trimmed);
  const pipelineIndex = trimmed.search(/^pipeline:\s*$/m);
  if (pipelineIndex >= 0) {
    candidates.push(trimmed.slice(pipelineIndex).trim());
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return serializePipeline(parseYaml(candidate));
    } catch {
      /* try the next shape */
    }
  }

  throw new Error('OpenCode did not return a parseable Tagma YAML document.');
}

export async function convertPipelineYamlForPlatform(opts: ConvertOptions): Promise<string> {
  const client = createOpencodeClient({
    baseUrl: opts.baseUrl,
    ...(opts.authHeader ? { headers: { Authorization: opts.authHeader } } : {}),
    fetch: createLoopbackFetch(opts.baseUrl),
  });
  const timeoutSignal = AbortSignal.timeout(PLATFORM_EXPORT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  try {
    emitProgress(opts, 'model', 'Selecting OpenCode model');
    const model = await resolveModel(client, opts.model, signal);
    emitProgress(opts, 'model', `Using ${model.providerID}/${model.modelID}`);
    emitProgress(opts, 'opencode', 'Creating temporary OpenCode conversion session');
    const session = await unwrap(client.session.create({ body: {}, signal }));
    emitProgress(opts, 'opencode', `OpenCode session ready: ${session.id}`);
    let lastCandidate: string | null = null;

    try {
      emitProgress(opts, 'generating', 'Sending conversion prompt to OpenCode');
      const firstReply = await unwrap(
        client.session.prompt({
          signal,
          path: { id: session.id },
          body: {
            model,
            system: buildPlatformExportSystemPrompt(),
            tools: DISABLED_EXPORT_TOOLS,
            parts: [
              {
                type: 'text',
                text: buildPlatformExportPrompt(opts),
              },
            ],
          },
        }),
      );
      emitProgress(opts, 'generating', 'Received OpenCode conversion response');
      lastCandidate = extractPlatformYamlFromReply(extractText(firstReply.parts));
      emitProgress(opts, 'validating', 'Validating converted YAML');
      let validation = compileYamlContent(lastCandidate, { sourceName: opts.sourceName });
      if (validation.success) return lastCandidate;

      emitProgress(opts, 'repairing', 'Converted YAML needs repair; sending repair prompt');
      const repairReply = await unwrap(
        client.session.prompt({
          signal,
          path: { id: session.id },
          body: {
            model,
            system: buildPlatformExportSystemPrompt(),
            tools: DISABLED_EXPORT_TOOLS,
            parts: [
              {
                type: 'text',
                text: buildRepairPrompt(lastCandidate, validation),
              },
            ],
          },
        }),
      );
      emitProgress(opts, 'repairing', 'Received OpenCode repair response');
      lastCandidate = extractPlatformYamlFromReply(extractText(repairReply.parts));
      emitProgress(opts, 'validating', 'Validating repaired YAML');
      validation = compileYamlContent(lastCandidate, { sourceName: opts.sourceName });
      if (validation.success) return lastCandidate;

      throw new Error(`Converted YAML is invalid after repair: ${formatValidation(validation)}`);
    } finally {
      await unwrap(client.session.delete({ path: { id: session.id } })).catch(() => undefined);
    }
  } catch (err) {
    if (timeoutSignal.aborted && !opts.signal?.aborted) {
      throw new Error(
        `OpenCode platform export timed out after ${formatDuration(PLATFORM_EXPORT_TIMEOUT_MS)}.`,
      );
    }
    throw err;
  }
}

function emitProgress(opts: ConvertOptions, stage: PlatformExportStage, detail?: string): void {
  opts.onProgress?.({ stage, detail });
}

export function createLoopbackFetch(baseUrl: string): typeof fetch {
  const expected = new URL(baseUrl);
  if (expected.protocol !== 'http:' || !isLoopbackHost(expected.hostname)) {
    throw new Error(`OpenCode baseUrl must be loopback http, got ${baseUrl}`);
  }
  const loopbackFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== expected.protocol ||
      url.hostname !== expected.hostname ||
      effectivePort(url) !== effectivePort(expected)
    ) {
      throw new Error(`Refusing non-loopback OpenCode request: ${url.toString()}`);
    }
    return directLoopbackFetch(request, url);
  }) as typeof fetch;
  loopbackFetch.preconnect = fetch.preconnect.bind(fetch);
  return loopbackFetch;
}

async function resolveModel(
  client: ReturnType<typeof createOpencodeClient>,
  requested?: PlatformExportModelPick,
  signal?: AbortSignal,
): Promise<PlatformExportModelPick> {
  const { providers, default: defaults } = await unwrap(client.config.providers({ signal }));
  if (
    requested &&
    providers.some(
      (provider) =>
        provider.id === requested.providerID &&
        Object.prototype.hasOwnProperty.call(provider.models, requested.modelID),
    )
  ) {
    return requested;
  }

  for (const [providerID, modelID] of Object.entries(defaults)) {
    if (
      providers.some(
        (provider) =>
          provider.id === providerID &&
          Object.prototype.hasOwnProperty.call(provider.models, modelID),
      )
    ) {
      return { providerID, modelID };
    }
  }

  for (const provider of providers) {
    const modelID = Object.keys(provider.models)[0];
    if (modelID) return { providerID: provider.id, modelID };
  }

  throw new Error('No OpenCode model is configured. Connect a provider in the chat panel first.');
}

async function unwrap<T>(request: OpencodeRequest<T>): Promise<T> {
  const res = await request;
  if (res.error) {
    if (typeof res.error === 'object' && res.error !== null && 'message' in res.error) {
      throw new Error(String((res.error as { message: unknown }).message));
    }
    throw new Error(`OpenCode request failed (${res.response.status})`);
  }
  if (res.data === undefined) {
    throw new Error(`OpenCode returned no data (${res.response.status})`);
  }
  return res.data;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'http:' ? '80' : '443');
}

async function directLoopbackFetch(request: Request, url: URL): Promise<Response> {
  const port = Number(effectivePort(url));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid OpenCode loopback port: ${url.port}`);
  }

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());
  const headerLines = [
    `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Connection: close',
  ];
  const headers = new Headers(request.headers);
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('host');
  if (body.length > 0) headers.set('content-length', String(body.length));
  if (!headers.has('accept')) headers.set('accept', '*/*');
  headers.forEach((value, key) => {
    headerLines.push(`${key}: ${value}`);
  });
  const payload = Buffer.concat([Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`), body]);

  return new Promise<Response>((resolve, reject) => {
    if (request.signal.aborted) {
      reject(toAbortError(request.signal));
      return;
    }
    const chunks: Uint8Array[] = [];
    let settled = false;
    let closeSocket: (() => void) | null = null;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      done(() => {
        closeSocket?.();
        reject(toAbortError(request.signal));
      });
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    Bun.connect({
      hostname: url.hostname,
      port,
      socket: {
        open(socket) {
          closeSocket = () => socket.end();
          socket.write(payload);
        },
        data(_socket, data) {
          chunks.push(data);
        },
        close() {
          done(() => {
            try {
              resolve(parseHttpResponse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
            } catch (err) {
              reject(err);
            }
          });
        },
        error(_socket, err) {
          done(() => reject(err));
        },
      },
    }).catch((err) => done(() => reject(err)));
  });
}

function toAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error('OpenCode request was canceled.');
}

function parseHttpResponse(raw: Buffer): Response {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error('OpenCode loopback response missing HTTP headers');
  const headerText = raw.subarray(0, headerEnd).toString('latin1');
  let body = raw.subarray(headerEnd + 4);
  const lines = headerText.split(/\r\n/);
  const statusLine = lines.shift() ?? '';
  const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  if (!statusMatch) throw new Error(`OpenCode loopback response has invalid status: ${statusLine}`);
  const status = Number(statusMatch[1]);
  const statusText = statusMatch[2] ?? '';
  const headers = new Headers();
  for (const line of lines) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    headers.append(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    body = decodeChunkedBody(body);
    headers.delete('transfer-encoding');
    headers.delete('content-length');
  }
  const responseBody = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  return new Response(responseBody, { status, statusText, headers });
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('OpenCode loopback response has malformed chunked body');
    const sizeLine = body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
    const size = Number.parseInt(sizeLine, 16);
    if (!Number.isFinite(size)) {
      throw new Error('OpenCode loopback response has invalid chunk size');
    }
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size > body.length) {
      throw new Error('OpenCode loopback response has truncated chunked body');
    }
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function buildPlatformExportSystemPrompt(): string {
  return [
    'You convert Tagma pipeline YAML between operating systems.',
    'Return only one complete YAML document. Do not use markdown fences. Do not explain.',
    'Do not create, edit, delete, or inspect files. Work only from the YAML in the user message.',
    'Keep the top-level `pipeline:` wrapper and preserve the pipeline graph unless a command requires a platform-specific rewrite.',
  ].join('\n');
}

function buildPlatformExportPrompt(opts: ConvertOptions): string {
  const sourceLabel = opts.sourcePlatform
    ? platformDisplayName(opts.sourcePlatform)
    : 'unknown host OS';
  const targetLabel = platformDisplayName(opts.targetPlatform);
  return [
    `Convert this Tagma pipeline YAML from ${sourceLabel} to ${targetLabel}.`,
    '',
    `Target platform guidance: ${PLATFORM_SHELL_HINTS[opts.targetPlatform]}`,
    '',
    'Rules:',
    '- Preserve track IDs, task IDs, task names, dependencies, inputs, outputs, triggers, completions, permissions, timeouts, driver/model settings, and prompt intent.',
    '- Rewrite OS-specific command strings, hook command strings, cwd values, path literals, environment-variable syntax, and prompt wording only when needed for the target platform.',
    '- Do not invent new workspace scripts, tools, plugins, dependencies, or task IDs.',
    '- Keep cross-platform commands unchanged when they are already valid on the target platform.',
    '- If a command cannot be safely translated, keep the task and replace only that command with a clear target-platform shell command that prints the manual translation requirement and exits non-zero.',
    '',
    'YAML to convert:',
    '```yaml',
    opts.sourceYaml,
    '```',
  ].join('\n');
}

function buildRepairPrompt(
  candidate: string,
  validation: ReturnType<typeof compileYamlContent>,
): string {
  return [
    'The converted YAML did not pass Tagma validation.',
    `Validation result: ${formatValidation(validation)}`,
    '',
    'Return a repaired complete YAML document only.',
    '',
    'Invalid YAML:',
    '```yaml',
    candidate,
    '```',
  ].join('\n');
}

function formatValidation(validation: ReturnType<typeof compileYamlContent>): string {
  const errors = validation.validation.errors.map((e) => `${e.path}: ${e.message}`);
  if (errors.length === 0) return validation.summary;
  return `${validation.summary}; ${errors.join('; ')}`;
}

function extractText(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n')
    .trim();
}
