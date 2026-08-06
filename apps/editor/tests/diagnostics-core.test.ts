import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DIAGNOSTICS_AGENT_BASE_PATH,
  DiagnosticsHub,
  diagnosticsAgentAuthorization,
  isDiagnosticsAgentPath,
} from '../server/diagnostics.js';
import { buildDefaultDiagnosticsContext } from '../server/routes/diagnostics.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from '../shared/diagnostics.js';

describe('diagnostics value sanitizing', () => {
  test('redacts credential fields and credential-shaped text without hiding token counts', () => {
    const sanitized = sanitizeDiagnosticValue({
      authorization: 'Bearer super-secret-bearer',
      password: 'hunter2',
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      futureFeatureToken: 'future-feature-session-token',
      pluginCredential: 'future-feature-credential',
      tokensIn: 123,
      tokenCount: 456,
      nested: {
        message:
          'Authorization: Basic dGFnbWE6c2VjcmV0 and OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz and token=future-token',
      },
    });

    expect(sanitized).toEqual({
      authorization: '[REDACTED]',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      futureFeatureToken: '[REDACTED]',
      pluginCredential: '[REDACTED]',
      tokensIn: 123,
      tokenCount: 456,
      nested: {
        message:
          'Authorization: Basic [REDACTED] and OPENAI_API_KEY=[REDACTED] and token=[REDACTED]',
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

    expect(sanitized.long).toBe('xxxxxxxxxxxx...[diagnostics-sanitizer truncated 88 chars]');
    expect(sanitized.list).toEqual([
      1,
      2,
      { __truncatedItems: 2, __truncationLayer: 'diagnostics-sanitizer' },
    ]);
    expect(sanitized.nested.child).toEqual({
      __truncatedDepth: true,
      __truncationLayer: 'diagnostics-sanitizer',
    });
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
  test('keeps the newest desktop log records when the context bounds a long tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-diagnostics-log-'));
    const logPath = join(root, 'sidecar.log');
    const previousLogPath = process.env.TAGMA_DESKTOP_LOG_FILE;
    const newestMarker = '2026-08-05T02:21:11.573Z stdout: newest-sidecar-record';
    writeFileSync(
      logPath,
      `${'2026-07-31T00:00:00.000Z stdout: old-record\n'.repeat(20_000)}${newestMarker}\n`,
      'utf-8',
    );
    process.env.TAGMA_DESKTOP_LOG_FILE = logPath;

    try {
      const context = buildDefaultDiagnosticsContext(new DiagnosticsHub(), null) as {
        desktopLogTail: {
          truncated: boolean;
          totalBytes: number;
          readBytes: number;
          sourceReturnedBytes: number;
          returnedBytes: number;
          truncation: {
            layer: string;
            omittedHeadBytes: number;
            discardedPartialLineBytes: number;
          };
          text: string;
        };
        desktopLogTailRead: { status: string; path: string | null; error: string | null };
      };
      expect(context.desktopLogTail.truncated).toBe(true);
      expect(context.desktopLogTail.text).toContain(newestMarker);
      expect(context.desktopLogTail.totalBytes).toBeGreaterThan(context.desktopLogTail.readBytes);
      expect(context.desktopLogTail.readBytes).toBe(32 * 1024);
      expect(context.desktopLogTail.sourceReturnedBytes).toBeLessThanOrEqual(
        context.desktopLogTail.readBytes,
      );
      expect(context.desktopLogTail.returnedBytes).toBeGreaterThan(0);
      expect(context.desktopLogTail.truncation).toMatchObject({
        layer: 'diagnostics-desktop-log-tail',
        omittedHeadBytes: expect.any(Number),
        discardedPartialLineBytes: expect.any(Number),
      });
      expect(context.desktopLogTailRead).toEqual({
        status: 'available',
        path: logPath,
        error: null,
      });
    } finally {
      if (previousLogPath === undefined) delete process.env.TAGMA_DESKTOP_LOG_FILE;
      else process.env.TAGMA_DESKTOP_LOG_FILE = previousLogPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  test('never carries captured data into a later workspace session', () => {
    const tokens = ['workspace-a-token', 'workspace-b-token'];
    const hub = new DiagnosticsHub({
      tokenFactory: () => tokens.shift() ?? 'unexpected-token',
    });

    hub.enable('D:\\workspace-a', 'http://127.0.0.1:43123');
    hub.recordLog('sidecar.stdout', 'info', 'workspace-a-only-marker');
    expect(
      hub.acceptRendererReport({
        instanceId: 'workspace-a-window',
        workspaceKey: 'D:\\workspace-a',
        capturedAt: 123,
        snapshot: { marker: 'workspace-a-only-marker' },
        logs: [],
      }),
    ).toBe(true);

    hub.disable();
    hub.enable('D:\\workspace-b', 'http://127.0.0.1:43123');

    expect(hub.getRendererReports()).toEqual([]);
    expect(
      hub.readLogs(0, 10).entries.map(({ cursor, source, message }) => ({
        cursor,
        source,
        message,
      })),
    ).toEqual([
      {
        cursor: 1,
        source: 'diagnostics',
        message: 'A temporary read-only diagnostics session was enabled.',
      },
    ]);
  });

  test('keeps a bounded, cursor-addressable log tail from sidecar, OpenCode, and renderer', () => {
    const hub = new DiagnosticsHub({
      maxLogEntries: 3,
      maxLogBytes: 10_000,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    hub.recordLog('sidecar.stdout', 'info', 'one');
    hub.recordLog('opencode.stderr', 'error', 'two password=secret');
    hub.recordLog('renderer.console', 'warn', 'three');
    hub.recordLog('sidecar.stdout', 'info', 'four');

    const page = hub.readLogs(2, 10);
    expect(page.entries.map((entry) => entry.message)).toEqual([
      'two password=[REDACTED]',
      'three',
      'four',
    ]);
    expect(page).toMatchObject({
      oldestCursor: 3,
      latestCursor: 5,
      nextCursor: 5,
      droppedBeforeCursor: false,
      retainedEntryCount: 3,
      availableEntryCount: 3,
      returnedEntryCount: 3,
      omittedEntryCount: 0,
      hasMore: false,
      retention: {
        layer: 'diagnostics-log-buffer',
        droppedEntryCount: 2,
        requestedEntryLossCount: 0,
        truncated: false,
      },
      page: {
        layer: 'diagnostics-log-page',
        limit: 10,
        omittedEntryCount: 0,
        truncated: false,
      },
    });
    expect(hub.readLogs(0, 10)).toMatchObject({
      droppedBeforeCursor: true,
      retention: { requestedEntryLossCount: 2, truncated: true },
    });
    expect(hub.readLogs(2, 1)).toMatchObject({
      returnedEntryCount: 1,
      omittedEntryCount: 2,
      hasMore: true,
      page: { limit: 1, omittedEntryCount: 2, truncated: true },
    });
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
        logEvidence: {
          layer: 'renderer-report-log-ingest',
          sourceLogCount: 1,
          selectedLogCount: 1,
          ingestedLogCount: 1,
          omittedHeadCount: 0,
          invalidSelectedCount: 0,
        },
      },
    ]);
    expect(
      hub.readLogs(0, 10).entries.find((entry) => entry.source === 'renderer.error')?.message,
    ).toBe('renderer failed with password=[REDACTED]');
  });

  test('reports renderer-log ingest clipping separately from retained log paging', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(
      hub.acceptRendererReport({
        instanceId: 'window-many-logs',
        workspaceKey: 'D:\\repo',
        capturedAt: 456,
        snapshot: {},
        logs: Array.from({ length: 252 }, (_, index) => ({
          timestamp: index,
          level: 'info' as const,
          message: `renderer-log-${index}`,
        })),
      }),
    ).toBe(true);

    expect(hub.getRendererReports()[0]).toMatchObject({
      logEvidence: {
        layer: 'renderer-report-log-ingest',
        sourceLogCount: 252,
        selectedLogCount: 250,
        ingestedLogCount: 250,
        omittedHeadCount: 2,
        invalidSelectedCount: 0,
      },
    });
    expect(hub.readLogs(0, 1)).toMatchObject({
      page: { layer: 'diagnostics-log-page', truncated: true },
    });
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
    expect(diagnosticsAgentAuthorization(hub, '/api/state', 'GET', 'Bearer debug-token')).toEqual({
      kind: 'not-diagnostics',
    });
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
