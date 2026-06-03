import { describe, expect, test } from 'bun:test';
import {
  customProviderProbeRequest,
  isCurrentCustomProviderProbeRequest,
} from '../src/components/chat/custom-provider-probe-request';

describe('custom provider probe request identity', () => {
  test('normalizes base URL and blank API keys for request comparisons', () => {
    expect(customProviderProbeRequest(7, '  http://localhost:11434/v1  ', '   ')).toEqual({
      runId: 7,
      baseURL: 'http://localhost:11434/v1',
      apiKey: null,
    });
    expect(customProviderProbeRequest(7, 'http://localhost:11434/v1', ' key ')).toEqual({
      runId: 7,
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'key',
    });
  });

  test('rejects stale probe results after modal reopen, URL edit, or API key edit', () => {
    const request = customProviderProbeRequest(2, 'https://api.example.com/v1', 'secret');

    expect(
      isCurrentCustomProviderProbeRequest(request, 2, ' https://api.example.com/v1 ', ' secret '),
    ).toBe(true);
    expect(
      isCurrentCustomProviderProbeRequest(request, 3, 'https://api.example.com/v1', 'secret'),
    ).toBe(false);
    expect(
      isCurrentCustomProviderProbeRequest(request, 2, 'https://other.example.com/v1', 'secret'),
    ).toBe(false);
    expect(
      isCurrentCustomProviderProbeRequest(request, 2, 'https://api.example.com/v1', 'new-secret'),
    ).toBe(false);
  });
});
