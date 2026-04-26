import { describe, expect, test } from 'bun:test';
import plugin, { WebhookTrigger } from './index';
import manifest from '../package.json' with { type: 'json' };

describe('trigger-webhook plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('triggers');
    expect(manifest.tagmaPlugin.type).toBe('webhook');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.triggers?.[manifest.tagmaPlugin.type]).toBe(WebhookTrigger);
  });

  test('watch is a function', () => {
    expect(typeof plugin.capabilities!.triggers!.webhook.watch).toBe('function');
  });
});
