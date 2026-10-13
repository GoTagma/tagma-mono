import { test, expect } from 'bun:test';
import { finalizeOwnedResources } from './owned-harness-finalization.mjs';

function ownedFixture({ usageFault = false, monitorFault = false, closeFault = false } = {}) {
  const calls = [],
    primaryError = Object.assign(new Error('original_case_failure'), {
      code: 'original_case_failure',
    });
  let stopReceipt = null,
    usageProof = null,
    processClosure = null;
  const commands = {
    stopPolling: false,
    background: [
      {
        get promise() {
          calls.push('background');
          return Promise.resolve();
        },
      },
    ],
  };
  const writer = {
    async event() {
      calls.push('evidence');
      throw Object.assign(new Error('no_space'), { code: 'ENOSPC' });
    },
  };
  const session = {
    async close() {
      calls.push('close');
      if (closeFault)
        throw Object.assign(new Error('closure_receipt_write_failed'), { code: 'ENOSPC' });
      processClosure = {
        registeredOwnedScopeInactive: true,
        cleanupFaults: [],
        cdpConnectionState: 'disconnected',
      };
    },
  };
  const steps = [
    {
      name: 'settle_current_operation',
      async run() {
        calls.push('settle');
        stopReceipt = { settled: usageFault, state: { synthetic: true } };
      },
    },
    {
      name: 'observe_current_usage',
      async run() {
        if (stopReceipt.settled !== true) return;
        calls.push('usage');
        if (usageFault) {
          try {
            throw Object.assign(new Error('usage_unavailable'), {
              code: 'synthetic_usage_read_failed',
            });
          } catch (error) {
            await writer.event('current_keyed_usage_observation_failed', { code: error.code });
          }
        }
      },
    },
    {
      name: 'drain_monitors',
      async run() {
        calls.push('monitor');
        if (monitorFault) {
          try {
            throw Object.assign(new Error('monitor_unavailable'), {
              code: 'synthetic_monitor_read_failed',
            });
          } catch (error) {
            await writer.event('final_monitor_drain_failed', { code: error.code });
          }
        }
      },
    },
    {
      name: 'close_registered_native_scope',
      async run() {
        try {
          await session.close();
        } catch (error) {
          processClosure = {
            registeredOwnedScopeInactive: 'UNKNOWN',
            cleanupFaults: [{ code: error.code }],
          };
          throw error;
        }
      },
    },
    {
      name: 'drain_command_background',
      async run() {
        commands.stopPolling = true;
        await Promise.all(commands.background.map((item) => item.promise));
      },
    },
    {
      name: 'forget_control_credential',
      run() {
        calls.push('forget-control');
      },
    },
    {
      name: 'forget_diagnostics_credential',
      run() {
        calls.push('forget-diagnostics');
      },
    },
  ];
  return {
    calls,
    primaryError,
    steps,
    commands,
    facts: () => ({ stopReceipt, usageProof, processClosure }),
  };
}

test('owned finalization closes exact resources after monitor evidence ENOSPC', async () => {
  const healthy = ownedFixture();
  const ordinary = await finalizeOwnedResources(healthy);
  expect(healthy.calls).toEqual([
    'settle',
    'monitor',
    'close',
    'background',
    'forget-control',
    'forget-diagnostics',
  ]);
  expect(ordinary.faults).toHaveLength(0);
  expect(healthy.commands.stopPolling).toBe(true);
  expect(healthy.facts().stopReceipt.settled).toBe(false);
  expect(healthy.facts().usageProof).toBe(null);
  const fault = ownedFixture({ monitorFault: true });
  const result = await finalizeOwnedResources(fault);
  expect(fault.calls.slice(0, 3)).toEqual(['settle', 'monitor', 'evidence']);
  expect(fault.calls.filter((value) => value === 'close')).toHaveLength(1);
  expect(fault.calls.filter((value) => value === 'background')).toHaveLength(1);
  expect(fault.calls.filter((value) => value === 'forget-control')).toHaveLength(1);
  expect(fault.calls.filter((value) => value === 'forget-diagnostics')).toHaveLength(1);
  expect(fault.facts().stopReceipt.settled).toBe(false);
  expect(fault.facts().usageProof).toBe(null);
  expect(result.primaryError).toBe(fault.primaryError);
  expect(result.faults).toEqual([{ step: 'drain_monitors', code: 'ENOSPC', type: 'Error' }]);
});

