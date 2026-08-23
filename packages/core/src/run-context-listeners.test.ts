import { expect, test } from 'bun:test';
import { getMaxListeners, setMaxListeners } from 'node:events';

import { configureRunAbortSignalListenerBudget } from './core/run-context';

test('sizes a run-owned abort signal for finite DAG concurrency', () => {
  const controller = new AbortController();
  configureRunAbortSignalListenerBudget(controller.signal, 24);
  expect(getMaxListeners(controller.signal)).toBeGreaterThanOrEqual(28);
});

test('never lowers an explicitly larger listener budget', () => {
  const controller = new AbortController();
  setMaxListeners(100, controller.signal);
  configureRunAbortSignalListenerBudget(controller.signal, 2);
  expect(getMaxListeners(controller.signal)).toBe(100);
});
