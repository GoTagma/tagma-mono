import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import {
  CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES,
  CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
} from './api-requests.js';

export const CHAT_OPERATION_V2_HTTP_BASE_PATH = '/api/chat/operations';
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Shadow readers must not fall through to a 404 or legacy mutation path.
 * Install this before any JSON parser so even oversized old-client mutation
 * bodies receive the exact versioned 426 without touching service authority.
 */
export function registerChatOperationV2MutationFence(app: express.Express, enabled: boolean): void {
  if (!enabled) return;
  app.use(CHAT_OPERATION_V2_HTTP_BASE_PATH, (req, res, next) => {
    if (!MUTATION_METHODS.has(req.method.toUpperCase())) return next();
    return res.status(426).json({
      protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
      code: 'chat_operation_protocol_mismatch',
      kind: 'chat_operation_protocol_mismatch',
      problem: 'unsupported_protocol_version',
      error: 'Chat Operation API mutations require an activated V2 mutation surface.',
    });
  });
}

function bodyParserProblem(error: unknown): 'size_limit_exceeded' | 'invalid_shape' {
  try {
    return typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
      ? 'size_limit_exceeded'
      : 'invalid_shape';
  } catch {
    return 'invalid_shape';
  }
}

/**
 * Installs the V2 body parser before the repository's narrower global parser.
 * Disabled mode registers nothing, preserving the exact opt-in boundary.
 */
export function registerChatOperationV2BodyParser(
  app: express.Express,
  enabled: boolean,
  maxRequestBytes = CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES,
): void {
  if (!enabled) return;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new RangeError('Chat Operation V2 request byte limit must be a positive integer.');
  }
  app.use(
    CHAT_OPERATION_V2_HTTP_BASE_PATH,
    express.json({ limit: maxRequestBytes, strict: true }),
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const problem = bodyParserProblem(error);
      res.status(400).json({
        protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
        code: 'chat_operation_invalid_request',
        kind: 'chat_operation_invalid_request',
        problem,
        error:
          problem === 'size_limit_exceeded'
            ? 'Chat Operation API request exceeds its byte limit.'
            : 'Chat Operation API request body must be valid JSON.',
      });
    },
  );
}
