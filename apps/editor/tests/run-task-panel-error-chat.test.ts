import { describe, expect, test } from 'bun:test';
import { canAskChatForTaskError, openTaskOutputPath } from '../src/components/run/RunTaskPanel';
import type { RunTaskState } from '../src/api/client';

function taskShape(
  overrides: Partial<RunTaskState>,
): Pick<RunTaskState, 'status' | 'stderr' | 'stderrPath'> {
  return {
    status: 'success',
    stderr: '',
    stderrPath: null,
    ...overrides,
  };
}

describe('canAskChatForTaskError', () => {
  test('allows failed, timed out, and blocked task states', () => {
    expect(canAskChatForTaskError(taskShape({ status: 'failed' }))).toBe(true);
    expect(canAskChatForTaskError(taskShape({ status: 'timeout' }))).toBe(true);
    expect(canAskChatForTaskError(taskShape({ status: 'blocked' }))).toBe(true);
  });

  test('allows success states with captured stderr or stderr path', () => {
    expect(canAskChatForTaskError(taskShape({ stderr: 'warned anyway' }))).toBe(true);
    expect(canAskChatForTaskError(taskShape({ stderrPath: 'D:/logs/task.stderr.log' }))).toBe(true);
  });

  test('does not allow successful tasks without error context', () => {
    expect(canAskChatForTaskError(taskShape({ status: 'success' }))).toBe(false);
  });
});

describe('openTaskOutputPath', () => {
  test('reports reveal failures to the caller instead of swallowing them', async () => {
    const errors: string[] = [];

    await openTaskOutputPath('E:/repo/.tagma/logs/run_1/t.stdout', {
      reveal: async () => {
        throw new Error('File not found');
      },
      onError: (message) => errors.push(message),
    });

    expect(errors).toEqual(['File not found']);
  });
});
