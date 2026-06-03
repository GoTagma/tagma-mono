export interface CustomProviderProbeRequest {
  runId: number;
  baseURL: string;
  apiKey: string | null;
}

export function customProviderProbeRequest(
  runId: number,
  baseURL: string,
  apiKey?: string | null,
): CustomProviderProbeRequest {
  const trimmedKey = apiKey?.trim() ?? '';
  return {
    runId,
    baseURL: baseURL.trim(),
    apiKey: trimmedKey ? trimmedKey : null,
  };
}

export function isCurrentCustomProviderProbeRequest(
  request: CustomProviderProbeRequest,
  currentRunId: number,
  currentBaseURL: string,
  currentApiKey?: string | null,
): boolean {
  const current = customProviderProbeRequest(currentRunId, currentBaseURL, currentApiKey);
  return (
    request.runId === current.runId &&
    request.baseURL === current.baseURL &&
    request.apiKey === current.apiKey
  );
}
