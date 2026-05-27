import type { BotPlatform, BotStatusSnapshot } from '../../api/chat-bridge';

export const PLATFORM_LABELS: Record<BotPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};

const DEFAULT_PLATFORMS: readonly BotPlatform[] = ['telegram', 'discord', 'slack'];

export type BotPlatformPickerSnapshot = Pick<
  BotStatusSnapshot,
  'status' | 'platform' | 'platforms'
>;

export function buildBotPlatformPickerState(
  snapshot: BotPlatformPickerSnapshot | null,
  options: {
    pendingPlatform: BotPlatform | null;
    platformBusy: boolean;
    settlingPlatform: BotPlatform | null;
  },
): {
  platforms: readonly BotPlatform[];
  current: BotPlatform;
  locked: boolean;
  busyText: string | null;
  lockText: string | null;
} {
  const platforms = snapshot?.platforms ?? DEFAULT_PLATFORMS;
  const switchingPlatform = options.pendingPlatform ?? options.settlingPlatform;
  const current = switchingPlatform ?? snapshot?.platform ?? 'telegram';
  const switchLocked = options.platformBusy || options.settlingPlatform !== null;
  const liveLocked = snapshot?.status === 'connected' || snapshot?.status === 'connecting';

  return {
    platforms,
    current,
    locked: switchLocked || liveLocked,
    busyText: switchLocked ? `Switching to ${PLATFORM_LABELS[current]}...` : null,
    lockText: !switchLocked && liveLocked ? 'Disconnect to switch provider.' : null,
  };
}

/**
 * Slack is configured its own way: two tokens, not one. The UI shows two
 * labelled fields; this composes the canonical combined
 * `"<xapp-…>|<xoxb-…>"` string the keychain + `SlackTransport.splitTokens()`
 * already expect, with inline validation so a wrong shape is caught here
 * rather than buried at connect time. Pure → unit-tested without the UI.
 */
export type SlackTokenSubmission = { ok: true; combined: string } | { ok: false; error: string };

export function buildSlackTokenSubmission(
  appToken: string,
  botToken: string,
): SlackTokenSubmission {
  const app = appToken.trim();
  const bot = botToken.trim();
  if (!app || !bot) {
    return {
      ok: false,
      error: 'Both the App-Level token (xapp-…) and the Bot token (xoxb-…) are required.',
    };
  }
  if (!app.startsWith('xapp-') || !bot.startsWith('xoxb-')) {
    return {
      ok: false,
      error:
        'Slack token shape looks wrong: the App-Level token must start with "xapp-" and the Bot token with "xoxb-".',
    };
  }
  return { ok: true, combined: `${app}|${bot}` };
}

export function shouldApplyBotBridgeStatusPoll(args: {
  startedEpoch: number;
  currentEpoch: number;
  activeManualUpdates: number;
}): boolean {
  return args.startedEpoch === args.currentEpoch && args.activeManualUpdates === 0;
}
