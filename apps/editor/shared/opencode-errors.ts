function messageFromRecord(record: Record<string, unknown>): string | null {
  const direct = record.message;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const data = record.data;
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>;
    const nested = dataRecord.message;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }

  const name = record.name;
  if (typeof name === 'string' && name.trim()) return name.trim();

  return null;
}

function statusFromCause(cause: unknown): number | string | null {
  if (!cause || typeof cause !== 'object') return null;
  const status = (cause as { status?: unknown }).status;
  return typeof status === 'number' || typeof status === 'string' ? status : null;
}

export function describeOpencodeError(error: unknown, response?: Response): string {
  if (error instanceof Error) {
    const status = statusFromCause((error as { cause?: unknown }).cause);
    if (status && error.message && !/^HTTP\s+\d+:/i.test(error.message)) {
      return `HTTP ${status}: ${error.message}`;
    }
    if (error.message) return error.message;
  }

  if (typeof error === 'string' && error.trim()) return error.trim();

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = messageFromRecord(record);
    if (message) {
      const data = record.data;
      const status =
        data && typeof data === 'object' ? (data as Record<string, unknown>).statusCode : undefined;
      if (typeof status === 'number' || typeof status === 'string') {
        return `HTTP ${status}: ${message}`;
      }
      return message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }

  if (response) return `OpenCode request failed (${response.status})`;
  return 'Unknown OpenCode error';
}

export function toOpencodeError(error: unknown, response?: Response): Error {
  if (error instanceof Error && error.message) return error;
  const wrapped = new Error(describeOpencodeError(error, response));
  (wrapped as { cause?: unknown }).cause = response
    ? { body: error, status: response.status }
    : error;
  return wrapped;
}
