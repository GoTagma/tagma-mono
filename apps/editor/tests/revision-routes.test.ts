import { describe, expect, test } from 'bun:test';

import { bypassesRevisionCheck } from '../server/revision-routes';

describe('revision route bypass', () => {
  test('bypasses all hot-update mutation endpoints', () => {
    expect(bypassesRevisionCheck('/api/editor/update')).toBe(true);
    expect(bypassesRevisionCheck('/api/sidecar/update')).toBe(true);
    expect(bypassesRevisionCheck('/api/release/update')).toBe(true);
  });

  test('does not bypass normal stateful mutations', () => {
    expect(bypassesRevisionCheck('/api/save')).toBe(false);
    expect(bypassesRevisionCheck('/api/pipeline/update-task')).toBe(false);
  });

  test('bypasses run control endpoints because they do not return ServerState', () => {
    expect(bypassesRevisionCheck('/api/run/start')).toBe(true);
    expect(bypassesRevisionCheck('/api/run/abort')).toBe(true);
    expect(bypassesRevisionCheck('/api/run/approval/request-1')).toBe(true);
  });

  test('bypasses /api/export-file so exporting does not bump revision', () => {
    // Export copies the current pipeline + layout to an external directory.
    // It does not mutate ws.config / ws.layout, so collaborators must not see
    // a phantom revision bump for it; otherwise the next real mutation 409s
    // on a stale client baseline.
    expect(bypassesRevisionCheck('/api/export-file')).toBe(true);
    expect(bypassesRevisionCheck('/api/export-file/platform')).toBe(true);
  });

  test('bypasses secrets endpoints because they manage OS-backed metadata outside pipeline state', () => {
    expect(bypassesRevisionCheck('/api/secrets')).toBe(true);
    expect(bypassesRevisionCheck('/api/secrets/123e4567-e89b-12d3-a456-426614174000')).toBe(true);
  });

  test('bypasses workflow creation because it does not return ServerState', () => {
    expect(bypassesRevisionCheck('/api/workspace/workflows')).toBe(true);
  });

  test('bypasses chat bridge endpoints because they manage sidecar/bot state outside pipeline state', () => {
    expect(bypassesRevisionCheck('/api/chat-bridge/status')).toBe(true);
    expect(bypassesRevisionCheck('/api/chat-bridge/pair/new')).toBe(true);
    expect(bypassesRevisionCheck('/api/chat-bridge/token')).toBe(true);
  });
});
