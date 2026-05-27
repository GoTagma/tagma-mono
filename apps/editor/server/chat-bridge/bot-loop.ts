/**
 * Bot-bridge runtime — transport-generic.
 *
 * Owns the observable status state machine, the in-flight start guard, and
 * the periodic reachability heartbeat. Platform plumbing is delegated to a
 * `ChatTransport` (transports/*.ts) and the orchestration to the conductor
 * (conductor.ts). This file constructs the transport for the active platform;
 * everything else here is platform-agnostic.
 *
 * Exported names (`startTelegramBot`, `stopTelegramBot`, `snapshotStatus`,
 * `isBotRunning`) are kept stable because index.ts and routes/chat-bridge.ts
 * import them — they're now slight misnomers (the bridge is no longer
 * Telegram-only) but renaming would ripple without behavior change.
 */

import { pendingCount } from './pair-code.js';
import { attachConductor, notifyOffline } from './conductor.js';
import { createTransport, resolveActivePlatform } from './transports/factory.js';
import type { ChatTransport } from './transports/types.js';
import { botPlatformSwitchLocked } from './platform-switch-lock.js';

const HEALTH_PROBE_INTERVAL_MS = 30_000;

/**
 * Observable runtime state. The UI polls `/api/chat-bridge/status` which
 * snapshots this. Stages:
 *   - `disabled`   : no token configured or manually disconnected.
 *   - `connecting` : transport.start() in flight (first round-trip).
 *   - `connected`  : start succeeded + most recent heartbeat ok.
 *   - `error`      : last start or heartbeat failed; status retains lastError.
 */
export type BotStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export interface BotStatusSnapshot {
  status: BotStatus;
  username: string | null;
  startedAt: number | null;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  pendingPairs: number;
}

interface RunningBridge {
  transport: ChatTransport;
  startedAt: number;
  healthTimer: ReturnType<typeof setInterval> | null;
}

let running: RunningBridge | null = null;
let status: BotStatus = 'disabled';
let username: string | null = null;
let lastCheckAt: number | null = null;
let lastSuccessAt: number | null = null;
let lastError: string | null = null;
let lastErrorAt: number | null = null;

function setStatus(next: BotStatus): void {
  if (status !== next) {
    console.log(`[bot-bridge] status: ${status} → ${next}`);
  }
  status = next;
}

function recordError(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err);
  lastErrorAt = Date.now();
}

export function snapshotStatus(): BotStatusSnapshot {
  return {
    status,
    username,
    startedAt: running?.startedAt ?? null,
    lastCheckAt,
    lastSuccessAt,
    lastError,
    lastErrorAt,
    pendingPairs: pendingCount(),
  };
}

async function probeHealth(transport: ChatTransport): Promise<void> {
  const startedForRun = running;
  if (!startedForRun || startedForRun.transport !== transport) return;
  const checkAt = Date.now();
  const result = await transport.probe();
  // stop() (or a stop+restart) can land while probe() is in flight. A stale
  // probe must not resurrect a torn-down bridge's status or flip a freshly
  // restarted transport's state — bail unless we're still the live run.
  if (running !== startedForRun) return;
  lastCheckAt = checkAt;
  if (result.ok) {
    username = result.username;
    lastSuccessAt = lastCheckAt;
    setStatus('connected');
  } else {
    recordError(new Error(result.error ?? 'heartbeat failed'));
    setStatus('error');
  }
}

// In-flight start guard. `running` is only set AFTER transport.start()
// resolves (~up to 15 s on a slow/unreachable platform), so a second caller
// during that window — e.g. the boot-path auto-start racing a manual POST
// /connect — would otherwise spin up a parallel transport that fights the
// first. Collapse concurrent starts onto one promise.
let startInFlight: Promise<void> | null = null;
// Set when stopTelegramBot() is called while a start is still in flight
// (`running` is null until start fully resolves, ~up to 15 s). Without this a
// Disconnect during the connecting window is a no-op and the bridge comes
// online anyway. startBridgeInner() checks this just before going live and
// tears the freshly-built transport back down instead.
let stopRequestedDuringStart = false;

