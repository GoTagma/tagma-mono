import { describe, expect, test } from 'bun:test';
import {
  type FormState,
  type ModelRow,
  validateCustomProviderForm,
} from '../src/components/chat/CustomProviderModal';
import {
  blankModelReasoningDraft,
  touchReasoningDraft,
} from '../src/components/chat/custom-provider-reasoning';

function modelRow(id = ''): ModelRow {
  return {
    id,
    name: '',
    context: '',
    output: '',
    reasoning: blankModelReasoningDraft(),
    reasoningOpen: false,
  };
}

function formWithModels(models: ModelRow[]): FormState {
  return {
    id: 'local-provider',
    name: 'Local provider',
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    apiKey: '',
    headers: [],
    models,
    scope: 'global',
  };
}

describe('custom provider modal form validation', () => {
  test('blocks an authored blank-id row before it can be dropped during serialization', () => {
    const authored = { ...modelRow(), name: 'Unsaved reasoning model' };
    expect(
      validateCustomProviderForm(formWithModels([authored, modelRow('detected')]), false),
    ).toBe('Every configured model needs a model id.');
  });

  test('blocks duplicate trimmed model ids before a later row can overwrite the first', () => {
    expect(
      validateCustomProviderForm(
        formWithModels([modelRow('detected'), modelRow('detected ')]),
        false,
      ),
    ).toBe('Duplicate model id "detected".');
  });

  test('does not treat a touch-only template placeholder as authored model data', () => {
    const placeholder = modelRow();
    placeholder.reasoning = touchReasoningDraft(placeholder.reasoning);
    expect(
      validateCustomProviderForm(formWithModels([placeholder, modelRow('detected')]), false),
    ).toBeNull();
  });
});
