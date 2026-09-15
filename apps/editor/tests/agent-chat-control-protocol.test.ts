import { expect, test } from 'bun:test';
import {
  AGENT_CHAT_COMMAND_DEFINITIONS,
  parseAgentChatCommand,
  canonicalAgentChatCommand,
} from '../shared/agent-chat-control';

const submit = {
  requestId: 'request-1',
  conversationId: 'conversation',
  grantVersion: 3,
  type: 'composer.submit',
  parameters: {},
} as const;

test('strict commands retain request and grant identity and canonicalize property order', () => {
  expect(parseAgentChatCommand(submit)).toEqual(submit);
  const reordered = {
    parameters: {},
    type: 'composer.submit',
    grantVersion: 3,
    conversationId: 'conversation',
    requestId: 'request-1',
  };
  expect(canonicalAgentChatCommand(parseAgentChatCommand(reordered))).toBe(
    canonicalAgentChatCommand(parseAgentChatCommand(submit)),
  );
});

test.each([
  { ...submit, script: 'run anything' },
  { ...submit, type: 'eval' },
  { ...submit, parameters: { text: 'bypass Composer' } },
  { ...submit, conversationId: null },
  { ...submit, grantVersion: 0 },
  { ...submit, grantVersion: 1.5 },
  { ...submit, requestId: 'x'.repeat(129) },
  { ...submit, parameters: [] },
])('rejects unknown fields, operations and malformed authority %j', (value) => {
  expect(() => parseAgentChatCommand(value)).toThrow();
});

test('conversation creation is explicitly controller scoped; other operations are conversation scoped', () => {
  expect(
    parseAgentChatCommand({ ...submit, type: 'conversation.create', conversationId: null }).type,
  ).toBe('conversation.create');
  expect(() => parseAgentChatCommand({ ...submit, type: 'conversation.create' })).toThrow();
  expect(AGENT_CHAT_COMMAND_DEFINITIONS['permission.reply'].scope).toBe('conversation');
});

test('parameters use bounded UTF-8 and exact enums, including explicit discard decisions', () => {
  expect(() =>
    parseAgentChatCommand({
      ...submit,
      type: 'permission.reply',
      parameters: {
        operationId: 'op',
        requestId: 'permission',
        choice: 'approve_all_future',
      },
    }),
  ).toThrow();
  expect(() =>
    parseAgentChatCommand({
      ...submit,
      type: 'question.reply',
      parameters: {
        operationId: 'op',
        requestId: 'question',
        choice: 'reply',
        answers: ['界'.repeat(100)],
      },
    }),
  ).toThrow();
  expect(
    parseAgentChatCommand({ ...submit, type: 'draft.close', parameters: { discardChanges: false } })
      .parameters,
  ).toEqual({ discardChanges: false });
  expect(() => parseAgentChatCommand({ ...submit, type: 'draft.close', parameters: {} })).toThrow();
});

test('the manifest describes every field accepted by every command', () => {
  for (const [type, definition] of Object.entries(AGENT_CHAT_COMMAND_DEFINITIONS)) {
    const parameters = Object.fromEntries(
      Object.entries(definition.parameters).map(([key, schema]) => {
        const value =
          schema.type === 'string'
            ? 'enum' in schema
              ? schema.enum[0]
              : 'sample'
            : schema.type === 'boolean'
              ? false
              : schema.type === 'array'
                ? []
                : null;
        return [key, value];
      }),
    );
    expect(
      String(
        parseAgentChatCommand({
          ...submit,
          type,
          parameters,
          conversationId: definition.scope === 'controller' ? null : submit.conversationId,
        }).type,
      ),
    ).toBe(type);
  }
});
