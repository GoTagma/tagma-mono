import { describe, expect, test } from 'bun:test';
import type { BridgeManifest } from '../src/api/chat-bridge';

describe('bot bridge manifest API shape', () => {
  test('allows all supported platforms in manifest entries', () => {
    const manifest: BridgeManifest = {
      version: 1,
      allowlist: [
        {
          fromId: 'telegram-user',
          label: null,
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'telegram',
        },
        {
          fromId: 'slack-user',
          label: null,
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'slack',
        },
        {
          fromId: 'discord-user',
          label: null,
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'discord',
        },
      ],
      chats: [
        {
          chatId: 'telegram-chat',
          kind: 'private',
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'telegram',
        },
        {
          chatId: 'slack-chat',
          kind: 'private',
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'slack',
        },
        {
          chatId: 'discord-chat',
          kind: 'group',
          pairedAt: '2026-05-17T00:00:00.000Z',
          platform: 'discord',
        },
      ],
      botRunning: true,
    };

    expect(manifest.allowlist.map((entry) => entry.platform)).toEqual([
      'telegram',
      'slack',
      'discord',
    ]);
    expect(manifest.chats.map((entry) => entry.platform)).toEqual(['telegram', 'slack', 'discord']);
  });
});
