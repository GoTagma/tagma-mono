import { describe, expect, test } from 'bun:test';

import { OpenCodeDriver } from './opencode';
import { DirectoryTrigger } from '../triggers/directory';
import { FileTrigger } from '../triggers/file';
import { ManualTrigger } from '../triggers/manual';
import { ExitCodeCompletion } from '../completions/exit-code';
import { FileExistsCompletion } from '../completions/file-exists';
import { OutputCheckCompletion } from '../completions/output-check';
import { StaticContextMiddleware } from '../middlewares/static-context';

describe('built-in Trial Interaction Protocol declarations', () => {
  test('declares the managed OpenCode driver as a bounded live credential interaction', () => {
    expect(OpenCodeDriver.trial).toEqual({
      protocolVersion: 1,
      interaction: 'credential',
      unattended: 'host-adapter',
      filesystem: 'external-write',
      network: 'write',
      secrets: 'real-required',
      runtime: 'bounded',
    });
  });

  test('declares approval and filesystem triggers with their unattended adapters', () => {
    expect(ManualTrigger.trial).toEqual({
      protocolVersion: 1,
      interaction: 'approval',
      unattended: 'host-adapter',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    });
    for (const trigger of [FileTrigger, DirectoryTrigger]) {
      expect(trigger.trial).toEqual({
        protocolVersion: 1,
        interaction: 'external-event',
        unattended: 'fixture',
        filesystem: 'workspace-read',
        network: 'none',
        secrets: 'none',
        runtime: 'bounded',
      });
    }
  });

  test('declares deterministic and arbitrary-command completion boundaries', () => {
    expect(ExitCodeCompletion.trial).toEqual({
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'native',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    });
    expect(FileExistsCompletion.trial).toEqual({
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'fixture',
      filesystem: 'workspace-read',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    });
    expect(OutputCheckCompletion.trial).toEqual({
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'host-adapter',
      filesystem: 'external-write',
      network: 'write',
      secrets: 'synthetic-ok',
      runtime: 'bounded',
    });
  });

  test('declares static context as a workspace fixture read', () => {
    expect(StaticContextMiddleware.trial).toEqual({
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'fixture',
      filesystem: 'workspace-read',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    });
  });
});