test('owned finalization continues after usage evidence ENOSPC', async () => {
  const x = ownedFixture({ usageFault: true });
  const result = await finalizeOwnedResources(x);
  expect(x.calls).toEqual([
    'settle',
    'usage',
    'evidence',
    'monitor',
    'close',
    'background',
    'forget-control',
    'forget-diagnostics',
  ]);
  expect(x.facts().usageProof).toBe(null);
  expect(x.facts().stopReceipt.settled).toBe(true);
  expect(result.primaryError).toBe(x.primaryError);
  expect(result.faults).toEqual([{ step: 'observe_current_usage', code: 'ENOSPC', type: 'Error' }]);
  expect(result.stepResults).toHaveLength(7);
});

test('owned finalization preserves primary error and surfaces independent cleanup errors', async () => {
  const primaryError = Object.assign(new Error('original_failure'), { code: 'original_failure' });
  const calls = [],
    one = Object.assign(new Error('cleanup_one'), { code: 'ENOSPC' }),
    two = Object.assign(new Error('cleanup_two'), { code: 'ETIMEDOUT' });
  const result = await finalizeOwnedResources({
    primaryError,
    steps: [
      {
        name: 'first_cleanup',
        run() {
          calls.push('first');
          throw one;
        },
      },
      {
        name: 'second_cleanup',
        async run() {
          calls.push('second');
          throw two;
        },
      },
      {
        name: 'last_cleanup',
        run() {
          calls.push('last');
        },
      },
    ],
  });
  expect(calls).toEqual(['first', 'second', 'last']);
  expect(result.primaryError).toBe(primaryError);
  expect(primaryError.code).toBe('original_failure');
  expect(result.faults.map((x) => x.code)).toEqual(['ENOSPC', 'ETIMEDOUT']);
  expect(result.stepResults.map((x) => x.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
});

test('owned finalization does not manufacture settlement ownership or matrix closure', async () => {
  const primaryError = new Error('report_persistence_failed');
  const result = await finalizeOwnedResources({
    primaryError,
    steps: [
      {
        name: 'untrusted_callback_return',
        run() {
          return {
            paidScopeKnownSettled: true,
            processKnownClosed: true,
            originalInventoryComplete: true,
            allPassed: true,
            secret: 'not_a_proof',
          };
        },
      },
    ],
  });
  expect(result.primaryError).toBe(primaryError);
  expect(result.stepResults).toEqual([{ step: 'untrusted_callback_return', status: 'fulfilled' }]);
  for (const name of [
    'paidScopeKnownSettled',
    'processKnownClosed',
    'originalInventoryComplete',
    'allPassed',
    'secret',
  ])
    expect(Object.hasOwn(result, name)).toBe(false);
  expect(JSON.stringify(result)).not.toContain('not_a_proof');
});

test('owned finalization freezes its finite step plan and executes each hook once', async () => {
  const calls = [],
    steps = [
      {
        name: 'first_cleanup',
        run() {
          calls.push('first');
          steps[1].run = () => calls.push('foreign');
          steps.push({
            name: 'injected_cleanup',
            run() {
              calls.push('injected');
            },
          });
        },
      },
      {
        name: 'second_cleanup',
        run() {
          calls.push('second');
        },
      },
    ];
  const result = await finalizeOwnedResources({ steps });
  expect(calls).toEqual(['first', 'second']);
  expect(result.stepResults).toHaveLength(2);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.faults)).toBe(true);
  expect(Object.isFrozen(result.stepResults)).toBe(true);
  let nameReads = 0,
    runReads = 0;
  const chosen = [];
  const changing = Object.defineProperties(
    {},
    {
      name: {
        get() {
          nameReads++;
          return nameReads <= 3 ? 'bound_cleanup' : '/private/path';
        },
      },
      run: {
        get() {
          runReads++;
          return runReads === 1 ? () => chosen.push('owned') : () => chosen.push('foreign');
        },
      },
    },
  );
  const single = await finalizeOwnedResources({ steps: [changing] });
  expect(chosen).toEqual(['owned']);
  expect(single.stepResults).toEqual([{ step: 'bound_cleanup', status: 'fulfilled' }]);
  expect(nameReads).toBe(1);
  expect(runReads).toBe(1);
  expect(JSON.stringify(single)).not.toContain('private');
  let self, changed;
  const mutation = await finalizeOwnedResources({
    steps: [
      {
        name: 'self_cleanup',
        run() {
          self = this;
          changed = Reflect.set(this, 'name', '/private/path');
        },
      },
    ],
  });
  expect(mutation.stepResults).toEqual([{ step: 'self_cleanup', status: 'fulfilled' }]);
  expect(changed).toBe(false);
  expect(Object.isFrozen(self)).toBe(true);
  expect(JSON.stringify(mutation)).not.toContain('private');
});

