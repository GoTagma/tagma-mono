import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig } from '@tagma/types';

import { validateChatPipelinePathCoordinates } from '../server/chat-pipeline-path-validation';

function configWithPaths(options: {
  trackCwd?: string;
  taskCwd?: string;
  triggerPath?: string;
  completionPath?: string;
  staticContextPath?: string;
}): RawPipelineConfig {
  return {
    name: 'Fact Checker',
    tracks: [
      {
        id: 'ingest',
        name: 'Ingest',
        ...(options.trackCwd ? { cwd: options.trackCwd } : {}),
        ...(options.staticContextPath
          ? {
              middlewares: [{ type: 'static_context', file: options.staticContextPath }],
            }
          : {}),
        tasks: [
          {
            id: 'read',
            name: 'Read',
            prompt: 'Read the input',
            ...(options.taskCwd ? { cwd: options.taskCwd } : {}),
            ...(options.triggerPath
              ? { trigger: { type: 'file', path: options.triggerPath } }
              : {}),
            ...(options.completionPath
              ? {
                  completion: { type: 'file_exists', path: options.completionPath },
                }
              : {}),
          },
        ],
      },
    ],
  } as RawPipelineConfig;
}

describe('chat pipeline path-coordinate validation', () => {
  test('rejects repeated POSIX pipeline coordinates for every task-local built-in path', () => {
    const diagnostics = validateChatPipelinePathCoordinates(
      configWithPaths({
        trackCwd: '.tagma/fact-checker',
        triggerPath: '.tagma/fact-checker/input/article.md',
        completionPath: '.tagma/fact-checker/work/units.json',
        staticContextPath: '.tagma/fact-checker/trusted-sources.json',
      }),
      {
        workspaceRoot: '/workspace',
        relativeYamlPath: 'fact-checker/fact-checker.yaml',
        platform: 'linux',
      },
    );

    expect(diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      'tracks[0].middlewares[0].file',
      'tracks[0].tasks[0].trigger.path',
      'tracks[0].tasks[0].completion.path',
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(diagnostics[0]?.message).toContain('resolved relative to effective task cwd');
  });

  test('uses task cwd as a workspace-root override instead of appending it to track cwd', () => {
    const diagnostics = validateChatPipelinePathCoordinates(
      configWithPaths({
        trackCwd: '.tagma/fact-checker',
        taskCwd: '.tagma/fact-checker/nested',
        triggerPath: '.tagma/fact-checker/input/article.md',
      }),
      {
        workspaceRoot: '/workspace',
        relativeYamlPath: 'fact-checker/fact-checker.yaml',
        platform: 'linux',
      },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('.tagma/fact-checker/nested');
  });

  test('accepts cwd-relative, workspace-root, absolute, and explicitly nested POSIX paths', () => {
    const cases = [
      configWithPaths({
        trackCwd: '.tagma/fact-checker',
        triggerPath: 'input/article.md',
        completionPath: 'work/units.json',
        staticContextPath: 'trusted-sources.json',
      }),
      configWithPaths({ triggerPath: '.tagma/fact-checker/input/article.md' }),
      configWithPaths({
        trackCwd: '.tagma/fact-checker',
        triggerPath: '/external/incoming/article.md',
      }),
      configWithPaths({
        trackCwd: '.tagma/fact-checker',
        triggerPath: './.tagma/fact-checker/input/article.md',
      }),
      configWithPaths({
        trackCwd: '.tagma/shared',
        triggerPath: '.tagma/shared/input/article.md',
      }),
    ];

    for (const config of cases) {
      expect(
        validateChatPipelinePathCoordinates(config, {
          workspaceRoot: '/workspace',
          relativeYamlPath: 'fact-checker/fact-checker.yaml',
          platform: 'linux',
        }),
      ).toEqual([]);
    }
  });

  test('preserves POSIX backslashes and leading spaces as literal path characters', () => {
    for (const triggerPath of [
      '.tagma\\fact-checker\\input\\article.md',
      ' .tagma/fact-checker/input/article.md',
    ]) {
      expect(
        validateChatPipelinePathCoordinates(
          configWithPaths({
            trackCwd: '.tagma/fact-checker',
            triggerPath,
          }),
          {
            workspaceRoot: '/workspace',
            relativeYamlPath: 'fact-checker/fact-checker.yaml',
            platform: 'linux',
          },
        ),
      ).toEqual([]);
    }
  });

  test('normalizes Windows separators and compares pipeline coordinates case-insensitively', () => {
    const diagnostics = validateChatPipelinePathCoordinates(
      configWithPaths({
        trackCwd: '.TAGMA\\FACT-CHECKER',
        triggerPath: '.tagma\\fact-checker\\input\\article.md',
      }),
      {
        workspaceRoot: 'C:\\workspace',
        relativeYamlPath: 'fact-checker/fact-checker.yaml',
        platform: 'win32',
      },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.path).toBe('tracks[0].tasks[0].trigger.path');
    for (const explicitPath of [
      './.tagma/fact-checker/input/article.md',
      '.\\.tagma\\fact-checker\\input\\article.md',
    ]) {
      expect(
        validateChatPipelinePathCoordinates(
          configWithPaths({
            trackCwd: '.tagma\\fact-checker',
            triggerPath: explicitPath,
          }),
          {
            workspaceRoot: 'C:\\workspace',
            relativeYamlPath: 'fact-checker/fact-checker.yaml',
            platform: 'win32',
          },
        ),
      ).toEqual([]);
    }
  });

  test('defaults to the production host platform when no override is supplied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!descriptor) throw new Error('process.platform descriptor is unavailable');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    try {
      const diagnostics = validateChatPipelinePathCoordinates(
        configWithPaths({
          trackCwd: '.tagma\\fact-checker',
          triggerPath: '.tagma\\fact-checker\\input\\article.md',
        }),
        {
          workspaceRoot: 'C:\\workspace',
          relativeYamlPath: 'fact-checker/fact-checker.yaml',
        },
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.path).toBe('tracks[0].tasks[0].trigger.path');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  test('does not impose the chat pipeline-folder rule on legacy flat YAML', () => {
    expect(
      validateChatPipelinePathCoordinates(
        configWithPaths({
          trackCwd: 'foo',
          triggerPath: 'foo/bar.txt',
        }),
        {
          workspaceRoot: '/workspace',
          relativeYamlPath: 'legacy.yaml',
          platform: 'linux',
        },
      ),
    ).toEqual([]);
  });
});
