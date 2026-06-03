import type { AuthPrompt, ProviderAuthMethod } from '../../api/opencode-chat';

function authPromptKey(prompt: AuthPrompt): unknown {
  if (prompt.type === 'select') {
    return {
      type: prompt.type,
      key: prompt.key,
      message: prompt.message,
      options: prompt.options.map((opt) => ({
        label: opt.label,
        value: opt.value,
        hint: opt.hint ?? null,
      })),
      when: prompt.when ?? null,
    };
  }
  return {
    type: prompt.type,
    key: prompt.key,
    message: prompt.message,
    placeholder: prompt.placeholder ?? null,
    when: prompt.when ?? null,
  };
}

export function providerAuthMethodKey(
  providerId: string,
  method: ProviderAuthMethod,
  methodIdx: number,
): string {
  return JSON.stringify({
    providerId,
    methodIdx,
    type: method.type,
    label: method.label,
    prompts: (method.prompts ?? []).map(authPromptKey),
  });
}
