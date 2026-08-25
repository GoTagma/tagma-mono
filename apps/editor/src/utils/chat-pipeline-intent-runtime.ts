import { buildTagmaSessionMetadata } from '../../shared/opencode-session-metadata.js';
import { getOpencodeV2Client, unwrap } from '../api/opencode-chat';
import {
  buildChatPipelineIntentClassificationPrompt,
  resolveStructuredChatPipelineIntent,
  type ChatPipelineIntentCandidate,
  type ResolvedChatPipelineIntent,
} from './chat-pipeline-intent-classifier';

export type { ResolvedChatPipelineIntent } from './chat-pipeline-intent-classifier';

export const TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT = 'tagma-pipeline-intent-classifier';
const PIPELINE_INTENT_CLASSIFICATION_TIMEOUT_MS = 5 * 60 * 1_000;

export interface ChatPipelineIntentModelRequest {
  agent: typeof TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT;
  model: { providerID: string; modelID: string };
  variant: string | null;
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export interface ChatPipelineIntentModelGateway {
  createSession(): Promise<string>;
  prompt(sessionId: string, request: ChatPipelineIntentModelRequest): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ClassifyChatPipelineIntentInput {
  userText: string;
  candidates: readonly ChatPipelineIntentCandidate[];
  model: { providerID: string; modelID: string };
  variant: string | null;
}

export async function createOpencodeChatPipelineIntentGateway(
  workspaceKey: string,
): Promise<ChatPipelineIntentModelGateway> {
  const client = await getOpencodeV2Client(workspaceKey);
  return {
    async createSession() {
      const session = await unwrap(
        client.session.create({
          title: 'Tagma pipeline intent classification',
          metadata: buildTagmaSessionMetadata({
            source: 'pipeline-intent-classifier',
            workspacePath: workspaceKey,
            reason: 'pre-binding-semantic-route',
          }),
        }),
      );
      return session.id;
    },
    async prompt(sessionId, request) {
      const response = await unwrap(
        client.session.prompt(
          {
            sessionID: sessionId,
            model: request.model,
            agent: request.agent,
            ...(request.variant ? { variant: request.variant } : {}),
            tools: { '*': false },
            format: {
              type: 'json_schema',
              schema: request.schema,
              retryCount: 2,
            },
            system: request.system,
            parts: [{ type: 'text', text: request.user }],
          },
          {
            signal: AbortSignal.timeout(PIPELINE_INTENT_CLASSIFICATION_TIMEOUT_MS),
          },
        ),
      );
      if (response.info.error) {
        throw new Error('The pipeline intent classifier model request failed.');
      }
      return response.info.structured;
    },
    async deleteSession(sessionId) {
      await unwrap(client.session.delete({ sessionID: sessionId }));
    },
  };
}

/**
 * Run semantic routing in a temporary, tool-free model session. The session is
 * deleted even when schema parsing fails so classifiers never enter Chat
 * history or become mutable pipeline owners.
 */
export async function classifyChatPipelineIntentWithModel(
  input: ClassifyChatPipelineIntentInput,
  gateway: ChatPipelineIntentModelGateway,
): Promise<ResolvedChatPipelineIntent> {
  const prompt = buildChatPipelineIntentClassificationPrompt(input.userText, input.candidates);
  const sessionId = await gateway.createSession();
  try {
    const structured = await gateway.prompt(sessionId, {
      agent: TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT,
      model: input.model,
      variant: input.variant,
      system: prompt.system,
      user: prompt.user,
      schema: prompt.schema,
    });
    return resolveStructuredChatPipelineIntent(structured, input.candidates);
  } finally {
    await gateway.deleteSession(sessionId).catch(() => undefined);
  }
}
