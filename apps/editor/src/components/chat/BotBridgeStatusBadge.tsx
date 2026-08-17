/**
 * Compact bot-bridge connection indicator + pairing entry point.
 *
 * Lives in the ChatPanel header (between the model picker and the action
 * buttons). Three states drive color:
 *   - dimmed/grey : feature disabled (no env flag) — clicking does nothing
 *   - warning     : connecting OR the last getMe heartbeat failed
 *   - success     : connected and last heartbeat succeeded
 *
 * Click opens a tiny popover with the @username, last-success timestamp,
 * any last error, and a "Generate pair code" button. The code is shown
 * inline once minted and disappears on close — it expires in 120 s anyway.
 *
 * The popover does NOT touch chat-store state — it's a pure side channel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import {
  approveSlackBind,
  armSlackBind,
  authorizeBotSender,
  clearBotToken,
  connectBotBridge,
  createBotPairCode,
  denySlackBind,
  disconnectBotBridge,
  fetchBridgeManifest,
  fetchBotBridgeStatus,
  fetchSlackBindRequests,
  revokeBotSender,
  setBotPlatform,
  setBotToken,
  type AllowlistEntryDTO,
  type BotPlatform,
  type BotStatus,
  type BotStatusSnapshot,
  type BridgeManifest,
  type SlackBindRequestDTO,
} from '../../api/chat-bridge';
import { FloatingPanel } from './FloatingPanel';
import {
  PLATFORM_LABELS,
  buildBotPlatformPickerState,
  buildSlackTokenSubmission,
  shouldApplyBotBridgeStatusPoll,
} from './bot-bridge-status-logic';
import {
  getCachedBotBridgeStatus,
  markBotBridgeUnreachable,
  setCachedBotBridgeStatus,
} from './bot-bridge-status-cache';

const POLL_INTERVAL_MS = 5_000;

function colorForStatus(status: BotStatus): string {
  switch (status) {
    case 'connected':
      return 'text-tagma-success';
    case 'connecting':
      return 'text-tagma-warning';
    case 'error':
      return 'text-tagma-error';
    case 'disabled':
    default:
      return 'text-tagma-muted';
  }
}

function labelForStatus(snapshot: BotStatusSnapshot | null): string {
  if (!snapshot) return 'Bot bridge: status unavailable';
  switch (snapshot.status) {
    case 'connected':
      return `Bot bridge: connected (@${snapshot.username ?? 'bot'})`;
    case 'connecting':
      return 'Bot bridge: connecting...';
    case 'error':
      return `Bot bridge: error - ${snapshot.lastError ?? 'unknown'}`;
    case 'disabled':
    default:
      if (snapshot.tokenSource === 'none') {
        return 'Bot bridge: set a bot token below';
      }
      return 'Bot bridge: disconnected - press Connect';
  }
}

function formatRelative(ts: number | null): string {
  if (ts == null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function allowedSenderLabel(entry: AllowlistEntryDTO): string {
  return entry.label ? `${entry.label} (${entry.fromId})` : entry.fromId;
}

function allowedSenderSourceLabel(entry: AllowlistEntryDTO): string {
  switch (entry.source) {
    case 'manual':
      return 'manual';
    case 'slack-bind':
      return 'slack';
    case 'pair':
    default:
      return 'paired';
  }
}

export function BotBridgeStatusBadge() {
  // Seed from the module-level cache, not null: closing the chat tab unmounts
  // this badge (RightDock mounts only the active tab), so without this the
  // remount would flash a false 'disabled' even though the sidecar bridge
  // never dropped.
  const [snapshot, setSnapshot] = useState<BotStatusSnapshot | null>(
    () => getCachedBotBridgeStatus().snapshot,
  );
  const [open, setOpen] = useState(false);
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null);
  // Slack: no relayed /pair code. Arm from here, then approve the inbound
  // request in this trusted panel (Module 3).
  const [slackArmedUntil, setSlackArmedUntil] = useState<number | null>(null);
  const [slackBindRequests, setSlackBindRequests] = useState<SlackBindRequestDTO[]>([]);
  const [slackBindBusy, setSlackBindBusy] = useState(false);
  const [slackBindError, setSlackBindError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<BridgeManifest | null>(null);
  const [allowSenderId, setAllowSenderId] = useState('');
  const [allowSenderLabel, setAllowSenderLabel] = useState('');
  const [allowlistBusy, setAllowlistBusy] = useState(false);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  // Slack is configured its own way: two tokens, not one (App-Level xapp- +
  // Bot xoxb-). Kept separate from the single-field `tokenInput` so each
  // platform's form stays independent.
  const [slackAppToken, setSlackAppToken] = useState('');
  const [slackBotToken, setSlackBotToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenEditing, setTokenEditing] = useState(false);
  const [platformBusy, setPlatformBusy] = useState(false);
  const [pendingPlatform, setPendingPlatform] = useState<BotPlatform | null>(null);
  const [settlingPlatform, setSettlingPlatformState] = useState<BotPlatform | null>(null);
  const [platformError, setPlatformError] = useState<string | null>(null);
  const platformSwitchInFlightRef = useRef(false);
  const settlingPlatformRef = useRef<BotPlatform | null>(null);
  const statusPollEpochRef = useRef(0);
  const activeManualStatusUpdatesRef = useRef(0);
  // False when the last status poll failed (sidecar restarting / down). We
  // keep the last snapshot so the UI doesn't visually revert the user's
  // provider/token selection on a transient blip.
  const [reachable, setReachable] = useState(() => getCachedBotBridgeStatus().reachable);
  // FloatingPanel anchors off this element and portals the popover to
  // document.body, so it renders above the chat panel's overflow-hidden
  // ancestors instead of being clipped inside the chat column.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const beginManualStatusUpdate = useCallback(() => {
    activeManualStatusUpdatesRef.current += 1;
    statusPollEpochRef.current += 1;
  }, []);

  const endManualStatusUpdate = useCallback(() => {
    statusPollEpochRef.current += 1;
    activeManualStatusUpdatesRef.current = Math.max(0, activeManualStatusUpdatesRef.current - 1);
  }, []);

  const setSettlingPlatform = useCallback((platform: BotPlatform | null) => {
    settlingPlatformRef.current = platform;
    setSettlingPlatformState(platform);
  }, []);

  const applyStatusEndpointSnapshot = useCallback(
    (next: BotStatusSnapshot) => {
      setSnapshot(next);
      setReachable(true);
      // Persist outside the component so a chat-panel close/reopen shows the
      // true status immediately instead of a false 'disabled'.
      setCachedBotBridgeStatus(next);
      if (settlingPlatformRef.current === next.platform) {
        setSettlingPlatform(null);
      }
    },
    [setSettlingPlatform],
  );

  // Poll every 5 s while the tab is visible — cheap probe; the bot itself
  // heartbeats Telegram every 30 s so the UI lags at worst a few seconds
  // behind the real state. Hidden-tab ticks are skipped, and returning to
  // visible fires one immediate catch-up tick.
  //
  // On a failed poll we KEEP the last known snapshot instead of nulling it.
  // The sidecar can briefly disappear (a `bun --watch` restart, a crash) and
  // a null here used to make the provider dropdown + token state visually
  // snap back to the 'telegram' fallback — which read as "my Slack selection
  // reverted on its own". Preserve the selection; only flag unreachability.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const startedEpoch = statusPollEpochRef.current;
      const s = await fetchBotBridgeStatus();
      if (!alive) return;
      if (
        !shouldApplyBotBridgeStatusPoll({
          startedEpoch,
          currentEpoch: statusPollEpochRef.current,
          activeManualUpdates: activeManualStatusUpdatesRef.current,
        })
      ) {
        return;
      }
      if (s) {
        applyStatusEndpointSnapshot(s);
      } else {
        setReachable(false);
        markBotBridgeUnreachable();
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [applyStatusEndpointSnapshot]);

  // Outside-click / Escape / anchor-move dismissal is handled by FloatingPanel
  // (it owns the portal'd DOM, so a contains() check here couldn't see it).

  // Expire the displayed pair code when its 120 s lifetime is up.
  useEffect(() => {
    if (!pairCode) return;
    const remaining = pairCode.expiresAt - Date.now();
    if (remaining <= 0) {
      setPairCode(null);
      return;
    }
    const id = window.setTimeout(() => setPairCode(null), remaining);
    return () => window.clearTimeout(id);
  }, [pairCode]);

  const status = snapshot?.status ?? 'disabled';
  const color = colorForStatus(status);
  const configPlatform = buildBotPlatformPickerState(snapshot, {
    pendingPlatform,
    platformBusy,
    settlingPlatform,
  }).current;
  const isSlack = configPlatform === 'slack';
  const allowedSenders =
    manifest?.allowlist.filter((entry) => entry.platform === configPlatform) ?? [];
  const manualRestrictionEnabled = allowedSenders.some((entry) => entry.source === 'manual');

  const handleGenerate = useCallback(async () => {
    setPairing(true);
    setPairError(null);
    try {
      const result = await createBotPairCode();
      setPairCode({ code: result.code, expiresAt: result.expiresAt });
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairing(false);
    }
  }, []);

  const refreshManifest = useCallback(async () => {
    try {
      setManifest(await fetchBridgeManifest());
      setAllowlistError(null);
    } catch (err) {
      setAllowlistError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    beginManualStatusUpdate();
    try {
      const s = await fetchBotBridgeStatus();
      if (s) {
        applyStatusEndpointSnapshot(s);
      } else {
        setReachable(false);
        markBotBridgeUnreachable();
      }
    } finally {
      endManualStatusUpdate();
    }
  }, [applyStatusEndpointSnapshot, beginManualStatusUpdate, endManualStatusUpdate]);

  const handleAuthorizeSender = useCallback(async () => {
    const fromId = allowSenderId.trim();
    if (!fromId) return;
    setAllowlistBusy(true);
    setAllowlistError(null);
    try {
      const next = await authorizeBotSender({
        platform: configPlatform,
        fromId,
        label: allowSenderLabel.trim() || undefined,
      });
      setManifest(next);
      setAllowSenderId('');
      setAllowSenderLabel('');
    } catch (err) {
      setAllowlistError(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowlistBusy(false);
    }
  }, [allowSenderId, allowSenderLabel, configPlatform]);

  const handleRevokeSender = useCallback(async (entry: AllowlistEntryDTO) => {
    setAllowlistBusy(true);
    setAllowlistError(null);
    try {
      setManifest(await revokeBotSender(entry.platform, entry.fromId));
    } catch (err) {
      setAllowlistError(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowlistBusy(false);
    }
  }, []);

  // ── Slack desktop binding (no relayed /pair code) ──────────────────────
  const refreshSlackBind = useCallback(async () => {
    try {
      const r = await fetchSlackBindRequests();
      setSlackArmedUntil(r.armed?.expiresAt ?? null);
      setSlackBindRequests(r.requests);
    } catch {
      /* poll is best-effort; explicit actions surface their own errors */
    }
  }, []);

  const handleArmSlackBind = useCallback(async () => {
    setSlackBindBusy(true);
    setSlackBindError(null);
    try {
      const { expiresAt } = await armSlackBind();
      setSlackArmedUntil(expiresAt);
      await refreshSlackBind();
    } catch (err) {
      setSlackBindError(err instanceof Error ? err.message : String(err));
    } finally {
      setSlackBindBusy(false);
    }
  }, [refreshSlackBind]);

  const handleApproveSlackBind = useCallback(
    async (chatId: string, senderId: string) => {
      setSlackBindBusy(true);
      setSlackBindError(null);
      try {
        await approveSlackBind(chatId, senderId);
        await refreshSlackBind();
        await refreshManifest();
        await refreshStatus();
      } catch (err) {
        setSlackBindError(err instanceof Error ? err.message : String(err));
      } finally {
        setSlackBindBusy(false);
      }
    },
    [refreshManifest, refreshSlackBind, refreshStatus],
  );

  const handleDenySlackBind = useCallback(
    async (chatId: string, senderId: string) => {
      setSlackBindBusy(true);
      setSlackBindError(null);
      try {
        await denySlackBind(chatId, senderId);
        await refreshSlackBind();
      } catch (err) {
        setSlackBindError(err instanceof Error ? err.message : String(err));
      } finally {
        setSlackBindBusy(false);
      }
    },
    [refreshSlackBind],
  );

  // Poll pending Slack bind requests while the panel is open on Slack.
  // Ticks are skipped while the tab is hidden; becoming visible again fires
  // one immediate tick so pending requests don't wait a full interval.
  useEffect(() => {
    if (!open || snapshot?.platform !== 'slack') return;
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (alive) await refreshSlackBind();
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [open, snapshot?.platform, refreshSlackBind]);

  useEffect(() => {
    if (!open) return;
    void refreshManifest();
  }, [open, refreshManifest]);

  const handlePlatformChange = useCallback(
    async (next: BotPlatform) => {
      if (
        platformSwitchInFlightRef.current ||
        settlingPlatformRef.current ||
        next === snapshot?.platform
      ) {
        return;
      }
      platformSwitchInFlightRef.current = true;
      beginManualStatusUpdate();
      setPendingPlatform(next);
      setSettlingPlatform(next);
      setPlatformBusy(true);
      setPlatformError(null);
      try {
        const s = await setBotPlatform(next);
        setSnapshot(s);
        setReachable(true);
        // Switching provider invalidates any shown pair code (it was minted
        // for the previous platform's bot).
        setPairCode(null);
        setTokenEditing(false);
        setTokenInput('');
      } catch (err) {
        setSettlingPlatform(null);
        setPlatformError(err instanceof Error ? err.message : String(err));
      } finally {
        setPlatformBusy(false);
        setPendingPlatform(null);
        platformSwitchInFlightRef.current = false;
        endManualStatusUpdate();
      }
    },
    [beginManualStatusUpdate, endManualStatusUpdate, setSettlingPlatform, snapshot?.platform],
  );

  const handleSaveToken = useCallback(async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const platform = buildBotPlatformPickerState(snapshot, {
        pendingPlatform,
        platformBusy,
        settlingPlatform,
      }).current;
      let token: string;
      if (platform === 'slack') {
        const sub = buildSlackTokenSubmission(slackAppToken, slackBotToken);
        if (!sub.ok) {
          setTokenError(sub.error);
          return; // finally still clears tokenBusy
        }
        token = sub.combined;
      } else {
        token = tokenInput.trim();
      }
      await setBotToken(token);
      setTokenInput('');
      setSlackAppToken('');
      setSlackBotToken('');
      setTokenEditing(false);
      await refreshStatus();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenBusy(false);
    }
  }, [
    tokenInput,
    slackAppToken,
    slackBotToken,
    snapshot,
    pendingPlatform,
    platformBusy,
    settlingPlatform,
    refreshStatus,
  ]);

  const handleClearToken = useCallback(async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      await clearBotToken();
      await refreshStatus();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenBusy(false);
    }
  }, [refreshStatus]);

  const handleDisconnect = useCallback(async () => {
    beginManualStatusUpdate();
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await disconnectBotBridge();
      setSnapshot(next);
      setReachable(true);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
      endManualStatusUpdate();
    }
  }, [beginManualStatusUpdate, endManualStatusUpdate]);

  const handleConnect = useCallback(async () => {
    beginManualStatusUpdate();
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await connectBotBridge();
      setSnapshot(next);
      setReachable(true);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
      endManualStatusUpdate();
    }
  }, [beginManualStatusUpdate, endManualStatusUpdate]);

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={labelForStatus(snapshot)}
        aria-label={labelForStatus(snapshot)}
        className={`shrink-0 p-1 transition-colors ${color}`}
      >
        <Bot size={14} />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={300}
        maxHeight={460}
      >
        <div className="overflow-y-auto p-3 text-body text-tagma-text">
          <div className="font-medium mb-1">Bot bridge</div>
          {!reachable && (
            <div className="mb-2 border border-tagma-warning/40 bg-tagma-warning/10 px-2 py-1 text-tagma-warning">
              Sidecar not responding - status is stale and Connect/switch will fail until it's back.
              Your selection below is preserved.
            </div>
          )}
          {(() => {
            const picker = buildBotPlatformPickerState(snapshot, {
              pendingPlatform,
              platformBusy,
              settlingPlatform,
            });
            return (
              <div className="mb-2">
                <label className="flex items-center gap-2">
                  <span className="text-tagma-muted">Provider</span>
                  <select
                    value={picker.current}
                    disabled={picker.locked}
                    aria-busy={platformBusy || settlingPlatform ? true : undefined}
                    onChange={(e) => void handlePlatformChange(e.target.value as BotPlatform)}
                    className="field-input flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {picker.platforms.map((p) => (
                      <option key={p} value={p}>
                        {PLATFORM_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </label>
                {picker.busyText && (
                  <div className="text-tagma-muted mt-1" role="status" aria-live="polite">
                    {picker.busyText}
                  </div>
                )}
                {picker.lockText && <div className="text-tagma-muted mt-1">{picker.lockText}</div>}
                {platformError && <div className="text-tagma-error mt-1">{platformError}</div>}
              </div>
            );
          })()}
          <div className="text-tagma-muted mb-2">{labelForStatus(snapshot)}</div>
          {snapshot && (
            <dl className="space-y-1 mb-3">
              {snapshot.username && (
                <div className="flex justify-between">
                  <dt className="text-tagma-muted">Bot</dt>
                  <dd className="min-w-0 truncate ml-2">@{snapshot.username}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-tagma-muted">Last heartbeat</dt>
                <dd className="min-w-0 truncate ml-2">{formatRelative(snapshot.lastSuccessAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-tagma-muted">Last checked</dt>
                <dd className="min-w-0 truncate ml-2">{formatRelative(snapshot.lastCheckAt)}</dd>
              </div>
              {snapshot.lastError && snapshot.status === 'error' && (
                <div className="flex justify-between">
                  <dt className="text-tagma-muted">Last error</dt>
                  <dd className="text-tagma-error min-w-0 truncate ml-2" title={snapshot.lastError}>
                    {snapshot.lastError}
                  </dd>
                </div>
              )}
              {snapshot.pendingPairs > 0 && (
                <div className="flex justify-between">
                  <dt className="text-tagma-muted">Pending pair codes</dt>
                  <dd className="min-w-0 truncate ml-2">{snapshot.pendingPairs}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-tagma-muted">Token</dt>
                <dd className="min-w-0 truncate ml-2">
                  {snapshot.tokenSource === 'none' ? 'not set' : 'configured'}
                </dd>
              </div>
            </dl>
          )}

          {/* Token configuration. Stored by Tagma when the local credential backend is available. */}
          <div className="border-t border-tagma-border pt-2 space-y-2 mt-2">
            {tokenEditing ? (
              <div className="space-y-1">
                {isSlack ? (
                  <>
                    <div className="text-tagma-muted">
                      Slack needs two tokens. At api.slack.com/apps first enable Socket Mode + Event
                      Subscriptions, and under App Home enable the Messages Tab with "Allow users to
                      send … messages" (else the bot's DM box is hidden).
                    </div>
                    <input
                      type="password"
                      value={slackAppToken}
                      onChange={(e) => setSlackAppToken(e.target.value)}
                      placeholder="App-Level token (xapp-…)"
                      aria-label="Slack App-Level token"
                      className="field-input w-full font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <input
                      type="password"
                      value={slackBotToken}
                      onChange={(e) => setSlackBotToken(e.target.value)}
                      placeholder="Bot token (xoxb-…)"
                      aria-label="Slack Bot token"
                      className="field-input w-full font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </>
                ) : (
                  <input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste bot token"
                    className="field-input w-full font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={handleSaveToken}
                    disabled={
                      tokenBusy ||
                      (isSlack
                        ? slackAppToken.trim().length === 0 || slackBotToken.trim().length === 0
                        : tokenInput.trim().length === 0)
                    }
                    className="flex-1 border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {tokenBusy ? 'Saving…' : 'Save to keychain'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTokenEditing(false);
                      setTokenInput('');
                      setSlackAppToken('');
                      setSlackBotToken('');
                      setTokenError(null);
                    }}
                    disabled={tokenBusy}
                    className="border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth"
                  >
                    Cancel
                  </button>
                </div>
                {snapshot && !snapshot.keychainAvailable && (
                  <div className="text-tagma-warning">
                    Token storage unavailable here: {snapshot.keychainMessage}.
                  </div>
                )}
              </div>
            ) : (
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setTokenEditing(true);
                    setTokenError(null);
                  }}
                  className="flex-1 border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth"
                >
                  {snapshot?.tokenSource === 'none' ? 'Set bot token' : 'Replace token'}
                </button>
                {snapshot?.tokenSource === 'keychain' && (
                  <button
                    type="button"
                    onClick={handleClearToken}
                    disabled={tokenBusy}
                    className="border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}
            {tokenError && <div className="text-tagma-error">{tokenError}</div>}
          </div>

          <div className="border-t border-tagma-border pt-2 space-y-2 mt-2">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">Authorized IDs</div>
              <div className="text-tagma-muted">{PLATFORM_LABELS[configPlatform]}</div>
            </div>
            <div className="text-tagma-muted">
              {manualRestrictionEnabled
                ? 'Manual restriction is active for this provider.'
                : 'No manual restriction: a valid pair/bind flow can authorize senders.'}
            </div>
            <form
              className="space-y-1"
              onSubmit={(e) => {
                e.preventDefault();
                void handleAuthorizeSender();
              }}
            >
              <input
                type="text"
                value={allowSenderId}
                onChange={(e) => setAllowSenderId(e.target.value)}
                placeholder={`${PLATFORM_LABELS[configPlatform]} user ID`}
                className="field-input w-full font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="flex gap-1">
                <input
                  type="text"
                  value={allowSenderLabel}
                  onChange={(e) => setAllowSenderLabel(e.target.value)}
                  placeholder="Label"
                  className="field-input min-w-0 flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  disabled={allowlistBusy || allowSenderId.trim().length === 0}
                  className="border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
            </form>
            {allowedSenders.length > 0 ? (
              <ul className="space-y-1">
                {allowedSenders.map((entry) => (
                  <li
                    key={`${entry.platform}:${entry.fromId}`}
                    className="flex items-center gap-2 border border-tagma-border px-2 py-1"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono"
                      title={allowedSenderLabel(entry)}
                    >
                      {allowedSenderLabel(entry)}
                    </span>
                    <span className="shrink-0 text-tagma-muted">
                      {allowedSenderSourceLabel(entry)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleRevokeSender(entry)}
                      disabled={allowlistBusy}
                      className="border border-tagma-border px-1.5 py-0.5 text-caption hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-tagma-muted">No authorized IDs for this provider yet.</div>
            )}
            {allowlistError && <div className="text-tagma-error">{allowlistError}</div>}
          </div>

          <div className="border-t border-tagma-border pt-2 space-y-2 mt-2">
            {isSlack ? (
              <div className="space-y-2">
                <div className="text-tagma-muted">
                  Slack pairs from here (no /pair code). Arm, message the bot once, then approve the
                  request below.
                </div>
                <button
                  type="button"
                  onClick={() => void handleArmSlackBind()}
                  disabled={slackBindBusy || status === 'disabled' || status === 'error'}
                  className="w-full border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {slackArmedUntil && slackArmedUntil > Date.now()
                    ? `Armed — message the bot now (${Math.max(
                        0,
                        Math.round((slackArmedUntil - Date.now()) / 1000),
                      )} s)`
                    : 'Bind Slack to this workspace'}
                </button>
                {slackBindRequests.length > 0 && (
                  <ul className="space-y-1">
                    {slackBindRequests.map((r) => (
                      <li
                        key={`${r.chatId}:${r.senderId}`}
                        className="border border-tagma-border px-2 py-1"
                      >
                        <div className="text-tagma-text">
                          @{r.senderLabel ?? r.senderId}{' '}
                          <span className="text-tagma-muted">
                            ({r.chatKind === 'private' ? 'DM' : 'channel'})
                          </span>
                        </div>
                        <div className="mt-1 flex gap-1">
                          <button
                            type="button"
                            onClick={() => void handleApproveSlackBind(r.chatId, r.senderId)}
                            disabled={slackBindBusy}
                            className="flex-1 border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDenySlackBind(r.chatId, r.senderId)}
                            disabled={slackBindBusy}
                            className="flex-1 border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40"
                          >
                            Deny
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {slackBindError && <div className="text-tagma-error">{slackBindError}</div>}
              </div>
            ) : pairCode ? (
              <div>
                <div className="text-tagma-muted">Send to your bot:</div>
                <div className="font-mono text-display tracking-widest text-tagma-text my-1 select-all">
                  /pair {pairCode.code}
                </div>
                <div className="text-tagma-muted">
                  Expires in {Math.max(0, Math.round((pairCode.expiresAt - Date.now()) / 1000))} s
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={pairing || status === 'disabled' || status === 'error'}
                className="w-full border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pairing ? 'Generating…' : 'Generate pair code'}
              </button>
            )}
            {!isSlack && pairError && <div className="text-tagma-error">{pairError}</div>}

            {status === 'connected' || status === 'connecting' ? (
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={connecting}
                className="w-full border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {connecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="w-full border border-tagma-border px-2 py-1 hover:bg-tagma-elevated transition-colors duration-fast ease-smooth disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            )}
            {connectError && <div className="text-tagma-error">{connectError}</div>}
          </div>
        </div>
      </FloatingPanel>
    </>
  );
}
