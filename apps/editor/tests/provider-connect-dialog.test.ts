import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderAuthMethod } from '../src/api/opencode-chat';
import { isPromptVisible } from '../src/components/chat/ProviderConnectDialog';
import {
  shouldDismissModalFromBackdropClick,
  useModalBackdropDismiss,
  type ModalBackdropDismissHandlers,
  type ModalBackdropPointerSequence,
} from '../src/components/modal-backdrop-dismiss';
import { providerAuthMethodKey } from '../src/components/chat/provider-auth-method-key';

function renderBackdropDismissHandlers(onDismiss: () => void): ModalBackdropDismissHandlers {
  let handlers: ModalBackdropDismissHandlers | null = null;
  function Probe() {
    handlers = useModalBackdropDismiss(onDismiss);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!handlers) throw new Error('Backdrop dismiss handlers did not render');
  return handlers;
}

function backdropEvent<T>(target: EventTarget, currentTarget: EventTarget): T {
  return { target, currentTarget } as T;
}

describe('provider connect dialog backdrop dismissal', () => {
  test('does not dismiss after a text-selection drag starts inside and ends outside', () => {
    const selectionDrag: ModalBackdropPointerSequence = {
      startedOnBackdrop: false,
      endedOnBackdrop: true,
    };

    // Browsers target the synthesized click at the closest common ancestor of
    // the press and release targets — the backdrop in this interaction.
    expect(shouldDismissModalFromBackdropClick(selectionDrag, true)).toBe(false);
  });

  test('dismisses only when the complete pointer click stays on the backdrop', () => {
    expect(
      shouldDismissModalFromBackdropClick({ startedOnBackdrop: true, endedOnBackdrop: true }, true),
    ).toBe(true);
    expect(
      shouldDismissModalFromBackdropClick(
        { startedOnBackdrop: true, endedOnBackdrop: false },
        true,
      ),
    ).toBe(false);
    expect(
      shouldDismissModalFromBackdropClick(
        { startedOnBackdrop: true, endedOnBackdrop: true },
        false,
      ),
    ).toBe(false);
    expect(shouldDismissModalFromBackdropClick(null, true)).toBe(false);
  });

  test('tracks the real handler sequence across a selection drag and the next outside click', () => {
    let dismissCount = 0;
    const handlers = renderBackdropDismissHandlers(() => {
      dismissCount += 1;
    });
    const backdrop = new EventTarget();
    const input = new EventTarget();

    handlers.onPointerDownCapture(backdropEvent(input, backdrop));
    handlers.onPointerUpCapture(backdropEvent(backdrop, backdrop));
    handlers.onClick(backdropEvent(backdrop, backdrop));
    expect(dismissCount).toBe(0);

    handlers.onPointerDownCapture(backdropEvent(backdrop, backdrop));
    handlers.onPointerUpCapture(backdropEvent(backdrop, backdrop));
    handlers.onClick(backdropEvent(backdrop, backdrop));
    expect(dismissCount).toBe(1);

    handlers.onPointerDownCapture(backdropEvent(backdrop, backdrop));
    handlers.onPointerCancelCapture(backdropEvent(backdrop, backdrop));
    handlers.onClick(backdropEvent(backdrop, backdrop));
    expect(dismissCount).toBe(1);
  });

  test('dismisses the custom-provider layer without dismissing its parent portal', () => {
    let parentDismissCount = 0;
    let childDismissCount = 0;
    const parentHandlers = renderBackdropDismissHandlers(() => {
      parentDismissCount += 1;
    });
    const childHandlers = renderBackdropDismissHandlers(() => {
      childDismissCount += 1;
    });
    const parentBackdrop = new EventTarget();
    const childBackdrop = new EventTarget();

    parentHandlers.onPointerDownCapture(backdropEvent(childBackdrop, parentBackdrop));
    childHandlers.onPointerDownCapture(backdropEvent(childBackdrop, childBackdrop));
    parentHandlers.onPointerUpCapture(backdropEvent(childBackdrop, parentBackdrop));
    childHandlers.onPointerUpCapture(backdropEvent(childBackdrop, childBackdrop));
    childHandlers.onClick(backdropEvent(childBackdrop, childBackdrop));
    parentHandlers.onClick(backdropEvent(childBackdrop, parentBackdrop));

    expect(childDismissCount).toBe(1);
    expect(parentDismissCount).toBe(0);
  });
});

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
      prompts: [
        {
          type: 'text',
          key: 'enterpriseUrl',
          message: 'GitHub Enterprise URL',
          placeholder: 'https://github.example.com',
          when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
        },
      ],
    } satisfies ProviderAuthMethod;

    expect(providerAuthMethodKey('github-copilot', method, 0)).not.toBe(
      providerAuthMethodKey('github-copilot', method, 1),
    );
    expect(providerAuthMethodKey('github-copilot', method, 0)).not.toBe(
      providerAuthMethodKey('github-copilot', changedPrompt, 0),
    );
  });
});

describe('provider auth prompt visibility', () => {
  test('supports both eq and neq gates from the v2 auth schema', () => {
    const eqPrompt = {
      type: 'text',
      key: 'enterpriseUrl',
      message: 'Enterprise URL',
      when: { key: 'deploymentType', op: 'eq', value: 'enterprise' },
    } as NonNullable<ProviderAuthMethod['prompts']>[number];
    const neqPrompt = {
      type: 'text',
      key: 'publicEndpoint',
      message: 'Public endpoint',
      when: { key: 'deploymentType', op: 'neq', value: 'enterprise' },
    } as NonNullable<ProviderAuthMethod['prompts']>[number];

    expect(isPromptVisible(eqPrompt, { deploymentType: 'enterprise' })).toBe(true);
    expect(isPromptVisible(eqPrompt, { deploymentType: 'public' })).toBe(false);
    expect(isPromptVisible(neqPrompt, { deploymentType: 'public' })).toBe(true);
    expect(isPromptVisible(neqPrompt, { deploymentType: 'enterprise' })).toBe(false);
  });

  test('keeps prompts visible for an unknown runtime gate operator', () => {
    const futurePrompt = {
      type: 'text',
      key: 'futureValue',
      message: 'Future value',
      when: { key: 'deploymentType', op: 'matches', value: 'enterprise' },
    } as unknown as NonNullable<ProviderAuthMethod['prompts']>[number];

    expect(isPromptVisible(futurePrompt, { deploymentType: 'enterprise' })).toBe(true);
  });
});
