import { describe, expect, test } from 'bun:test';
import {
  buildTagmaSessionMetadata,
  hasTagmaSessionMarker,
  parseTagmaSessionMetadata,
} from '../shared/opencode-session-metadata';

describe('OpenCode session metadata', () => {
  test('builds compact Tagma metadata for desktop chat sessions', () => {
    expect(
      buildTagmaSessionMetadata({
        source: 'desktop-chat',
        workspacePath: 'C:/repo',
        yamlPath: 'C:/repo/.tagma/build/build.yaml',
        model: { providerID: 'openai', modelID: 'gpt-5' },
        reason: 'first-send',
      }),
    ).toEqual({
      tagma: {
        schema: 1,
        source: 'desktop-chat',
        workspacePath: 'C:/repo',
        yamlPath: 'C:/repo/.tagma/build/build.yaml',
        reason: 'first-send',
        model: { providerID: 'openai', modelID: 'gpt-5' },
      },
    });
  });

  test('omits empty optional fields', () => {
    expect(
      buildTagmaSessionMetadata({
        source: 'bot-bridge',
        workspacePath: '',
        yamlPath: null,
        bot: { platform: 'slack', chatID: '' },
      }),
    ).toEqual({
      tagma: {
        schema: 1,
        source: 'bot-bridge',
        bot: { platform: 'slack' },
      },
    });
  });

  test('parses valid ownership metadata and rejects malformed markers', () => {
    expect(
      parseTagmaSessionMetadata({
        tagma: {
          schema: 1,
          source: 'desktop-chat',
          workspacePath: ' C:/repo ',
        },
      }),
    ).toEqual({
      schema: 1,
      source: 'desktop-chat',
      workspacePath: 'C:/repo',
    });
    expect(parseTagmaSessionMetadata({ tagma: { schema: 1, source: 'external-cli' } })).toBeNull();
    expect(
      parseTagmaSessionMetadata({ tagma: { schema: '1', source: 'desktop-chat' } }),
    ).toBeNull();
    expect(hasTagmaSessionMarker({ tagma: null })).toBe(true);
    expect(hasTagmaSessionMarker({ other: true })).toBe(false);
  });
});
