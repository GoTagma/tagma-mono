import { describe, expect, test } from 'bun:test';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from '../server/chat-pipeline-trial-cache';

describe('chat pipeline trial cache protocol', () => {
  test('cache version is pinned', () => {
    expect(CHAT_PIPELINE_TRIAL_CACHE_VERSION).toBe(33);
  });
});
