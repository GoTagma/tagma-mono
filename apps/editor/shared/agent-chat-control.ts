/** Public control transport. Product behavior belongs to renderer Chat actions and the V2 Host. */
export const AGENT_CHAT_CONTROL_PROTOCOL_VERSION = 1;
export const AGENT_CHAT_CONTROL_BASE_PATH = '/api/agent-chat/v1';
export const AGENT_CHAT_CONTROL_MAX_COMMAND_BYTES = 2 * 1024 * 1024;
export const AGENT_CHAT_CONTROL_MAX_REPORT_BYTES = 4 * 1024 * 1024;

export interface AgentChatIdentityProof {
  rendererInstanceId: string;
  conversationId: string;
  conversationKey: string;
  operationId: string | null;
}

/** Observations are evidence only; they never authorize a Host mutation. */
export interface AgentChatRendererReport {
  sequence: number;
  conversationId: string | null;
  operationId: string | null;
  view: Readonly<Record<string, unknown>>;
}

export interface AgentChatPublicGrant {
  grantId: string;
  conversationId: string;
  version: number;
  status: 'active' | 'revoked';
  permissionChoices: readonly ('once' | 'always' | 'reject')[];
  reauthenticated: boolean;
}
export type AgentChatControlStatus =
  | { enabled: false; reason?: string }
  | {
      enabled: true;
      workspace: string;
      controllerId: string;
      controllerVersion: number;
      expiresAt: number;
      connected: boolean;
      grants: AgentChatPublicGrant[];
    };
export interface AgentChatRendererConnection {
  protocolVersion: 1;
  connectionId: string;
  secret: string;
  nextSequence: number;
  grants: AgentChatPublicGrant[];
}
export interface AgentChatCommandDelivery {
  commandId: string;
  command: AgentChatCommand;
}
export interface AgentChatRendererPoll {
  protocolVersion: 1;
  commands: AgentChatCommandDelivery[];
  grants: AgentChatPublicGrant[];
}

export function agentChatHostRequestId(commandId: string): string {
  return `agent-chat:${commandId}`;
}

type Operation = { operationId: string };
type Request = Operation & { requestId: string };
export interface AgentChatCommandParameters {
  'conversation.create': Record<string, never>;
  'conversation.select': { operationId: string };
  'conversation.read': Record<string, never>;
  'composer.edit': { text: string };
  'composer.submit': Record<string, never>;
  'attachment.add': { label: string; content: string };
  'attachment.remove': { attachmentId: string };
  'model.select': { providerId: string; modelId: string };
  'model.variant': { variant: string | null };
  'context.select': { candidateId: string; discardChanges: boolean };
  'clarification.reply': Request & { candidateId: string };
  'question.reply': Request & { choice: 'reply' | 'reject'; answers: string[] };
  'permission.reply': Request & { choice: 'once' | 'always' | 'reject' };
  'interaction.recover': Request & {
    choice:
      'retry_new_invocation' | 'repair_new_invocation' | 'fail_operation' | 'discard_operation';
  };
  'operation.stop': Operation;
  'operation.retry': Operation;
  'operation.discard': Operation & { confirmed: boolean };
  'draft.open': Record<string, never>;
  'draft.read': Record<string, never>;
  'draft.select': { fileId: string; discardChanges: boolean };
  'draft.edit': { text: string };
  'draft.save': Record<string, never>;
  'draft.close': { discardChanges: boolean };
  'result.read': Record<string, never>;
}
export type AgentChatCommandType = keyof AgentChatCommandParameters;
export type AgentChatCommand = {
  [K in AgentChatCommandType]: {
    requestId: string;
    conversationId: string | null;
    grantVersion: number;
    type: K;
    parameters: AgentChatCommandParameters[K];
  };
}[AgentChatCommandType];

export type AgentChatParameterSchema =
  | {
      readonly type: 'string';
      readonly maxBytes: number;
      readonly minBytes?: number;
      readonly nullable?: boolean;
      readonly enum?: readonly string[];
    }
  | { readonly type: 'boolean' }
  | { readonly type: 'array'; readonly maxItems: number; readonly items: AgentChatParameterSchema };

const text = (maxBytes: number): AgentChatParameterSchema => ({ type: 'string', maxBytes });
const id: AgentChatParameterSchema = { type: 'string', minBytes: 1, maxBytes: 128 };
const decision: AgentChatParameterSchema = { type: 'boolean' };
const operation = { operationId: id };
const request = { ...operation, requestId: id };
const choice = (...values: string[]): AgentChatParameterSchema => ({
  type: 'string',
  maxBytes: 64,
  enum: values,
});

