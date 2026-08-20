import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configurePythonAgentWithDeferredOpencodeApply,
  getOpencodeSettingsMutationBlockMessage,
} from '../src/components/settings/use-editor-settings-controller';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Editor settings OpenCode runtime lock', () => {
  test('blocks restart-backed mutations for any unexpired lock in the current workspace', () => {
    const anotherYamlIsLocked = {
      active: false,
      workspaceActive: true,
    };
    const expiredActiveYamlLock = {
      active: true,
      workspaceActive: false,
    };

    expect(getOpencodeSettingsMutationBlockMessage(anotherYamlIsLocked)).toBe(
      'Wait for the active OpenCode chat to finish before changing OpenCode settings.',
    );
    expect(getOpencodeSettingsMutationBlockMessage(expiredActiveYamlLock)).toBeNull();
  });

  test('explains the lock in the Python AI Agent section, not just OpenCode agents', () => {
    const sections = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );
    const pythonSection = sections.slice(sections.indexOf("show('python-agent')"));
    expect(pythonSection).toContain(
      '{opencodeSettingsMutationBlockMessage && (\n' +
        '            <div className="pt-1 text-caption text-tagma-muted/70">\n' +
        '              {opencodeSettingsMutationBlockMessage}\n' +
        '            </div>\n' +
        '          )}',
    );
  });

  test('labels the deferred runtime apply separately from Python configuration and saving', () => {
    const sections = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );

    expect(sections).toContain('Python is configured. Applying it to OpenCode in the background');
    expect(sections).toContain("? ' · applying OpenCode…'");
  });

  test('reports Python configured without waiting for the OpenCode cold-start apply', async () => {
    const runtimeApply = deferred<void>();
    const runtimeApplied = deferred<void>();
    const transitions: string[] = [];
    let configuredResult: unknown = null;

    await configurePythonAgentWithDeferredOpencodeApply(
      async () => ({ settings: { pythonAgent: { enabled: true } } }),
      () => runtimeApply.promise,
      {
        onConfigured(result) {
          configuredResult = result;
          transitions.push('configured');
        },
        onApplyStarted() {
          transitions.push('applying');
        },
        onApplySucceeded() {
          transitions.push('applied');
          runtimeApplied.resolve();
        },
        onApplyFailed(error) {
          runtimeApplied.reject(error);
        },
      },
    );

    expect(configuredResult).toEqual({ settings: { pythonAgent: { enabled: true } } });
    expect(transitions).toEqual(['configured', 'applying']);

    runtimeApply.resolve();
    await runtimeApplied.promise;
    expect(transitions).toEqual(['configured', 'applying', 'applied']);
  });

  test('reports a deferred OpenCode apply failure separately from Python configuration', async () => {
    const applyFailed = deferred<unknown>();
    const runtimeError = new Error('cold start failed');
    const transitions: string[] = [];

    await configurePythonAgentWithDeferredOpencodeApply(
      async () => ({ configured: true }),
      async () => {
        throw runtimeError;
      },
      {
        onConfigured() {
          transitions.push('configured');
        },
        onApplyStarted() {
          transitions.push('applying');
        },
        onApplySucceeded() {
          transitions.push('applied');
        },
        onApplyFailed(error) {
          transitions.push('apply-failed');
          applyFailed.resolve(error);
        },
      },
    );

    expect(await applyFailed.promise).toBe(runtimeError);
    expect(transitions).toEqual(['configured', 'applying', 'apply-failed']);
  });

  test('does not apply OpenCode when Python configuration fails', async () => {
    const transitions: string[] = [];

    await expect(
      configurePythonAgentWithDeferredOpencodeApply(
        async () => {
          throw new Error('venv creation failed');
        },
        async () => {
          transitions.push('unexpected-apply');
        },
        {
          onConfigured() {
            transitions.push('configured');
          },
          onApplyStarted() {
            transitions.push('applying');
          },
          onApplySucceeded() {
            transitions.push('applied');
          },
          onApplyFailed() {
            transitions.push('apply-failed');
          },
        },
      ),
    ).rejects.toThrow('venv creation failed');

    expect(transitions).toEqual([]);
  });
});
