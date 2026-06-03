import { describe, expect, test } from 'bun:test';
import type { ProviderAuthMethod } from '../src/api/opencode-chat';
import { providerAuthMethodKey } from '../src/components/chat/provider-auth-method-key';

describe('provider auth method row identity', () => {
  test('changes when a provider auth method changes at the same list index', () => {
    const apiMethod = {
      type: 'api',
      label: 'API Key',
      prompts: [{ type: 'text', key: 'accountId', message: 'Account ID' }],
    } as ProviderAuthMethod;
    const oauthMethod = {
      type: 'oauth',
      label: 'OAuth',
      prompts: [
        {
          type: 'select',
          key: 'deploymentType',
          message: 'Deployment',
          options: [
            { label: 'GitHub.com', value: 'github.com' },
            { label: 'Enterprise', value: 'enterprise' },
          ],
        },
      ],
    } as ProviderAuthMethod;

    expect(providerAuthMethodKey('github-copilot', apiMethod, 0)).not.toBe(
      providerAuthMethodKey('github-copilot', oauthMethod, 0),
    );
  });

  test('keeps duplicate auth methods distinct while preserving prompt schema identity', () => {
    const method = {
      type: 'oauth',
      label: 'OAuth',
      prompts: [
        {
          type: 'text',
          key: 'enterpriseUrl',
          message: 'Enterprise URL',
          placeholder: 'https://github.example.com',
          when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
        },
      ],
    } as ProviderAuthMethod;
    const changedPrompt = {
      ...method,
      prompts: [{ ...(method.prompts?.[0] as object), message: 'GitHub Enterprise URL' }],
    } as ProviderAuthMethod;

    expect(providerAuthMethodKey('github-copilot', method, 0)).not.toBe(
      providerAuthMethodKey('github-copilot', method, 1),
    );
    expect(providerAuthMethodKey('github-copilot', method, 0)).not.toBe(
      providerAuthMethodKey('github-copilot', changedPrompt, 0),
    );
  });
});
