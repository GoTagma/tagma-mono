// ═══ Plugin Worker Runtime — Isolation Boundary ═══
//
// ALL four plugin categories (Driver, Trigger, Middleware, Completion) execute
// inside an isolated Bun worker thread, NOT in the editor server's main process.
// This is the single isolation boundary for the plugin system:
//
//   Editor Server (main thread)          Worker Thread (per plugin package)
//   ───────────────────────────          ─────────────────────────────────
//   Express routes                       TagmaPlugin instance
//   RunContext / engine                  Driver / Trigger / Middleware / Completion
//   SSE broadcast                        Plugin-owned state
//        │                                       │
//        └──── postMessage(JSON-RPC) ────────────┘
//
// Each loaded plugin package gets its own worker. Host-side proxy objects
// (proxyDriver, proxyTrigger, proxyMiddleware, proxyCompletion) forward method
// calls over the message channel and deserialize responses.
//
// Timeout: every proxied method call is wrapped with PLUGIN_METHOD_TIMEOUT_MS
// (default 120 s). Trigger watch callbacks use a softer path that does not
// enforce the timeout, because triggers are inherently long-lived.
//
// Why worker isolation:
//   • A plugin crash (OOM, uncaught exception) kills only its worker;
//     the server stays alive and reports the failure.
//   • A plugin hang (stuck API call) is caught by the method timeout.
//   • Plugin code cannot corrupt engine state or read in-memory secrets
//     beyond what the structured context objects carry.
//
// The built-in OpenCode driver (packages/sdk/src/drivers/opencode.ts) runs
// in-process because it ships with the SDK, not as an installable plugin.
// Third-party plugins always go through this worker boundary.

import type {
  CompletionPlugin,
  DriverPlugin,
  DriverResultMeta,
  MiddlewarePlugin,
  PluginCategory,
  PluginSchema,
  PromptDocument,
  SpawnSpec,
  TagmaPlugin,
  TaskConfig,
  TaskResult,
  TrackConfig,
  TriggerPlugin,
  TriggerWatchHandle,
} from '@tagma/types';

interface WorkerCapabilityMeta {
  category: PluginCategory;
  type: string;
  name: string;
  schema?: PluginSchema;
  capabilities?: DriverPlugin['capabilities'];
  methods: string[];
}

interface WorkerLoadPayload {
  pluginName: string;
  capabilities: WorkerCapabilityMeta[];
}

interface WorkerFallbackManifest {
  packageName: string;
  category: PluginCategory;
  type: string;
}

type WorkerResponse =
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: SerializedWorkerError }
  | { kind: 'trigger'; watchId: number; ok: true; value: unknown }
  | { kind: 'trigger'; watchId: number; ok: false; error: SerializedWorkerError };

interface SerializedWorkerError {
  message: string;
  name?: string;
  code?: string;
  stack?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup?: () => void;
}

