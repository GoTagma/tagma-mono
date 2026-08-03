import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from './index';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-runtime-failure-journey-'));
}

function finalTaskUpdate(events: RunEventPayload[], taskId: string) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'task_update' && event.taskId === taskId) return event;
  }
  return undefined;
}

function downstreamMarkerArgv(markerPath: string): readonly string[] {
  return [
    process.execPath,
    '-e',
    "require('node:fs').writeFileSync(process.argv[1], 'downstream ran', 'utf8')",
    markerPath,
  ];
}

function missingBinaryYaml(missingBinary: string, markerPath: string): string {
  return [
    'pipeline:',
    '  name: missing-binary-user-journey',
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      on_failure: skip_downstream',
    '      tasks:',
    '        - id: missing',
    '          name: Missing command',
    '          command:',
    '            argv: ' + JSON.stringify([missingBinary]),
    '        - id: downstream',
    '          name: Must not run',
    '          depends_on: [missing]',
    '          command:',
    '            argv: ' + JSON.stringify(downstreamMarkerArgv(markerPath)),
    '',
  ].join('\n');
}

function malformedJsonYaml(markerPath: string): string {
  return [
    'pipeline:',
    '  name: malformed-json-user-journey',
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      on_failure: skip_downstream',
    '      tasks:',
    '        - id: producer',
    '          name: Invalid JSON producer',
    '          command:',
    '            argv: ' +
      JSON.stringify([
        process.execPath,
        '-e',
        'process.stdout.write("{\\"answer\\":")',
      ]),
    '          outputs:',
    '            answer:',
    '              from: json.answer',
    '              type: string',
    '        - id: downstream',
    '          name: Must not run',
    '          depends_on: [producer]',
    '          command:',
    '            argv: ' + JSON.stringify(downstreamMarkerArgv(markerPath)),
    '',
  ].join('\n');
}

describe('user journey - real runtime failures from YAML', () => {
  test('surfaces a missing command binary in results and events, then skips its downstream task', async () => {
    const dir = makeDir();
    const missingBinary = 'tagma-command-that-does-not-exist-7c5ab6';
    const downstreamMarker = join(dir, 'missing-binary-downstream-ran.txt');

    try {
      const events: RunEventPayload[] = [];
      const outcome = await createTagma().runYaml(missingBinaryYaml(missingBinary, downstreamMarker), {
        cwd: dir,
        onEvent: (event) => events.push(event),
      });

      expect(outcome.kind).toBe('pipeline');
      if (outcome.kind !== 'pipeline') throw new Error('Expected a pipeline result');

      expect(outcome.result.success).toBe(false);
      expect(outcome.result.summary).toMatchObject({ failed: 1, skipped: 1 });

      const missingState = outcome.result.states.get('main.missing');
      expect(missingState?.status).toBe('failed');
      expect(missingState?.result?.failureKind).toBe('binary_missing');
      expect(missingState?.result?.missingBinary).toBe(missingBinary);

      const missingEvent = finalTaskUpdate(events, 'main.missing');
      expect(missingEvent?.status).toBe('failed');
      expect(missingEvent?.failureKind).toBe('binary_missing');
      expect(missingEvent?.missingBinary).toBe(missingBinary);

      expect(outcome.result.states.get('main.downstream')?.status).toBe('skipped');
      expect(finalTaskUpdate(events, 'main.downstream')?.status).toBe('skipped');
      expect(
        events.some(
          (event) =>
            event.type === 'task_update' &&
            event.taskId === 'main.downstream' &&
            event.status === 'running',
        ),
      ).toBe(false);
      expect(existsSync(downstreamMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails a task with malformed declared JSON output before its downstream task can run', async () => {
    const dir = makeDir();
    const downstreamMarker = join(dir, 'malformed-json-downstream-ran.txt');

    try {
      const events: RunEventPayload[] = [];
      const outcome = await createTagma().runYaml(malformedJsonYaml(downstreamMarker), {
        cwd: dir,
        onEvent: (event) => events.push(event),
      });

      expect(outcome.kind).toBe('pipeline');
      if (outcome.kind !== 'pipeline') throw new Error('Expected a pipeline result');

      expect(outcome.result.success).toBe(false);
      expect(outcome.result.summary).toMatchObject({ failed: 1, skipped: 1 });

      const producerState = outcome.result.states.get('main.producer');
      expect(producerState?.status).toBe('failed');
      expect(producerState?.result?.exitCode).toBe(0);
      expect(producerState?.result?.failureKind).toBe('output_error');
      expect(producerState?.result?.outputs).toBeNull();
      expect(producerState?.result?.stderr).toContain(
        'could not find a final-line JSON object in task output',
      );

      const producerEvent = finalTaskUpdate(events, 'main.producer');
      expect(producerEvent?.status).toBe('failed');
      expect(producerEvent?.failureKind).toBe('output_error');
      expect(producerEvent?.outputs).toBeNull();
      expect(producerEvent?.stderr).toContain(
        'could not find a final-line JSON object in task output',
      );

      expect(outcome.result.states.get('main.downstream')?.status).toBe('skipped');
      expect(finalTaskUpdate(events, 'main.downstream')?.status).toBe('skipped');
      expect(
        events.some(
          (event) =>
            event.type === 'task_update' &&
            event.taskId === 'main.downstream' &&
            event.status === 'running',
        ),
      ).toBe(false);
      expect(existsSync(downstreamMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