test('owned finalization bounds fault projections without retaining thrown prose', async () => {
  const strange = Object.defineProperties(
    {},
    {
      code: {
        get() {
          throw new Error('private_code');
        },
      },
      name: {
        get() {
          throw new Error('private_name');
        },
      },
      message: { value: 'private_message' },
    },
  );
  const errors = [
    strange,
    { code: 'path/with/private/value', name: 'Raw Provider Text', message: 'private_message' },
    Symbol('private_symbol'),
  ];
  const calls = [],
    result = await finalizeOwnedResources({
      steps: errors.map((value, i) => ({
        name: `cleanup_${i}`,
        run() {
          calls.push(i);
          throw value;
        },
      })),
    });
  expect(calls).toEqual([0, 1, 2]);
  expect(result.faults).toHaveLength(3);
  expect(
    result.faults.every((x) => x.code === 'finalization_step_failed' && x.type === 'UnknownError'),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private');
  let codeReads = 0,
    nameReads = 0;
  const changing = Object.defineProperties(
    {},
    {
      code: {
        get() {
          codeReads++;
          return codeReads <= 2 ? 'ENOSPC' : 'private code after validation';
        },
      },
      name: {
        get() {
          nameReads++;
          return nameReads <= 2 ? 'Error' : 'private type after validation';
        },
      },
    },
  );
  const single = await finalizeOwnedResources({
    steps: [
      {
        name: 'changing_error',
        run() {
          throw changing;
        },
      },
    ],
  });
  expect(single.faults).toEqual([{ step: 'changing_error', code: 'ENOSPC', type: 'Error' }]);
  expect(codeReads).toBe(1);
  expect(nameReads).toBe(1);
  expect(JSON.stringify(single)).not.toContain('private');
});

test('owned finalization rejects malformed duplicate or unbounded plans before hooks execute', async () => {
  let calls = 0;
  const step = (name) => ({
    name,
    run() {
      calls++;
    },
  });
  for (const steps of [
    null,
    [],
    [step('valid'), step('valid')],
    [step('private/path')],
    [{ name: 'valid', run: true }],
    Array.from({ length: 17 }, (_, i) => step(`cleanup_${i}`)),
  ]) {
    let error;
    try {
      await finalizeOwnedResources({ steps });
    } catch (value) {
      error = value;
    }
    expect(error?.code).toBe('owned_finalization_steps_invalid');
    expect(calls).toBe(0);
  }
});

test('owned finalization preserves explicit cleanup UNKNOWN and continues credential teardown', async () => {
  const x = ownedFixture({ closeFault: true });
  const result = await finalizeOwnedResources(x);
  expect(x.facts().processClosure.registeredOwnedScopeInactive).toBe('UNKNOWN');
  expect(x.facts().stopReceipt.settled).toBe(false);
  expect(x.facts().usageProof).toBe(null);
  expect(x.calls.slice(-3)).toEqual(['background', 'forget-control', 'forget-diagnostics']);
  expect(result.faults).toEqual([
    { step: 'close_registered_native_scope', code: 'ENOSPC', type: 'Error' },
  ]);
  expect(result.primaryError).toBe(x.primaryError);
});
