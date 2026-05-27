import { expect, test } from 'bun:test';
import { computeTagmaPlacement } from '../server/opencode-placement';

test('placement fixes first task at the default left column', () => {
  const result = computeTagmaPlacement({
    tracks: [{ id: 'main', tasks: [{ id: 'first' }] }],
  });

  expect(result.positions).toEqual({ 'main.first': { x: 20 } });
  expect(result.warnings).toEqual([]);
});

test('placement spaces additional same-track tasks without AI-computed x values', () => {
  const result = computeTagmaPlacement({
    tracks: [
      {
        id: 'main',
        tasks: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
      },
    ],
  });

  expect(result.positions).toEqual({
    'main.first': { x: 20 },
    'main.second': { x: 300 },
    'main.third': { x: 580 },
  });
});

test('placement keeps independent new-track tasks at the first column', () => {
  const result = computeTagmaPlacement({
    tracks: [
      { id: 'prepare', tasks: [{ id: 'install' }] },
      { id: 'review', tasks: [{ id: 'inspect' }] },
    ],
  });

  expect(result.positions).toEqual({
    'prepare.install': { x: 20 },
    'review.inspect': { x: 20 },
  });
  expect(result.warnings).toEqual([]);
});

test('placement pushes cross-track downstream tasks far enough right', () => {
  const result = computeTagmaPlacement({
    tracks: [
      { id: 'build', tasks: [{ id: 'compile' }] },
      { id: 'test', tasks: [{ id: 'run', depends_on: ['build.compile'] }] },
      { id: 'deploy', tasks: [{ id: 'push', depends_on: ['test.run'] }] },
    ],
  });

  expect(result.positions).toEqual({
    'build.compile': { x: 20 },
    'test.run': { x: 360 },
    'deploy.push': { x: 700 },
  });
});

test('placement resolves bare same-track dependency refs before global refs', () => {
  const result = computeTagmaPlacement({
    tracks: [
      { id: 'alpha', tasks: [{ id: 'plan' }, { id: 'review' }] },
      {
        id: 'beta',
        tasks: [{ id: 'plan' }, { id: 'review', depends_on: ['plan'] }],
      },
    ],
  });

  expect(result.positions['beta.review']).toEqual({ x: 300 });
  expect(result.warnings).toEqual([]);
});
