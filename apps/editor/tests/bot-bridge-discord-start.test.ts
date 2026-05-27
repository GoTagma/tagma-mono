import { describe, expect, test } from 'bun:test';
import {
  awaitDiscordLoginReady,
  beginDiscordButtonAck,
  finishDiscordButtonAck,
  isDiscordSelfMessage,
} from '../server/chat-bridge/transports/discord';

describe('Discord transport startup sequencing', () => {
  test('races the login call itself against the connect timeout', async () => {
    const neverLogin = new Promise<string>(() => {});
    const ready = Promise.resolve();
    const timeout = Promise.reject(new Error('connect timed out')) as Promise<never>;
    timeout.catch(() => {
      /* consumed by the assertion below */
    });

    await expect(awaitDiscordLoginReady(neverLogin, ready, timeout)).rejects.toThrow(
      'connect timed out',
    );
  });

  test('starts button interaction ack immediately before later toast follow-up', async () => {
    const calls: string[] = [];
    let releaseDefer = () => {};
    const deferGate = new Promise<void>((resolve) => {
      releaseDefer = resolve;
    });
    const interaction = {
      deferUpdate: () => {
        calls.push('defer');
        return deferGate;
      },
      followUp: async (payload: { content: string; ephemeral: boolean }) => {
        calls.push(`follow:${payload.content}:${payload.ephemeral}`);
      },
    } as unknown as Parameters<typeof beginDiscordButtonAck>[0];

    const pending = beginDiscordButtonAck(interaction);
    expect(calls).toEqual(['defer']);

    const finished = finishDiscordButtonAck(pending, 'Approved');
    await Promise.resolve();
    expect(calls).toEqual(['defer']);

    releaseDefer();
    await finished;
    expect(calls).toEqual(['defer', 'follow:Approved:true']);
  });

  test('ignores only the current bot account, not every bot author', () => {
    expect(isDiscordSelfMessage({ id: 'self-bot' }, 'self-bot')).toBe(true);
    expect(isDiscordSelfMessage({ id: 'other-bot' }, 'self-bot')).toBe(false);
    expect(isDiscordSelfMessage({ id: 'human-user' }, 'self-bot')).toBe(false);
    expect(isDiscordSelfMessage({ id: 'other-bot' }, null)).toBe(false);
  });
});
