export interface DownloadToBufferOptions {
  url: string;
  label: string;
  maxBytes: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
  expectedBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface DownloadToBufferResult {
  buffer: Buffer;
  bytesReceived: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

class DownloadError extends Error {
  readonly retryable: boolean;

  constructor(label: string, message: string, retryable: boolean) {
    super(`${label} download failed: ${message}`);
    this.name = 'DownloadError';
    this.retryable = retryable;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function declaredSizeFromHeaders(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function combinedSignal(internal: AbortSignal, external?: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([internal, external]) : internal;
}

function isDownloadError(label: string, err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(`${label} download failed:`);
}

function isRetryableDownloadError(err: unknown): boolean {
  return err instanceof DownloadError && err.retryable;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function normalizeAttemptCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value));
}

async function delay(ms: number, externalSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (externalSignal?.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      finish();
    };
    const timer = setTimeout(finish, ms);
    externalSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch a hot-update asset into memory with an idle timeout, not a total-time
 * timeout. GitHub release assets can be slow on some networks; abort only when
 * transfer makes no progress for a full idle window.
 */
export async function downloadUrlToBuffer(
  options: DownloadToBufferOptions,
): Promise<DownloadToBufferResult> {
  const maxAttempts = normalizeAttemptCount(options.maxAttempts);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await downloadUrlToBufferOnce(options);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableDownloadError(err)) throw err;
      await delay(retryDelayMs * attempt, options.signal);
    }
  }
  throw lastError;
}

async function downloadUrlToBufferOnce(
  options: DownloadToBufferOptions,
): Promise<DownloadToBufferResult> {
  const { url, label, maxBytes, idleTimeoutMs, signal: externalSignal, expectedBytes } = options;
  const idleController = new AbortController();
  const signal = combinedSignal(idleController.signal, externalSignal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let idleTimedOut = false;
  let bytesReceived = 0;
  let declaredBytes: number | null = expectedBytes ?? null;

  const error = (message: string, retryable = false): Error =>
    new DownloadError(label, message, retryable);
  const receivedSummary = (): string => {
    const expected = declaredBytes !== null ? ` of ${formatBytes(declaredBytes)}` : '';
    return `${formatBytes(bytesReceived)}${expected}`;
  };

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const idleTimeoutError = (): Error =>
    error(
      `timed out after ${formatDuration(idleTimeoutMs)} with no new data from ${url} (received ${receivedSummary()})`,
      true,
    );
  const withIdleTimeout = async <T>(op: Promise<T>): Promise<T> => {
    clearIdleTimer();
    try {
      return await Promise.race([
        op,
        new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => {
            idleTimedOut = true;
            idleController.abort();
            void reader?.cancel().catch(() => {});
            reject(idleTimeoutError());
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      clearIdleTimer();
    }
  };

  try {
    const res = await withIdleTimeout(fetch(url, { signal }));
    if (!res.ok) {
      throw error(`HTTP ${res.status} from ${url}`, isRetryableHttpStatus(res.status));
    }
    if (!res.body) throw error(`response has no body from ${url}`);

    const headerSize = declaredSizeFromHeaders(res);
    if (headerSize !== null) {
      if (expectedBytes === undefined) declaredBytes = headerSize;
      if (expectedBytes !== undefined && headerSize !== expectedBytes) {
        throw error(
          `declared size ${formatBytes(headerSize)} from ${url} does not match manifest size ${formatBytes(expectedBytes)}`,
        );
      }
      if (headerSize > maxBytes) {
        throw error(
          `declared size ${formatBytes(headerSize)} exceeds ${formatBytes(maxBytes)} cap from ${url}`,
        );
      }
    }

    reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await withIdleTimeout(reader.read());
      if (idleTimedOut) {
        throw idleTimeoutError();
      }
      if (done) break;
      if (!value) continue;
      bytesReceived += value.byteLength;
      if (bytesReceived > maxBytes) {
        void reader.cancel().catch(() => {});
        throw error(
          `exceeds ${formatBytes(maxBytes)} cap from ${url} (received ${formatBytes(bytesReceived)}+)`,
        );
      }
      chunks.push(value);
    }

    if (expectedBytes !== undefined && bytesReceived !== expectedBytes) {
      throw error(
        `size mismatch from ${url}: manifest expected ${formatBytes(expectedBytes)}, got ${formatBytes(bytesReceived)}`,
        true,
      );
    }

    return {
      buffer: Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytesReceived,
      ),
      bytesReceived,
    };
  } catch (err) {
    if (externalSignal?.aborted) throw err;
    if (idleTimedOut && !isDownloadError(label, err)) {
      throw error(
        `timed out after ${formatDuration(idleTimeoutMs)} with no new data from ${url} (received ${receivedSummary()})`,
        true,
      );
    }
    if (isDownloadError(label, err)) throw err;
    if (err instanceof Error) {
      throw error(`${err.message} from ${url} (received ${receivedSummary()})`, true);
    }
    throw error(`${String(err)} from ${url} (received ${receivedSummary()})`, true);
  } finally {
    clearIdleTimer();
  }
}
