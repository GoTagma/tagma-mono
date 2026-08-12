import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isTrialInteractionDeclaration } from '@tagma/types';

import { loadPluginWorker } from '../server/plugins/worker-runtime';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('isolated plugin worker Trial Interaction Protocol metadata', () => {
  test('forwards every capability declaration without invoking capability methods', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-plugin-worker-trial-'));
    tempRoots.push(root);
    const entry = join(root, 'index.mjs');
    writeFileSync(
      entry,
      `
const bounded = {
  protocolVersion: 1,
  interaction: 'none',
  unattended: 'native',
  filesystem: 'temp-only',
  network: 'none',
  secrets: 'none',
  runtime: 'bounded',
};
export default {
  name: '@example/trial-metadata',
  capabilities: {
    drivers: {
      example_driver: {
        name: 'example-driver',
        capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
        trial: { ...bounded, interaction: 'credential', unattended: 'host-adapter' },
        buildCommand() { throw new Error('buildCommand must not execute during metadata load'); },
      },
    },
    triggers: {
      example_trigger: {
        name: 'example-trigger',
        trial: { ...bounded, interaction: 'external-event', unattended: 'fixture' },
        watch() { throw new Error('watch must not execute during metadata load'); },
      },
    },
    completions: {
      example_completion: {
        name: 'example-completion',
        trial: bounded,
        check() { throw new Error('check must not execute during metadata load'); },
      },
    },
    middlewares: {
      malformed_middleware: {
        name: 'malformed-middleware',
        trial: { ...bounded, protocolVersion: 99 },
        enhanceDoc() { throw new Error('enhanceDoc must not execute during metadata load'); },
      },
    },
  },
};
`,
      'utf8',
    );

    const handle = await loadPluginWorker(pathToFileURL(entry).href, 2_000, undefined, {
      importRootUrl: pathToFileURL(root).href,
    });
    try {
      const capabilities = handle.plugin.capabilities!;
      expect(capabilities.drivers!.example_driver.trial).toMatchObject({
        interaction: 'credential',
        unattended: 'host-adapter',
      });
      expect(capabilities.triggers!.example_trigger.trial).toMatchObject({
        interaction: 'external-event',
        unattended: 'fixture',
      });
      expect(
        isTrialInteractionDeclaration(capabilities.completions!.example_completion.trial),
      ).toBe(true);
      const malformedTrial = capabilities.middlewares!.malformed_middleware.trial as unknown;
      expect(malformedTrial).toEqual({
        ...capabilities.completions!.example_completion.trial,
        protocolVersion: 99,
      });
      expect(isTrialInteractionDeclaration(malformedTrial)).toBe(false);
    } finally {
      handle.terminate();
    }
  });
});
