import { describe, expect, test } from 'bun:test';

import {
  buildOpencodeClientConfig,
  buildOpencodeRequestHeaders,
  buildOpencodeV2ClientConfig,
} from '../src/api/opencode-chat';

describe('opencode browser client auth', () => {
  test('SDK client config carries the embedded server Basic Auth header', () => {
    const config = buildOpencodeClientConfig('http://127.0.0.1:4096', 'Basic abc123');

    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { Authorization: 'Basic abc123' },
      throwOnError: true,
    });
  });

  test('SDK v2 client config keeps auth and structured error wrapping enabled', () => {
    const config = buildOpencodeV2ClientConfig('http://127.0.0.1:4096', 'Basic abc123');

    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { Authorization: 'Basic abc123' },
      throwOnError: true,
    });
  });

  test('raw OpenCode fetch headers include Basic Auth when present', () => {
    expect(buildOpencodeRequestHeaders('Basic abc123')).toEqual({
      Authorization: 'Basic abc123',
    });
    expect(buildOpencodeRequestHeaders(undefined)).toEqual({});
  });
});