export function startTelegramBot(token: string): Promise<void> {
  if (running) {
    console.warn('[bot-bridge] already running, ignoring start()');
    return Promise.resolve();
  }
  if (startInFlight) {
    console.warn('[bot-bridge] start already in progress, joining it');
    return startInFlight;
  }
  stopRequestedDuringStart = false;
  startInFlight = startBridgeInner(token).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}

async function startBridgeInner(token: string): Promise<void> {
  setStatus('connecting');
  let transport: ChatTransport;
  try {
    transport = await createTransport(resolveActivePlatform());
    attachConductor(transport);
  } catch (err) {
    // Adapter construction can fail (corrupt platform-selection file, a
    // missing/broken transport dependency, module-load error). Surface it as
    // 'error' with a recorded cause — otherwise the UI badge stays stuck on
    // 'connecting' forever with no hint why.
    recordError(err);
    setStatus('error');
    throw err;
  }
  // The transport bounds its own connect with a 15 s ceiling and surfaces a
  // friendly "unreachable" message, so we pass a never-aborted signal and
  // let that single ceiling be the source of truth.
  const neverAbort = new AbortController().signal;
  try {
    await transport.start(token, neverAbort);
  } catch (err) {
    recordError(err);
    setStatus('error');
    throw err;
  }
  // Confirm reachability + learn the bot handle via one probe before we flip
  // to 'connected' (start() resolved, but probe also yields the username).
  const probe = await transport.probe();
  if (probe.ok) {
    username = probe.username;
    lastSuccessAt = Date.now();
    lastCheckAt = lastSuccessAt;
    setStatus('connected');
    console.log(`[bot-bridge] ${transport.platform} @${username ?? '<unknown>'} connected`);
  } else {
    // start() said up but the immediate probe failed — surface it; the
    // periodic heartbeat will recover if it's transient.
    recordError(new Error(probe.error ?? 'post-start probe failed'));
    setStatus('error');
  }
  if (stopRequestedDuringStart) {
    // A Disconnect landed while we were connecting — honor it: tear the
    // transport back down instead of going live, and stay disabled.
    stopRequestedDuringStart = false;
    setStatus('disabled');
    username = null;
    try {
      await transport.stop();
    } catch (err) {
      console.warn('[bot-bridge] transport.stop() during aborted start error:', err);
    }
    return;
  }
  const healthTimer = setInterval(() => {
    void probeHealth(transport);
  }, HEALTH_PROBE_INTERVAL_MS);
  (healthTimer as unknown as { unref?: () => void }).unref?.();
  running = { transport, startedAt: Date.now(), healthTimer };
}

export async function stopTelegramBot(reason: string): Promise<void> {
  if (!running) {
    if (startInFlight) {
      // A connect is mid-flight: flag it so startBridgeInner tears the
      // freshly-built transport down instead of going live, then wait the
      // bounded start out so we return only once it's actually settled.
      stopRequestedDuringStart = true;
      try {
        await startInFlight;
      } catch {
        /* start failed on its own; nothing was brought online to tear down */
      }
    }
    setStatus('disabled');
    return;
  }
  const { transport, healthTimer } = running;
  running = null;
  if (healthTimer) clearInterval(healthTimer);
  setStatus('disabled');
  username = null;
  // Best-effort offline notice before tearing the transport down. Never let
  // a slow platform API hang shutdown indefinitely.
  try {
    await Promise.race([notifyOffline(transport, reason), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    /* best-effort */
  }
  try {
    await transport.stop();
  } catch (err) {
    console.warn('[bot-bridge] transport.stop() error:', err);
  }
}

export function isBotRunning(): boolean {
  return running !== null;
}

export function isBotSwitchLocked(): boolean {
  return botPlatformSwitchLocked({
    running: running !== null,
    startInFlight: startInFlight !== null,
  });
}
