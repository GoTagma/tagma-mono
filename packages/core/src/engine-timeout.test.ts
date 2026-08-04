import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TASK_TIMEOUT_MS,
  resolvePipelineTimeoutMs,
} from './engine';
import { DEFAULT_HOOK_TIMEOUT_MS } from './hooks';

describe('host execution timeout defaults', () => {
  test('uses the two-hour recommended task budget', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(2 * 60 * 60 * 1_000);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(2 * 60 * 60 * 1_000);
  });

  test('uses the host pipeline lifecycle only when YAML does not author one', () => {
    expect(resolvePipelineTimeoutMs({}, 8 * 60 * 60 * 1_000)).toBe(8 * 60 * 60 * 1_000);
    expect(resolvePipelineTimeoutMs({ timeout: '45m' }, 8 * 60 * 60 * 1_000)).toBe(
      45 * 60 * 1_000,
    );
    expect(resolvePipelineTimeoutMs({})).toBe(0);
  });
});
