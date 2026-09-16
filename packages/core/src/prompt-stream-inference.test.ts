import { expect, test } from 'bun:test';
import { inferPromptPorts, extractTaskOutputs } from './ports';

test('raw downstream stream references never invent required JSON output keys', () => {
  for (const field of ['stdout', 'stderr', 'normalizedOutput', 'exitCode']) {
    const inferred = inferPromptPorts({
      promptTaskId: 'llm.rewrite-notes',
      upstreams: [],
      downstreams: [
        {
          taskId: 'main.publish',
          inputs: [
            { name: 'notes', type: 'string', from: `llm.rewrite-notes.${field}` },
            { name: 'summary', type: 'string', from: 'llm.rewrite-notes.summary' },
          ],
        },
      ],
    });
    expect(inferred.ports.outputs?.map((port) => port.name)).toEqual(['summary']);
    expect(
      extractTaskOutputs(
        inferred.ports,
        '',
        '{"summary":"Ready","items":[],"breaking":false,"language":"zh"}',
      ).diagnostic,
    ).toBeNull();
  }
});

test('explicit outputs namespace retains stream-shaped JSON keys', () => {
  const inferred = inferPromptPorts({
    promptTaskId: 'llm.rewrite-notes',
    upstreams: [],
    downstreams: [
      {
        taskId: 'main.publish',
        inputs: [
          { name: 'notes', type: 'string', from: 'llm.rewrite-notes.outputs.normalizedOutput' },
        ],
      },
    ],
  });
  expect(inferred.ports.outputs?.map((port) => port.name)).toEqual(['normalizedOutput']);
  expect(extractTaskOutputs(inferred.ports, '', '{"summary":"Ready"}').diagnostic).toContain(
    'missing key "normalizedOutput"',
  );
});
