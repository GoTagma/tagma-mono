import { describe, expect, test } from 'bun:test';

import {
  DIAGNOSTICS_AGENT_BASE_PATH,
  DiagnosticsHub,
  diagnosticsAgentAuthorization,
  isDiagnosticsAgentPath,
} from '../server/diagnostics.js';
import {
  redactDiagnosticText,
  sanitizeDiagnosticValue,
} from '../shared/diagnostics.js';

describe('diagnostics value sanitizing', () => {
  test('redacts credential fields and credential-shaped text without hiding token counts', () => {
    const sanitized = sanitizeDiagnosticValue({
      authorization: 'Bearer super-secret-bearer',
      password: 'hunter2',
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      tokensIn: 123,
      nested: {
        message:
          'Authorization: Basic dGFnbWE6c2VjcmV0 and OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      },
    });

    expect(sanitized).toEqual({
      authorization: '[REDACTED]',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      tokensIn: 123,
      nested: {
        message: 'Authorization: Basic [REDACTED] and OPENAI_API_KEY=[REDACTED]',
      },
    });
  });

  test('bounds deep, wide, and long renderer-controlled values', () => {
    const sanitized = sanitizeDiagnosticValue(
      {
        long: 'x'.repeat(100),
        list: [1, 2, 3, 4],
        nested: { child: { value: 'too deep' } },
      },
      {
        maxStringChars: 12,
        maxArrayItems: 2,
        maxDepth: 2,
      },
    ) as {
      long: string;
      list: unknown[];
      nested: { child: unknown };
    };

    expect(sanitized.long).toBe('xxxxxxxxxxxx…[truncated 88 chars]');
    expect(sanitized.list).toEqual([1, 2, { __truncatedItems: 2 }]);
    expect(sanitized.nested.child).toEqual({ __truncatedDepth: true });
  });

  test('redacts secrets embedded in URLs and shell-style assignments', () => {
    const text = redactDiagnosticText(
      'https://example.test/callback?access_token=abc123&mode=ok password="do not print"',
    );

    expect(text).toBe(
      'https://example.test/callback?access_token=[REDACTED]&mode=ok password=[REDACTED]',
    );
  });
});

describe('temporary diagnostics sessions', () => {
  test('are off by default, rotate independent read-only tokens, and revoke on disable', () => {
    const tokens = ['debug-token-one', 'debug-token-two'];
    const hub = new DiagnosticsHub({
      tokenFactory: () => tokens.shift() ?? 'unexpected-token',
    });

    expect(hub.getStatus('http://127.0.0.1:43123').enabled).toBe(false);
    expect(hub.authorize('debug-token-one')).toBe(false);

    const first = hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(first).toMatchObject({
      enabled: true,
      workspaceKey: 'D:\\repo',
      connection: {
        baseUrl: `http://127.0.0.1:43123${DIAGNOSTICS_AGENT_BASE_PATH}`,
        token: 'debug-token-one',
      },
    });
    expect(hub.authorize('debug-token-one')).toBe(true);

    const second = hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(second.connection?.token).toBe('debug-token-two');
    expect(hub.authorize('debug-token-one')).toBe(false);
    expect(hub.authorize('debug-token-two')).toBe(true);

    hub.disable();
    expect(hub.authorize('debug-token-two')).toBe(false);
    expect(hub.getStatus('http://127.0.0.1:43123')).toEqual({ enabled: false });
  });

  test('keeps a bounded, cursor-addressable log tail from sidecar, OpenCode, and renderer', () => {
    const hub = new DiagnosticsHub({
      maxLogEntries: 3,
      maxLogBytes: 10_000,
      tokenFactory: () => 'debug-token',
    });
    hub.recordLog('sidecar.stdout', 'info', 'one');
    hub.recordLog('opencode.stderr', 'error', 'two password=secret');
    hub.recordLog('renderer.console', 'warn', 'three');
    hub.recordLog('sidecar.stdout', 'info', 'four');

    const page = hub.readLogs(1, 10);
    expect(page.entries.map((entry) => entry.message)).toEqual([
      'two password=[REDACTED]',
      'three',
      'four',
    ]);
    expect(page).toMatchObject({
      oldestCursor: 2,
      nextCursor: 4,
      droppedBeforeCursor: false,
    });
    expect(hub.readLogs(0, 10).droppedBeforeCursor).toBe(true);
  });

  test('accepts only bounded renderer reports while a session is enabled', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const report = {
      instanceId: 'window-1',
      workspaceKey: 'D:\\repo',
      capturedAt: 123,
      snapshot: {
        chat: {
          currentSessionId: 'session-1',
          apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
        },
      },
      logs: [
        {
          timestamp: 100,
          level: 'error' as const,
          message: 'renderer failed with password=hunter2',
        },
      ],
    };

    expect(hub.acceptRendererReport(report)).toBe(false);
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(hub.acceptRendererReport(report)).toBe(true);

    expect(hub.getRendererReports()).toEqual([
      {
        instanceId: 'window-1',
        workspaceKey: 'D:\\repo',
        capturedAt: 123,
        snapshot: {
          chat: {
            currentSessionId: 'session-1',
            apiKey: '[REDACTED]',
          },
        },
      },
    ]);
    expect(
      hub
        .readLogs(0, 10)
        .entries.find((entry) => entry.source === 'renderer.error')?.message,
    ).toBe('renderer failed with password=[REDACTED]');
  });
});

describe('diagnostics agent authorization boundary', () => {
  test('recognizes only the dedicated diagnostics subtree', () => {
    expect(isDiagnosticsAgentPath('/api/diagnostics/v1/context')).toBe(true);
    expect(isDiagnosticsAgentPath('/api/diagnostics/v1/logs')).toBe(true);
    expect(isDiagnosticsAgentPath('/api/diagnostics/session')).toBe(false);
    expect(isDiagnosticsAgentPath('/api/state')).toBe(false);
  });

  test('never lets a diagnostics token authorize a normal sidecar API route', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');

    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'GET',
        'Bearer debug-token',
      ),
    ).toEqual({ kind: 'authorized' });
    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'POST',
        'Bearer debug-token',
      ),
    ).toEqual({ kind: 'rejected', status: 405, error: 'Diagnostics agent API is read-only.' });
    expect(
      diagnosticsAgentAuthorization(hub, '/api/state', 'GET', 'Bearer debug-token'),
    ).toEqual({ kind: 'not-diagnostics' });
    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'GET',
        'Bearer wrong-token',
      ),
    ).toEqual({
      kind: 'rejected',
      status: 403,
      error: 'Invalid diagnostics token.',
    });
  });
});
