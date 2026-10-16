import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import {
  OpenCodeDefinitivePromptError,
  OpenCodeSdkAdapter,
  type OpenCodeAdapterSdkClient,
} from './chat-operations/opencode-adapter';
import {
  trialSemanticReviewConfigurationDigest,
  type TrialSemanticReviewModel,
  type TrialSemanticReviewRuntime,
} from './chat-trial-semantic-review';
import { ensureOpencode } from './opencode-lifecycle';
import { createStreamingLoopbackFetch } from './loopback-fetch';

/** Server-only factory; neither model choice nor an invoker is accepted from Trial routes. */
export function createOpenCodeTrialSemanticReviewRuntime(options: {
  readonly sourceDirectory: string;
  readonly model: TrialSemanticReviewModel;
  readonly resolveClient?: () => Promise<OpenCodeAdapterSdkClient>;
}): TrialSemanticReviewRuntime {
  if (!isAbsolute(options.sourceDirectory))
    throw new TypeError('Semantic review needs a Host source directory.');
  const model = Object.freeze({
    providerID: options.model.providerID,
    modelID: options.model.modelID,
    variant: options.model.variant,
  });
  trialSemanticReviewConfigurationDigest(model);
  const sourceDirectory = options.sourceDirectory;
  const adapter = new OpenCodeSdkAdapter({
    workspaceDirectory: sourceDirectory,
    resolveClient:
      options.resolveClient ??
      (async () => {
        const handle = await ensureOpencode(sourceDirectory);
        return createOpencodeClient({
          baseUrl: handle.baseUrl,
          directory: sourceDirectory,
          headers: { Authorization: handle.auth.authorization },
          throwOnError: false,
          fetch: createStreamingLoopbackFetch(handle.baseUrl),
        }) as unknown as OpenCodeAdapterSdkClient;
      }),
  });
  return Object.freeze({
    model,
    invoke: async (request: Parameters<TrialSemanticReviewRuntime['invoke']>[0]) => {
      const sessionId = 'ses_tagma_content_review_' + randomUUID().split('-').join('');
      const failure = (failureCode: string) => ({
        sessionId,
        text: '',
        finishCode: 'error',
        failureCode,
      });
      if (request.signal.aborted) return failure('provider_invocation_aborted');
      let interruption: Promise<void> | null = null;
      const abort = () => {
        interruption ??= adapter.interruptSession(sessionId).catch(() => {});
      };
      try {
        const created = await adapter.createSession({ sessionId });
        if (created.kind !== 'created') return failure('reviewer_session_conflict');
        await adapter.setSessionTitle(sessionId, 'Host independent Trial content review');
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) {
          abort();
          return failure('provider_invocation_aborted');
        }
        const executionMessageId = 'msg_tagma_content_review_' + randomUUID().split('-').join('');
        const response = await adapter.promptTrialSemanticReviewText({
          sessionId,
          executionMessageId,
          model: { providerID: model.providerID, modelID: model.modelID },
          variant: model.variant,
          system: request.system,
          user: request.user,
          signal: request.signal,
        });
        if (request.signal.aborted) return failure('provider_invocation_aborted');
        if (response.messageId !== executionMessageId)
          return failure('reviewer_response_identity_mismatch');
        return {
          sessionId,
          text: response.text,
          finishCode: response.finishCode,
          failureCode: response.failureCode,
        };
      } catch (error) {
        return failure(
          request.signal.aborted
            ? 'provider_invocation_aborted'
            : error instanceof OpenCodeDefinitivePromptError
              ? error.code
              : 'reviewer_transport_unavailable',
        );
      } finally {
        request.signal.removeEventListener('abort', abort);
        if (interruption) await interruption;
      }
    },
  });
}
