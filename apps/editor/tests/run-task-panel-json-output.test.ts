import { describe, expect, test } from 'bun:test';
import { shouldFormatTaskOutput } from '../src/components/run/RunTaskPanel';
import type { RunTaskState, TaskStatus } from '../src/api/client';

function taskShape(status: TaskStatus): Pick<RunTaskState, 'status'> {
  return { status };
}

describe('shouldFormatTaskOutput', () => {
  test('prompt task that has finished → format', () => {
    expect(shouldFormatTaskOutput(taskShape('success'), false)).toBe(true);
    expect(shouldFormatTaskOutput(taskShape('failed'), false)).toBe(true);
    expect(shouldFormatTaskOutput(taskShape('timeout'), false)).toBe(true);
  });

  test('command task is never formatted (stdout is logs, not JSON)', () => {
    expect(shouldFormatTaskOutput(taskShape('success'), true)).toBe(false);
  });

  test('a running task keeps the live tail-follow <pre> (incomplete JSON)', () => {
    expect(shouldFormatTaskOutput(taskShape('running'), false)).toBe(false);
  });
});
