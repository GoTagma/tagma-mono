import type express from 'express';

import { CHAT_OPERATION_V2_PROTOCOL_VERSION } from '../chat-operations/types.js';
import { requireWorkspace } from '../require-workspace.js';

const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

export interface ChatOperationV2ControlResetAction {
  reset(input: {
    readonly workDir: string;
    readonly clientRequestId: string;
    readonly confirmation: string;
  }): unknown;
}

export type ChatOperationV2ControlRouteOptions =
  | { readonly enabled: true; readonly action: ChatOperationV2ControlResetAction }
  | { readonly enabled?: false };

function exactRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const expected = ['clientRequestId', 'confirmation', 'protocolVersion'].sort();
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.length !== expected.length ||
      (keys as string[]).sort().some((key, index) => key !== expected[index]) ||
      (keys as string[]).some((key) => {
        const descriptor = descriptors[key];
        return (
          !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        );
      })
    ) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function registerChatOperationV2ControlRoutes(
  app: express.Express,
  options: ChatOperationV2ControlRouteOptions,
): void {
  if (options.enabled !== true) return;
  app.post('/api/chat/control/reset', (req, res) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace?.workDir) return;
    const body = exactRecord(req.body);
    if (body?.protocolVersion !== CHAT_OPERATION_V2_PROTOCOL_VERSION) {
      return res.status(body && 'protocolVersion' in body ? 426 : 400).json({
        protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
        code:
          body && 'protocolVersion' in body
            ? 'chat_operation_protocol_mismatch'
            : 'chat_operation_invalid_request',
        kind:
          body && 'protocolVersion' in body
            ? 'chat_operation_protocol_mismatch'
            : 'chat_operation_invalid_request',
        problem:
          body && 'protocolVersion' in body ? 'unsupported_protocol_version' : 'invalid_shape',
        error:
          body && 'protocolVersion' in body
            ? 'Chat Operation API protocol version 2 is required.'
            : 'Chat control reset request is invalid.',
      });
    }
    if (
      typeof body.clientRequestId !== 'string' ||
      !HOST_ID.test(body.clientRequestId) ||
      typeof body.confirmation !== 'string'
    ) {
      return res.status(400).json({
        protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
        code: 'chat_operation_invalid_request',
        kind: 'chat_operation_invalid_request',
        problem: 'invalid_content',
        error: 'Chat control reset request is invalid.',
      });
    }
    try {
      const result = options.action.reset({
        workDir: workspace.workDir,
        clientRequestId: body.clientRequestId,
        confirmation: body.confirmation,
      });
      return res.json({ protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION, result });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
      const confirmation = code === 'reset_confirmation_required';
      const busy = code === 'migration_busy' || code === 'offline_migration_busy';
      return res.status(confirmation ? 400 : busy ? 409 : 500).json({
        protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
        kind: confirmation
          ? 'chat_operation_invalid_request'
          : busy
            ? 'chat_operation_conflict'
            : 'chat_operation_mutation_failed',
        error: confirmation
          ? 'The exact Chat control reset confirmation is required.'
          : busy
            ? 'Chat control state is busy.'
            : 'Chat control reset failed.',
      });
    }
  });
}
