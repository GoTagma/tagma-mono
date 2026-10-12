import { describe, expect, test } from 'bun:test';
import { types } from 'node:util';
import {
  CompileErrorObservationError,
  createCompileErrorObserver,
  formatCompileErrorObservation,
  observeCompileError,
  readCompileErrorObservation,
  type CompileErrorObservation,
  type CompileErrorPhase,
} from '../server/compile-error-observation';
import { isChatOperationFeedback } from '../shared/chat-operation-feedback';

const phases: CompileErrorPhase[] = [
  'stage_compile',
  'managed_layout_read',
  'managed_layout_parse',
  'managed_layout_shape',
  'managed_layout_dependency',
  'managed_layout_write',
];
const systemCodes = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'EIO',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EINVAL',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EXDEV',
];

function withCode(error: Error, code: unknown): Error {
  Object.defineProperty(error, 'code', { value: code, configurable: true });
  return error;
}

function trappedProxy<T extends object>(target: T) {
  const calls: string[] = [];
  const trap = (name: string) => () => {
    calls.push(name);
    throw new Error('Unexpected inspection trap.');
  };
  const handler: ProxyHandler<T> = {
    get: trap('get'),
    set: trap('set'),
    getPrototypeOf: trap('getPrototypeOf'),
    setPrototypeOf: trap('setPrototypeOf'),
    getOwnPropertyDescriptor: trap('getOwnPropertyDescriptor'),
    defineProperty: trap('defineProperty'),
    ownKeys: trap('ownKeys'),
    has: trap('has'),
    isExtensible: trap('isExtensible'),
    preventExtensions: trap('preventExtensions'),
    deleteProperty: trap('deleteProperty'),
    apply: trap('apply'),
    construct: trap('construct'),
  };
  return { value: new Proxy(target, handler), calls };
}

function unknownObservation(phase: CompileErrorPhase = 'stage_compile'): CompileErrorObservation {
  return { phase, errorClass: 'unknown', systemCode: null };
}

