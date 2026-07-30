export const CHAT_PIPELINE_TRIAL_CONSENT_VERSION = 1;

export interface ChatPipelineTrialConsentSettings {
  opencodeChatTrialRunEnabled?: boolean | null;
  opencodeChatTrialRunConsentVersion?: number | null;
}

export function hasCurrentChatPipelineTrialConsent(
  settings: ChatPipelineTrialConsentSettings | null | undefined,
): boolean {
  return (
    settings?.opencodeChatTrialRunEnabled === true &&
    settings.opencodeChatTrialRunConsentVersion === CHAT_PIPELINE_TRIAL_CONSENT_VERSION
  );
}
