export const CHAT_PIPELINE_TRIAL_CONSENT_VERSION = 3;
export const CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION = 1;

export interface ChatPipelineTrialConsentSettings {
  opencodeChatTrialRunEnabled?: boolean | null;
  opencodeChatTrialRunConsentVersion?: number | null;
  opencodeChatTrialLiveSmokeTestEnabled?: boolean | null;
  opencodeChatTrialLiveSmokeTestConsentVersion?: number | null;
}

export function hasCurrentChatPipelineTrialLiveSmokeTestConsent(
  settings: ChatPipelineTrialConsentSettings | null | undefined,
): boolean {
  return (
    hasCurrentChatPipelineTrialConsent(settings) &&
    settings?.opencodeChatTrialLiveSmokeTestEnabled === true &&
    settings.opencodeChatTrialLiveSmokeTestConsentVersion ===
      CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION
  );
}

export function hasCurrentChatPipelineTrialConsent(
  settings: ChatPipelineTrialConsentSettings | null | undefined,
): boolean {
  return (
    settings?.opencodeChatTrialRunEnabled === true &&
    settings.opencodeChatTrialRunConsentVersion === CHAT_PIPELINE_TRIAL_CONSENT_VERSION
  );
}