describe('compile error observation without exception content', () => {
  test('Bun native guards detect ordinary, proxy and revoked errors without invoking traps', () => {
    expect(typeof types.isProxy).toBe('function');
    expect(typeof types.isNativeError).toBe('function');
    const ordinary = new Error('Private exception text.');
    expect(types.isProxy(ordinary)).toBe(false);
    expect(types.isNativeError(ordinary)).toBe(true);
    const proxy = trappedProxy(ordinary);
    expect(types.isProxy(proxy.value)).toBe(true);
    expect(types.isNativeError(proxy.value)).toBe(false);
    expect(proxy.calls).toEqual([]);
    const revoked = Proxy.revocable(ordinary, {});
    revoked.revoke();
    expect(types.isProxy(revoked.proxy)).toBe(true);
    expect(types.isNativeError(revoked.proxy)).toBe(false);
  });

  test('retains Host phases and current approved native prototype classes in frozen records', () => {
    for (const phase of phases) {
      for (const [ErrorType, errorClass] of [
        [Error, 'Error'],
        [TypeError, 'TypeError'],
        [RangeError, 'RangeError'],
        [SyntaxError, 'SyntaxError'],
      ] as const) {
        const observation = observeCompileError(phase, new ErrorType('Private exception text.'));
        expect(observation).toEqual({ phase, errorClass, systemCode: null });
        expect(Object.isFrozen(observation)).toBe(true);
        expect(Object.keys(observation)).toEqual(['phase', 'errorClass', 'systemCode']);
      }
    }
  });

  test('retains only explicitly allowed own data system codes', () => {
    for (const systemCode of systemCodes) {
      expect(
        observeCompileError('managed_layout_write', withCode(new Error(), systemCode)),
      ).toEqual({
        phase: 'managed_layout_write',
        errorClass: 'Error',
        systemCode,
      });
    }
  });

  test('does not read name, message, stack, path, errno, constructor or code accessors', () => {
    let getterCalls = 0;
    const error = new Error();
    for (const property of ['name', 'message', 'stack', 'path', 'errno', 'constructor', 'code']) {
      Object.defineProperty(error, property, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error('Forbidden error getter.');
        },
      });
    }
    expect(observeCompileError('managed_layout_read', error)).toEqual({
      phase: 'managed_layout_read',
      errorClass: 'Error',
      systemCode: null,
    });
    expect(getterCalls).toBe(0);
  });

  test('rejects unknown, credential-like and object codes without coercing their values', () => {
    let coercionCalls = 0;
    const objectCode = {
      toString() {
        coercionCalls += 1;
        throw new Error('Forbidden coercion.');
      },
    };
    const proxyCode = trappedProxy({});
    for (const code of [
      'CUSTOM_CODE',
      'provider_billing_required',
      'Bearer private-test-token',
      'api_key=private-test-value',
      '/workspace/private/pipeline.yaml',
      'ENOENT-private-test-value',
      2,
      Symbol('private-test-value'),
      objectCode,
      proxyCode.value,
    ]) {
      const observation = observeCompileError('stage_compile', withCode(new Error(), code));
      expect(observation).toEqual({
        phase: 'stage_compile',
        errorClass: 'Error',
        systemCode: null,
      });
      expect(formatCompileErrorObservation(observation)).not.toContain('private-test');
    }
    expect(coercionCalls).toBe(0);
    expect(proxyCode.calls).toEqual([]);
  });

  test('never traverses a custom native-error prototype or inherits its code getter', () => {
    let inheritedCalls = 0;
    class CustomError extends Error {
      get code() {
        inheritedCalls += 1;
        throw new Error('Forbidden inherited getter.');
      }
    }
    for (const error of [new CustomError(), withCode(new CustomError(), 'EACCES')]) {
      expect(types.isNativeError(error)).toBe(true);
      expect(observeCompileError('managed_layout_write', error)).toEqual(
        unknownObservation('managed_layout_write'),
      );
    }
    expect(inheritedCalls).toBe(0);
  });

  test('does not inspect a Proxy returned as the native error prototype', () => {
    const prototype = trappedProxy({});
    const error = Object.setPrototypeOf(new Error(), prototype.value);
    expect(types.isNativeError(error)).toBe(true);
    expect(observeCompileError('managed_layout_parse', error)).toEqual(
      unknownObservation('managed_layout_parse'),
    );
    expect(prototype.calls).toEqual([]);
  });

  test('classifies the current direct prototype without claiming original constructor identity', () => {
    const error = Object.setPrototypeOf(new Error(), TypeError.prototype);
    expect(observeCompileError('stage_compile', error)).toEqual({
      phase: 'stage_compile',
      errorClass: 'TypeError',
      systemCode: null,
    });
  });

  test('rejects error Proxies and revoked Proxies with zero inspection traps', () => {
    const error = trappedProxy(withCode(new Error(), 'EACCES'));
    expect(observeCompileError('managed_layout_write', error.value)).toEqual(
      unknownObservation('managed_layout_write'),
    );
    expect(error.calls).toEqual([]);
    const revoked = Proxy.revocable(new Error(), {});
    revoked.revoke();
    expect(observeCompileError('managed_layout_read', revoked.proxy)).toEqual(
      unknownObservation('managed_layout_read'),
    );
  });

  test('does not reflect on non-native objects, forged errors or primitives', () => {
    let getters = 0;
    const custom = Object.create(null) as object;
    Object.defineProperty(custom, 'code', {
      get() {
        getters += 1;
        throw new Error('Forbidden custom getter.');
      },
    });
    for (const error of [
      custom,
      Object.create(Error.prototype),
      null,
      undefined,
      'private-test-value',
      3,
      4n,
      Symbol('private-test-value'),
      () => undefined,
    ]) {
      expect(observeCompileError('stage_compile', error)).toEqual(unknownObservation());
    }
    expect(getters).toBe(0);
  });

  test('fails conservatively when native guards are absent, fail or return unexpected values', () => {
    const proxy = trappedProxy(new Error());
    const observers = [
      createCompileErrorObserver({}),
      createCompileErrorObserver({ isProxy: types.isProxy }),
      createCompileErrorObserver({ isNativeError: types.isNativeError }),
      createCompileErrorObserver({
        isProxy: () => {
          throw new Error('Unavailable guard.');
        },
        isNativeError: types.isNativeError,
      }),
      createCompileErrorObserver({
        isProxy: () => false,
        isNativeError: () => {
          throw new Error('Unavailable guard.');
        },
      }),
      createCompileErrorObserver({ isProxy: () => undefined, isNativeError: () => true }),
      createCompileErrorObserver({ isProxy: () => false, isNativeError: () => undefined }),
    ];
    for (const observer of observers) {
      expect(observer('managed_layout_read', proxy.value)).toEqual(
        unknownObservation('managed_layout_read'),
      );
    }
    expect(proxy.calls).toEqual([]);
  });

  test('runs the Proxy guard before the native-error guard and never inspects denied errors', () => {
    const calls: string[] = [];
    const observer = createCompileErrorObserver({
      isProxy: () => {
        calls.push('proxy');
        return true;
      },
      isNativeError: () => {
        calls.push('native');
        return true;
      },
    });
    const proxy = trappedProxy(new Error());
    expect(observer('stage_compile', proxy.value)).toEqual(unknownObservation());
    expect(calls).toEqual(['proxy']);
    expect(proxy.calls).toEqual([]);
  });

  test('formats approved observations within the existing path-free, credential-free feedback shape', () => {
    for (const phase of phases) {
      for (const error of [undefined, new SyntaxError(), withCode(new Error(), 'EACCES')]) {
        const details = formatCompileErrorObservation(observeCompileError(phase, error));
        expect(details).toStartWith('Compile setup is unavailable.');
        expect(details).toContain(`Host phase: ${phase}`);
        expect(details.length).toBeLessThan(400);
        expect(
          isChatOperationFeedback({
            schemaVersion: 1,
            stage: 'compile',
            details,
            failedTaskIds: [],
            omittedFailedTaskCount: 0,
          }),
        ).toBe(true);
      }
    }
    expect(formatCompileErrorObservation(observeCompileError('stage_compile'))).toBe(
      'Compile setup is unavailable. Host phase: stage_compile; error class: unknown; system code: unknown.',
    );
  });

  test('does not format forged, getter-bearing or Proxy descriptors', () => {
    let getters = 0;
    const forged = Object.fromEntries(
      ['phase', 'errorClass', 'systemCode'].map((key) => [key, 'private-test-value']),
    );
    const gettersOnly = Object.create(null) as object;
    for (const property of ['phase', 'errorClass', 'systemCode']) {
      Object.defineProperty(gettersOnly, property, {
        get() {
          getters += 1;
          throw new Error('Forbidden descriptor getter.');
        },
      });
    }
    const proxy = trappedProxy(observeCompileError('managed_layout_write', new Error()));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const fallback = formatCompileErrorObservation(observeCompileError('stage_compile'));
    for (const value of [forged, gettersOnly, proxy.value, revoked.proxy]) {
      expect(formatCompileErrorObservation(value as CompileErrorObservation)).toBe(fallback);
    }
    expect(getters).toBe(0);
    expect(proxy.calls).toEqual([]);
  });

  test('carries only branded observations with a fixed message and no enumerable metadata', () => {
    const observation = observeCompileError(
      'managed_layout_write',
      withCode(new Error(), 'EACCES'),
    );
    const error = new CompileErrorObservationError(observation);
    expect(error.message).toBe('Host-managed new-pipeline layout synchronization failed.');
    expect(readCompileErrorObservation(error)).toBe(observation);
    expect(Object.keys(error)).toEqual([]);
    Object.defineProperty(error, 'observation', { value: unknownObservation(), enumerable: true });
    expect(readCompileErrorObservation(error)).toBe(observation);
  });

  test('does not accept forged carriers or inspect carrier proxies, revoked proxies and error getters', () => {
    const observation = observeCompileError('managed_layout_shape');
    const error = new CompileErrorObservationError(observation);
    let getters = 0;
    for (const property of ['name', 'message', 'stack', 'observation']) {
      Object.defineProperty(error, property, {
        configurable: true,
        get() {
          getters += 1;
          throw new Error('Forbidden carrier getter.');
        },
      });
    }
    expect(readCompileErrorObservation(error)).toBe(observation);
    const proxy = trappedProxy(error);
    const revoked = Proxy.revocable(error, {});
    revoked.revoke();
    for (const value of [
      proxy.value,
      revoked.proxy,
      Object.create(CompileErrorObservationError.prototype),
      Object.setPrototypeOf(new Error(), CompileErrorObservationError.prototype),
      { observation },
      null,
      undefined,
      'private-test-value',
    ]) {
      expect(readCompileErrorObservation(value)).toBeNull();
    }
    expect(getters).toBe(0);
    expect(proxy.calls).toEqual([]);
  });

  test('normalizes a forged carrier payload without getters or credential content', () => {
    const proxy = trappedProxy({ phase: 'private-test-value' });
    const error = new CompileErrorObservationError(proxy.value as CompileErrorObservation);
    expect(readCompileErrorObservation(error)).toEqual(unknownObservation());
    expect(proxy.calls).toEqual([]);
  });
});
