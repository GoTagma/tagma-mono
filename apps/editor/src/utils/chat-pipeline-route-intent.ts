import type { OpencodeThreadEntry } from '../api/opencode-chat';
import type { ChatPipelineRouteIntent } from '../../shared/requested-action.js';

const PIPELINE_AGENT = 'tagma-pipeline';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function routeModeFromPrompt(
  prompt: unknown,
  stageId: string,
): ChatPipelineRouteIntent | 'invalid' | null {
  if (typeof prompt !== 'string') return null;
  const marker = `TAGMA_ROUTE_MODE: ${stageId}`;
  const firstLine = prompt.split(/\r?\n/, 1)[0];
  if (firstLine === `${marker} create`) return 'create';
  if (firstLine === `${marker} edit`) return 'edit';
  return prompt.includes(marker) ? 'invalid' : null;
}

function pipelineHandoffPrompt(part: unknown): string | null {
  const item = record(part);
  if (!item) return null;
  if (item.type === 'subtask') {
    return item.agent === PIPELINE_AGENT && typeof item.prompt === 'string' ? item.prompt : null;
  }
  if (item.type !== 'tool' || item.tool !== 'task') return null;
  const input = record(record(item.state)?.input);
  if (!input) return null;
  const agent = input.subagent_type ?? input.agent;
  return agent === PIPELINE_AGENT && typeof input.prompt === 'string' ? input.prompt : null;
}

/**
 * Resolve the router's stage-bound target declaration from OpenCode's durable
 * task/subtask parts. A missing, malformed, or conflicting declaration fails
 * closed as null; callers must never infer semantic create intent from phrases.
 */
export function resolveChatPipelineRouteIntent(
  messages: readonly OpencodeThreadEntry[],
  stageId: string,
): ChatPipelineRouteIntent | null {
  if (!stageId.trim()) return null;
  const modes = new Set<ChatPipelineRouteIntent>();
  for (const message of messages) {
    for (const part of message.parts) {
      const prompt = pipelineHandoffPrompt(part);
      if (!prompt) continue;
      const mode = routeModeFromPrompt(prompt, stageId);
      if (mode === 'invalid') return null;
      if (mode) modes.add(mode);
    }
  }
  return modes.size === 1 ? ([...modes][0] ?? null) : null;
}