interface PendingTrigger {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface MutablePluginCapabilities {
  drivers?: Record<string, DriverPlugin>;
  triggers?: Record<string, TriggerPlugin>;
  completions?: Record<string, CompletionPlugin>;
  middlewares?: Record<string, MiddlewarePlugin>;
}

export interface PluginWorkerHandle {
  plugin: TagmaPlugin;
  terminate(): void;
}

export interface PluginWorkerOptions {
  methodTimeoutMs?: number;
  onUnexpectedTerminate?: (error: Error) => void;
}

const PLUGIN_METHOD_TIMEOUT_MS = 120_000;
let nextHostWatchId = 1;

const WORKER_SOURCE = `
let plugin = null;
let nextWatchId = 1;
const watchHandles = new Map();

function serializeError(err) {
  if (!err || typeof err !== 'object') {
    return { message: String(err) };
  }
  const maybe = err;
  return {
    message:
      typeof maybe.message === 'string'
        ? maybe.message
        : Object.prototype.toString.call(maybe),
    ...(typeof maybe.name === 'string' ? { name: maybe.name } : {}),
    ...(typeof maybe.code === 'string' ? { code: maybe.code } : {}),
    ...(typeof maybe.stack === 'string' ? { stack: maybe.stack } : {}),
  };
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(name) {
  return new Proxy({}, {
    get() {
      throw new Error(name + ' is not available inside isolated plugin workers');
    }
  });
}

function makeRuntimeUnavailable() {
  return {
    runSpawn() { throw new Error('runtime.runSpawn is not available inside isolated plugin workers'); },
    runCommand() { throw new Error('runtime.runCommand is not available inside isolated plugin workers'); },
    ensureDir() { throw new Error('runtime.ensureDir is not available inside isolated plugin workers'); },
    fileExists() { throw new Error('runtime.fileExists is not available inside isolated plugin workers'); },
    watch() { throw new Error('runtime.watch is not available inside isolated plugin workers'); },
    logStore: unavailable('runtime.logStore'),
    now() { return new Date(); },
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Sleep aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Sleep aborted'));
        }, { once: true });
      });
    }
  };
}

function handlerFor(category, type) {
  const handler = plugin?.capabilities?.[category]?.[type];
  if (!handler) throw new Error('Plugin capability ' + category + '/' + type + ' is not loaded');
  return handler;
}

// Required handler methods per category. The host-side proxy in worker-runtime.ts
// unconditionally builds these methods regardless of what the real handler
// exposes, so a plugin missing one would silently load and only blow up at
// call time. Validate at load instead.
const REQUIRED_METHODS_BY_CATEGORY = {
  drivers: ['buildCommand'],
  triggers: ['watch'],
  completions: ['check'],
  middlewares: ['enhanceDoc'],
};
const KNOWN_METHODS = ['buildCommand', 'parseResult', 'watch', 'check', 'enhanceDoc'];

function validateDriverCapabilities(type, handler) {
  // Mirror packages/core/src/registry.ts validateContract: a thrown getter on
  // .capabilities must surface here, not at preflight, and each required field
  // has to be a real boolean. Without this the host-side proxy quietly fills
  // in defaults and core's contract validator never sees the bad shape.
  let caps;
  try {
    caps = handler.capabilities;
  } catch (err) {
    throw new Error(
      'Plugin capability drivers/' + type + ' capabilities accessor threw: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (!caps || typeof caps !== 'object') {
    throw new Error('Plugin capability drivers/' + type + ' must declare a capabilities object');
  }
  for (const field of ['sessionResume', 'systemPrompt', 'outputFormat']) {
    if (typeof caps[field] !== 'boolean') {
      throw new Error(
        'Plugin capability drivers/' + type + '.capabilities.' + field +
          ' must be a boolean (got ' + typeof caps[field] + ')'
      );
    }
  }
  if (caps.enforcesPermissions !== undefined && typeof caps.enforcesPermissions !== 'boolean') {
    throw new Error(
      'Plugin capability drivers/' + type +
        '.capabilities.enforcesPermissions must be a boolean or undefined'
    );
  }
  return {
    sessionResume: caps.sessionResume,
    systemPrompt: caps.systemPrompt,
    outputFormat: caps.outputFormat,
    ...(caps.enforcesPermissions !== undefined ? { enforcesPermissions: caps.enforcesPermissions } : {}),
  };
}

function capabilityMetadata(pluginValue) {
  const out = [];
  const categories = ['drivers', 'triggers', 'completions', 'middlewares'];
  for (const category of categories) {
    const handlers = pluginValue.capabilities?.[category];
    if (!isObject(handlers)) continue;
    for (const [type, handler] of Object.entries(handlers)) {
      if (!isObject(handler)) {
        throw new Error('Plugin capability ' + category + '/' + type + ' must be an object');
      }
      // Match core's validateContract: every handler must declare a non-empty
      // name. Synthesizing one from the type would let a malformed plugin slip
      // past core's check via the host-side proxy.
      if (typeof handler.name !== 'string' || handler.name.length === 0) {
        throw new Error(
          'Plugin capability ' + category + '/' + type + ' must declare a non-empty "name"'
        );
      }
      const methods = [];
      for (const method of KNOWN_METHODS) {
        if (typeof handler[method] === 'function') methods.push(method);
      }
      const required = REQUIRED_METHODS_BY_CATEGORY[category] ?? [];
      const missing = required.filter((m) => !methods.includes(m));
      if (missing.length > 0) {
        throw new Error(
          'Plugin capability ' + category + '/' + type +
            ' is missing required method(s): ' + missing.join(', ')
        );
      }
      const driverCaps = category === 'drivers' ? validateDriverCapabilities(type, handler) : undefined;
      out.push({
        category,
        type,
        name: handler.name,
        schema: handler.schema,
        capabilities: driverCaps,
        methods,
      });
    }
  }
  return out;
}

function hasSupportedCapabilityMap(pluginValue) {
  const categories = ['drivers', 'triggers', 'completions', 'middlewares'];
  for (const category of categories) {
    if (isObject(pluginValue.capabilities?.[category])) return true;
  }
  return false;
}

function normalizeLoadedPlugin(loaded, fallbackManifest) {
  if (!isObject(loaded) || typeof loaded.name !== 'string') {
    throw new Error('Plugin must default-export a TagmaPlugin with capabilities maps');
  }
  if (isObject(loaded.capabilities) && hasSupportedCapabilityMap(loaded)) {
    return loaded;
  }
  if (
    fallbackManifest &&
    typeof fallbackManifest.packageName === 'string' &&
    typeof fallbackManifest.category === 'string' &&
    typeof fallbackManifest.type === 'string'
  ) {
    return {
      name: fallbackManifest.packageName,
      capabilities: {
        [fallbackManifest.category]: {
          [fallbackManifest.type]: loaded,
        },
      },
    };
  }
  if (!isObject(loaded.capabilities)) {
    throw new Error('Plugin must default-export a TagmaPlugin with capabilities maps');
  }
  return loaded;
}

async function handleMessage(msg) {
  if (msg.kind === 'load') {
    const mod = await import(msg.fileUrl);
    const loaded = normalizeLoadedPlugin(mod.default, msg.fallbackManifest);
    plugin = loaded;
    return { pluginName: loaded.name, capabilities: capabilityMetadata(loaded) };
  }
  if (msg.kind === 'call') {
    const handler = handlerFor(msg.category, msg.type);
    const fn = handler[msg.method];
    if (typeof fn !== 'function') {
      throw new Error('Plugin capability ' + msg.category + '/' + msg.type + ' has no method ' + msg.method);
    }
    return await fn.apply(handler, msg.args ?? []);
  }
  if (msg.kind === 'watch') {
    const handler = handlerFor('triggers', msg.type);
    if (typeof handler.watch !== 'function') throw new Error('Trigger has no watch() method');
    const controller = new AbortController();
    const watchId = Number.isInteger(msg.watchId) ? msg.watchId : nextWatchId++;
    const ctx = {
      ...(msg.ctx ?? {}),
      signal: controller.signal,
      approvalGateway: unavailable('approvalGateway'),
      runtime: makeRuntimeUnavailable(),
    };
    const handle = handler.watch(msg.config ?? {}, ctx);
    if (!handle || typeof handle !== 'object' || !handle.fired || typeof handle.dispose !== 'function') {
      throw new Error('Trigger returned an invalid watch handle');
    }
    watchHandles.set(watchId, { handle, controller });
    return await Promise.resolve(handle.fired);
  }
  if (msg.kind === 'dispose') {
    const entry = watchHandles.get(msg.watchId);
    if (!entry) return { ok: true };
    watchHandles.delete(msg.watchId);
    entry.controller.abort();
    await entry.handle.dispose(msg.reason ?? 'disposed by host');
    return { ok: true };
  }
  throw new Error('Unknown worker message kind');
}

self.onmessage = (event) => {
  const msg = event.data;
  const replyPort = msg.replyPort;
  const postResponse = (message) => {
    (replyPort ?? self).postMessage(message);
    replyPort?.close?.();
  };
  handleMessage(msg).then(
    (value) => postResponse({ kind: 'response', id: msg.id, ok: true, value }),
    (err) => postResponse({ kind: 'response', id: msg.id, ok: false, error: serializeError(err) })
  );
};
`;

function createPluginWorker(): { worker: Worker; sourceUrl: string } {
  const sourceUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const worker = new Worker(sourceUrl, { type: 'module' });
  return { worker, sourceUrl };
}

interface PluginWorkerError extends Error {
  code?: string;
}

function deserializeWorkerError(payload: SerializedWorkerError): PluginWorkerError {
  const err = new Error(payload.message) as PluginWorkerError;
  if (payload.name) err.name = payload.name;
  if (payload.code) err.code = payload.code;
  if (payload.stack) err.stack = payload.stack;
  return err;
}

export async function loadPluginWorker(
  fileUrl: string,
  timeoutMs: number,
  fallbackManifest?: WorkerFallbackManifest,
  options: PluginWorkerOptions = {},
): Promise<PluginWorkerHandle> {
  const { worker, sourceUrl } = createPluginWorker();
  const pending = new Map<number, PendingRequest>();
  const triggers = new Map<number, PendingTrigger>();
  let nextId = 1;
  let sourceUrlRevoked = false;
  let terminated = false;
  let unexpectedTerminationNotified = false;
  const methodTimeoutMs = options.methodTimeoutMs ?? PLUGIN_METHOD_TIMEOUT_MS;

  const revokeSourceUrl = () => {
    if (sourceUrlRevoked) return;
    URL.revokeObjectURL(sourceUrl);
    sourceUrlRevoked = true;
  };

  const notifyUnexpectedTermination = (error: Error) => {
    if (unexpectedTerminationNotified) return;
    unexpectedTerminationNotified = true;
    options.onUnexpectedTerminate?.(error);
  };

  const terminate = (reason = new Error('Plugin worker terminated'), unexpected = false) => {
    if (terminated) {
      if (unexpected) notifyUnexpectedTermination(reason);
      return;
    }
    terminated = true;
    revokeSourceUrl();
    try {
      worker.terminate();
    } catch {
      /* best-effort */
    }
    for (const request of pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.cleanup?.();
      request.reject(reason);
    }
    pending.clear();
    for (const trigger of triggers.values()) {
      trigger.reject(reason);
    }
    triggers.clear();
    if (unexpected) notifyUnexpectedTermination(reason);
  };

  const request = (
    message: Record<string, unknown>,
    timeout = methodTimeoutMs,
  ): Promise<unknown> => {
    if (terminated) {
      return Promise.reject(new Error('Plugin worker terminated'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              const err = new Error(`Plugin worker call timed out after ${timeout}ms`);
              const entry = pending.get(id);
              pending.delete(id);
              entry?.cleanup?.();
              terminate(err, true);
              reject(err);
            }, timeout)
          : null;
      const replyChannel = new MessageChannel();
      const cleanup = () => {
        try {
          replyChannel.port1.close();
        } catch {
          /* best-effort */
        }
      };
      replyChannel.port1.onmessage = handleWorkerMessage;
      replyChannel.port1.start?.();
      pending.set(id, { resolve, reject, timer, cleanup });
      try {
        worker.postMessage({ ...message, id, replyPort: replyChannel.port2 }, [replyChannel.port2]);
      } catch (err) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  /**
   * Variant of `request` for fire-and-forget calls (currently: trigger
   * dispose). The pending entry is dropped after a finite timeout *without*
   * terminating the worker — for cleanup messages a slow plugin shouldn't
   * cascade into killing the host. Without this bound, dispose with timeout=0
   * would leave a pending entry forever every time a plugin doesn't respond
   * to dispose, which is a slow leak under heavy trigger churn.
   */
  const requestSoft = (message: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    if (terminated) {
      return Promise.reject(new Error('Plugin worker terminated'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const entry = pending.get(id);
              pending.delete(id);
              entry?.cleanup?.();
              reject(new Error(`Plugin worker soft call timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      const replyChannel = new MessageChannel();
      const cleanup = () => {
        try {
          replyChannel.port1.close();
        } catch {
          /* best-effort */
        }
      };
      replyChannel.port1.onmessage = handleWorkerMessage;
      replyChannel.port1.start?.();
      pending.set(id, { resolve, reject, timer, cleanup });
      try {
        worker.postMessage({ ...message, id, replyPort: replyChannel.port2 }, [replyChannel.port2]);
      } catch (err) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  const handleWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    if (msg.kind === 'response') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanup?.();
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(deserializeWorkerError(msg.error));
      return;
    }
    if (msg.kind === 'trigger') {
      const entry = triggers.get(msg.watchId);
      if (!entry) return;
      triggers.delete(msg.watchId);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(deserializeWorkerError(msg.error));
    }
  };
  worker.onmessage = handleWorkerMessage;

  worker.onerror = (event: ErrorEvent) => {
    const err = new Error(event.message);
    terminate(err, true);
  };

  let payload: WorkerLoadPayload;
  try {
    payload = (await request(
      { kind: 'load', fileUrl, fallbackManifest },
      timeoutMs,
    )) as WorkerLoadPayload;
  } catch (err) {
    terminate(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return {
    plugin: buildProxyPlugin(payload, request, requestSoft, triggers),
    terminate: () => terminate(),
  };
}

function buildProxyPlugin(
  payload: WorkerLoadPayload,
  request: (message: Record<string, unknown>, timeout?: number) => Promise<unknown>,
  requestSoft: (message: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
  triggers: Map<number, PendingTrigger>,
): TagmaPlugin {
  const capabilities: MutablePluginCapabilities = {};
  for (const meta of payload.capabilities) {
    if (meta.category === 'drivers') {
      capabilities.drivers ??= {};
      capabilities.drivers[meta.type] = proxyDriver(meta, request);
    } else if (meta.category === 'triggers') {
      capabilities.triggers ??= {};
      capabilities.triggers[meta.type] = proxyTrigger(meta, request, requestSoft, triggers);
    } else if (meta.category === 'completions') {
      capabilities.completions ??= {};
      capabilities.completions[meta.type] = proxyCompletion(meta, request);
    } else if (meta.category === 'middlewares') {
      capabilities.middlewares ??= {};
      capabilities.middlewares[meta.type] = proxyMiddleware(meta, request);
    }
  }
  return { name: payload.pluginName, capabilities };
}

function proxyDriver(
  meta: WorkerCapabilityMeta,
  request: (message: Record<string, unknown>, timeout?: number) => Promise<unknown>,
): DriverPlugin {
  if (!meta.capabilities) {
    // capabilityMetadata() validates and forwards the real driver capability
    // booleans, so this should never fire — but if a future change lets meta
    // arrive without them, fail loudly instead of papering over with defaults
    // that would silently disable sessionResume / systemPrompt / outputFormat.
    throw new Error(`Plugin capability drivers/${meta.type} arrived without capabilities`);
  }
  const driver: DriverPlugin = {
    name: meta.name,
    capabilities: meta.capabilities,
    async buildCommand(task: TaskConfig, track: TrackConfig, ctx): Promise<SpawnSpec> {
      return (await request({
        kind: 'call',
        category: 'drivers',
        type: meta.type,
        method: 'buildCommand',
        args: [
          task,
          track,
          {
            sessionMap: ctx.sessionMap,
            normalizedMap: ctx.normalizedMap,
            workDir: ctx.workDir,
            promptDoc: ctx.promptDoc,
            inputs: ctx.inputs,
          },
        ],
      })) as SpawnSpec;
    },
  };
  if (meta.methods.includes('parseResult')) {
    driver.parseResult = async (stdout: string, stderr?: string): Promise<DriverResultMeta> =>
      (await request({
        kind: 'call',
        category: 'drivers',
        type: meta.type,
        method: 'parseResult',
        args: [stdout, stderr],
      })) as DriverResultMeta;
  }
  return driver;
}

// Bound how long the host waits for the worker to ack a trigger dispose.
// Long enough for a reasonable cleanup, short enough that a stuck plugin
// doesn't accumulate zombie pending entries on every disposed trigger.
const TRIGGER_DISPOSE_TIMEOUT_MS = 30_000;

function proxyTrigger(
  meta: WorkerCapabilityMeta,
  request: (message: Record<string, unknown>, timeout?: number) => Promise<unknown>,
  requestSoft: (message: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
  _triggers: Map<number, PendingTrigger>,
): TriggerPlugin {
  return {
    name: meta.name,
    schema: meta.schema,
    watch(config, ctx): TriggerWatchHandle {
      const watchId = nextHostWatchId++;
      const fired = request(
        {
          kind: 'watch',
          watchId,
          type: meta.type,
          config,
          ctx: {
            taskId: ctx.taskId,
            trackId: ctx.trackId,
            workDir: ctx.workDir,
          },
        },
        0,
      );
      return {
        fired,
        dispose(reason?: string) {
          // Soft-request: the pending entry self-evicts after a finite
          // timeout instead of leaking when a stuck plugin never acks.
          // A timed-out dispose does NOT terminate the worker — other
          // capabilities of the same plugin should keep working.
          void requestSoft({ kind: 'dispose', watchId, reason }, TRIGGER_DISPOSE_TIMEOUT_MS).catch(
            () => {
              /* best-effort */
            },
          );
        },
      };
    },
  };
}

function proxyCompletion(
  meta: WorkerCapabilityMeta,
  request: (message: Record<string, unknown>, timeout?: number) => Promise<unknown>,
): CompletionPlugin {
  return {
    name: meta.name,
    schema: meta.schema,
    async check(config: Record<string, unknown>, result: TaskResult, ctx): Promise<boolean> {
      return (await request({
        kind: 'call',
        category: 'completions',
        type: meta.type,
        method: 'check',
        args: [
          config,
          result,
          {
            workDir: ctx.workDir,
            envPolicy: ctx.envPolicy,
          },
        ],
      })) as boolean;
    },
  };
}

function proxyMiddleware(
  meta: WorkerCapabilityMeta,
  request: (message: Record<string, unknown>, timeout?: number) => Promise<unknown>,
): MiddlewarePlugin {
  return {
    name: meta.name,
    schema: meta.schema,
    async enhanceDoc(
      doc: PromptDocument,
      config: Record<string, unknown>,
      ctx,
    ): Promise<PromptDocument> {
      return (await request({
        kind: 'call',
        category: 'middlewares',
        type: meta.type,
        method: 'enhanceDoc',
        args: [
          doc,
          config,
          {
            task: ctx.task,
            track: ctx.track,
            workDir: ctx.workDir,
          },
        ],
      })) as PromptDocument;
    },
  };
}
