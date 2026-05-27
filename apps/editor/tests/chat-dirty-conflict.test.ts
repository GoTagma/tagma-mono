import { describe, expect, test } from 'bun:test';
import {
  hasLocalEditorChanges,
  resolveDirtyDiskChange,
  shouldShowReloadFailureDialog,
} from '../src/utils/chat-dirty-conflict';

describe('chat dirty conflict decisions', () => {
  test('clean editors adopt disk changes without prompting', () => {
    expect(
      resolveDirtyDiskChange({
        source: 'chat',
        policy: 'ask',
        hasLocalChanges: false,
      }),
    ).toBe('adopt-disk');
  });

  test('chat changes prompt when the current editor is dirty and policy is ask', () => {
    expect(
      resolveDirtyDiskChange({
        source: 'chat',
        policy: 'ask',
        hasLocalChanges: true,
      }),
    ).toBe('prompt');
  });

  test('chat changes preserve local edits when policy is prefer-user', () => {
    expect(
      resolveDirtyDiskChange({
        source: 'chat',
        policy: 'prefer-user',
        hasLocalChanges: true,
      }),
    ).toBe('preserve-local');
  });

  test('chat changes adopt disk when policy is prefer-agent', () => {
    expect(
      resolveDirtyDiskChange({
        source: 'chat',
        policy: 'prefer-agent',
        hasLocalChanges: true,
      }),
    ).toBe('adopt-disk');
  });

  test('non-chat disk changes prompt instead of silently replacing local layout edits', () => {
    expect(
      resolveDirtyDiskChange({
        source: 'external',
        policy: 'prefer-agent',
        hasLocalChanges: true,
      }),
    ).toBe('prompt');
  });

  test('layoutDirty and recent local field edits count as local editor changes', () => {
    expect(hasLocalEditorChanges({ isDirty: false, layoutDirty: true })).toBe(true);
    expect(
      hasLocalEditorChanges({
        isDirty: false,
        layoutDirty: false,
        lastLocalFieldEditAt: 1_000,
        now: 2_000,
      }),
    ).toBe(true);
  });

  test('chat reconcile can ignore a stale recent field timestamp after save preflight', () => {
    expect(
      hasLocalEditorChanges({
        isDirty: false,
        layoutDirty: false,
        lastLocalFieldEditAt: 1_000,
        now: 1_500,
        includeRecentLocalFieldEdits: false,
      }),
    ).toBe(false);
    expect(
      resolveDirtyDiskChange({
        source: 'chat',
        policy: 'ask',
        hasLocalChanges: false,
      }),
    ).toBe('adopt-disk');
  });

  test('chat-active reload failures defer to post-chat reconcile instead of showing a dialog', () => {
    expect(
      shouldShowReloadFailureDialog({
        source: 'chat',
        chatDrivenLikely: true,
      }),
    ).toBe(false);

    expect(
      shouldShowReloadFailureDialog({
        source: 'chat',
        chatDrivenLikely: false,
      }),
    ).toBe(true);

    expect(
      shouldShowReloadFailureDialog({
        source: 'external',
        chatDrivenLikely: true,
      }),
    ).toBe(true);
  });
});