/** This exact registry is returned in the manifest and used to reject unknown parameters. */
export const AGENT_CHAT_COMMAND_DEFINITIONS = {
  'conversation.create': { scope: 'controller', parameters: {} },
  'conversation.select': { scope: 'conversation', parameters: operation },
  'conversation.read': { scope: 'conversation', parameters: {} },
  'composer.edit': { scope: 'conversation', parameters: { text: text(1024 * 1024) } },
  'composer.submit': { scope: 'conversation', parameters: {} },
  'attachment.add': {
    scope: 'conversation',
    parameters: { label: text(4096), content: text(1024 * 1024) },
  },
  'attachment.remove': { scope: 'conversation', parameters: { attachmentId: id } },
  'model.select': { scope: 'conversation', parameters: { providerId: id, modelId: id } },
  'model.variant': {
    scope: 'conversation',
    parameters: { variant: { type: 'string', maxBytes: 128, nullable: true } },
  },
  'context.select': {
    scope: 'conversation',
    parameters: { candidateId: id, discardChanges: decision },
  },
  'clarification.reply': { scope: 'conversation', parameters: { ...request, candidateId: id } },
  'question.reply': {
    scope: 'conversation',
    parameters: {
      ...request,
      choice: choice('reply', 'reject'),
      answers: { type: 'array', maxItems: 32, items: text(256) },
    },
  },
  'permission.reply': {
    scope: 'conversation',
    parameters: { ...request, choice: choice('once', 'always', 'reject') },
  },
  'interaction.recover': {
    scope: 'conversation',
    parameters: {
      ...request,
      choice: choice(
        'retry_new_invocation',
        'repair_new_invocation',
        'fail_operation',
        'discard_operation',
      ),
    },
  },
  'operation.stop': { scope: 'conversation', parameters: operation },
  'operation.retry': { scope: 'conversation', parameters: operation },
  'operation.discard': { scope: 'conversation', parameters: { ...operation, confirmed: decision } },
  'draft.open': { scope: 'conversation', parameters: {} },
  'draft.read': { scope: 'conversation', parameters: {} },
  'draft.select': { scope: 'conversation', parameters: { fileId: id, discardChanges: decision } },
  'draft.edit': { scope: 'conversation', parameters: { text: text(1024 * 1024) } },
  'draft.save': { scope: 'conversation', parameters: {} },
  'draft.close': { scope: 'conversation', parameters: { discardChanges: decision } },
  'result.read': { scope: 'conversation', parameters: {} },
} as const satisfies {
  [K in AgentChatCommandType]: {
    scope: 'controller' | 'conversation';
    parameters: Record<keyof AgentChatCommandParameters[K], AgentChatParameterSchema>;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
function validParameter(value: unknown, schema: AgentChatParameterSchema): boolean {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return (
        Array.isArray(value) &&
        value.length <= schema.maxItems &&
        value.every((item) => validParameter(item, schema.items))
      );
    case 'string': {
      if (value === null) return schema.nullable === true;
      if (typeof value !== 'string') return false;
      const bytes = new TextEncoder().encode(value).length;
      return (
        bytes >= (schema.minBytes ?? 0) &&
        bytes <= schema.maxBytes &&
        (!schema.enum || schema.enum.includes(value))
      );
    }
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function canonicalAgentChatCommand(command: AgentChatCommand): string {
  return canonical(command);
}

export function parseAgentChatCommand(value: unknown): AgentChatCommand {
  if (
    !record(value) ||
    !exactKeys(value, ['requestId', 'conversationId', 'grantVersion', 'type', 'parameters']) ||
    typeof value.requestId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId) ||
    !Number.isSafeInteger(value.grantVersion) ||
    Number(value.grantVersion) < 1 ||
    typeof value.type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(AGENT_CHAT_COMMAND_DEFINITIONS, value.type)
  )
    throw new Error('Invalid Chat Control command envelope.');
  const definition = AGENT_CHAT_COMMAND_DEFINITIONS[value.type as AgentChatCommandType];
  if (
    definition.scope === 'controller'
      ? value.conversationId !== null
      : !validParameter(value.conversationId, id)
  )
    throw new Error('Chat Control command has invalid conversation scope.');
  if (!record(value.parameters) || !exactKeys(value.parameters, Object.keys(definition.parameters)))
    throw new Error('Chat Control command has unexpected parameters.');
  for (const [key, schema] of Object.entries(definition.parameters)) {
    if (!validParameter(value.parameters[key], schema))
      throw new Error(`Invalid Chat Control parameter: ${key}.`);
  }
  const bytes = canonical(value);
  if (new TextEncoder().encode(bytes).length > AGENT_CHAT_CONTROL_MAX_COMMAND_BYTES)
    throw new Error('Chat Control command exceeds the byte limit.');
  return JSON.parse(bytes) as AgentChatCommand;
}
