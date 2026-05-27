/**
 * Human-readable title for the opencode session a bot chat drives.
 *
 * The bot and the desktop chat share one `opencode serve`, so a bot session
 * already appears in the desktop session list — but anonymous. Giving it a
 * title at creation makes the conversation discoverable and readable there as
 * normal, persisted history (Module 2 / spec
 * docs/superpowers/specs/2026-05-17-bot-bridge-per-platform-and-chat-sync-design.md).
 *
 * Pure so the format is unit-tested without a live opencode/bot (matches the
 * codebase's pure-logic test style).
 */

import type { Platform } from './types.js';

const PLATFORM_LABEL: Record<Platform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};

/**
 * `"<Platform> · @<sender> · <workspace-short>"`, e.g.
 * `"Slack · @alice · my-repo"`. Falls back to the platform-native sender id
 * when no human label is available; a blank label counts as no label.
 */
export function composeBotSessionTitle(
  platform: Platform,
  senderLabel: string | null,
  senderId: string,
  workspaceShort: string,
): string {
  const label = senderLabel?.trim() ? senderLabel.trim() : senderId;
  return `${PLATFORM_LABEL[platform]} · @${label} · ${workspaceShort}`;
}
