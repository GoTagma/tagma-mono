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
        variant: 'high',
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
        variant: 'high',
      },
    });
  });

  test('round-trips the Host-owned pipeline binding separately from its display path', () => {
    const metadata = buildTagmaSessionMetadata({
      source: 'desktop-chat',
      workspacePath: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/pipeline-branch/pipeline-branch.yaml',
      pipelineBinding: {
        id: 'binding-1',
        intent: 'edit',
        originRelativePath: 'orders/orders.yaml',
        targetRelativePath: 'pipeline-branch/pipeline-branch.yaml',
      },
    });

    expect(parseTagmaSessionMetadata(metadata)).toMatchObject({
      source: 'desktop-chat',
      yamlPath: 'C:/repo/.tagma/pipeline-branch/pipeline-branch.yaml',
      pipelineBinding: {
        id: 'binding-1',
        intent: 'edit',
        originRelativePath: 'orders/orders.yaml',
        targetRelativePath: 'pipeline-branch/pipeline-branch.yaml',
      },
    });
  });

  test('recognizes temporary pipeline classifiers without treating them as desktop chats', () => {
    expect(
      parseTagmaSessionMetadata(
        buildTagmaSessionMetadata({ source: 'pipeline-intent-classifier' }),
      ),
    ).toEqual({ schema: 1, source: 'pipeline-intent-classifier' });
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

  test('preserves an explicit provider-default variant', () => {
    const metadata = buildTagmaSessionMetadata({
      source: 'desktop-chat',
      variant: null,
    });

    expect(metadata).toEqual({
      tagma: { schema: 1, source: 'desktop-chat', variant: null },
    });
    expect(parseTagmaSessionMetadata(metadata)).toEqual({
      schema: 1,
      source: 'desktop-chat',
      variant: null,
    });
  });

  test('parses legacy flat Tagma chat ownership metadata', () => {
    const metadata = {
      tagmaSurface: 'desktop-chat',
      tagmaWorkspace: 'C:/repo',
      tagmaModel: 'openai/gpt-5',
    };

    expect(hasTagmaSessionMarker(metadata)).toBe(true);
    expect(parseTagmaSessionMetadata(metadata)).toEqual({
      schema: 0,
      source: 'desktop-chat',
      workspacePath: 'C:/repo',
    });
  });

  test('parses valid ownership metadata and rejects malformed markers', () => {
    expect(
      parseTagmaSessionMetadata({
        tagma: {
          schema: 1,
          source: 'desktop-chat',
          workspacePath: ' C:/repo ',
          yamlPath: ' C:/repo/.tagma/demo/demo.yaml ',
          model: { providerID: 'openai', modelID: 'gpt-5' },
          variant: 'high',
        },
      }),
    ).toEqual({
      schema: 1,
      source: 'desktop-chat',
      workspacePath: 'C:/repo',
      yamlPath: 'C:/repo/.tagma/demo/demo.yaml',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
    });
    expect(parseTagmaSessionMetadata({ tagma: { schema: 1, source: 'external-cli' } })).toBeNull();
    expect(
      parseTagmaSessionMetadata({ tagma: { schema: '1', source: 'desktop-chat' } }),
    ).toBeNull();
    expect(hasTagmaSessionMarker({ tagma: null })).toBe(true);
    expect(hasTagmaSessionMarker({ other: true })).toBe(false);
  });
});
