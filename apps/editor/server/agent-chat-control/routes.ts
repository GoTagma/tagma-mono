import express, { type Request, type Response, type NextFunction } from 'express';
import { isAbsolute } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { normalizeWorkspaceKey } from '@tagma/types/workspace-key';
import { ALLOWED_ORIGINS } from '../allowed-origins.js';
import {
  AGENT_CHAT_COMMAND_DEFINITIONS,
  AGENT_CHAT_CONTROL_BASE_PATH,
  AGENT_CHAT_CONTROL_MAX_COMMAND_BYTES,
  AGENT_CHAT_CONTROL_MAX_REPORT_BYTES,
  parseAgentChatCommand,
  type AgentChatIdentityProof,
  type AgentChatRendererReport,
} from '../../shared/agent-chat-control.js';
import {
  AgentChatControlError,
  type AgentChatControlHost,
  type AgentChatControlSession,
} from './host.js';

export function isAgentChatPublicPath(path: string): boolean {
  return (
    path === AGENT_CHAT_CONTROL_BASE_PATH || path.startsWith(`${AGENT_CHAT_CONTROL_BASE_PATH}/`)
  );
}
export function isAgentChatExternalBearer(header: string | undefined): boolean {
  return header?.startsWith('Bearer ac1_') === true;
}
function failure(code: string, status = 400): never {
  throw new AgentChatControlError(code, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('invalid_request');
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const input = object(value);
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    failure('invalid_request');
  return input;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0'))
    failure('invalid_request');
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) failure('invalid_request');
  return Number(value);
}
function proof(value: unknown): AgentChatIdentityProof {
  const input = fields(value, [
    'rendererInstanceId',
    'conversationId',
    'conversationKey',
    'operationId',
  ]);
  const conversationKey = text(input.conversationKey, 64);
  if (!/^[a-f0-9]{64}$/.test(conversationKey)) failure('invalid_conversation_proof');
  return {
    rendererInstanceId: text(input.rendererInstanceId),
    conversationId: text(input.conversationId),
    conversationKey,
    operationId: input.operationId === null ? null : text(input.operationId),
  };
}
function report(value: unknown): AgentChatRendererReport | null {
  if (value === null) return null;
  const input = fields(value, ['sequence', 'conversationId', 'operationId', 'view']);
  return {
    sequence: count(input.sequence),
    conversationId: input.conversationId === null ? null : text(input.conversationId),
    operationId: input.operationId === null ? null : text(input.operationId),
    view: object(input.view),
  };
}
function workspace(req: Request): string {
  const value = text(req.get('X-Tagma-Workspace'), 4096);
  if (!isAbsolute(value)) failure('workspace_required');
  return normalizeWorkspaceKey(value);
}
function origin(req: Request): string {
  return `http://127.0.0.1:${req.socket.localPort}`;
}
function loopback(req: Request, _res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress ?? '';
  if (!(
    remote === '::1' ||
    /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(remote) ||
    remote === '::ffff:127.0.0.1'
  ))
    failure('loopback_required', 403);
  let hostname: string;
  try {
    hostname = new URL(`http://${req.get('host') ?? ''}`).hostname;
  } catch {
    return failure('invalid_host', 403);
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) failure('invalid_host', 403);
  const suppliedOrigin = req.get('origin');
  if (suppliedOrigin && suppliedOrigin !== origin(req) && !ALLOWED_ORIGINS.has(suppliedOrigin))
    failure('origin_denied', 403);
  next();
}
function errorResponse(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const parserType = error && typeof error === 'object' && 'type' in error ? error.type : null;
  if (parserType === 'entity.parse.failed' || parserType === 'entity.too.large') {
    const code = parserType === 'entity.too.large' ? 'request_too_large' : 'invalid_json';
    res
      .status(parserType === 'entity.too.large' ? 413 : 400)
      .json({ protocolVersion: 1, error: code, kind: code });
    return;
  }
  const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const code =
    error instanceof AgentChatControlError
      ? error.code
      : /^[a-z][a-z0-9_]{0,80}$/.test(rawCode)
        ? rawCode
        : 'control_unavailable';
  const status =
    error instanceof AgentChatControlError
      ? error.status
      : /integrity|schema|closed/.test(code)
        ? 503
        : /authority|scope|grant/.test(code)
          ? 403
          : /conflict/.test(code)
            ? 409
            : 500;
  res.status(status).json({ protocolVersion: 1, error: code, kind: code });
}

/** Mount before the general workspace/revision middleware. Control requests never mutate YAML. */
export function registerAgentChatControlRoutes(
  app: express.Express,
  host: AgentChatControlHost | null,
  options: { managementToken: string },
): void {
  const requireHost = (): AgentChatControlHost => host ?? failure('control_unavailable', 503);
  const publicApi = express.Router();
  publicApi.use(loopback);
  publicApi.use((req, res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) failure('unauthorized', 401);
    const session = requireHost().authenticate(header.slice(7));
    const suppliedWorkspace = req.get('X-Tagma-Workspace') ?? req.query.ws;
    if (
      suppliedWorkspace !== undefined &&
      (typeof suppliedWorkspace !== 'string' ||
        normalizeWorkspaceKey(suppliedWorkspace) !== session.workspace)
    )
      failure('workspace_mismatch', 403);
    res.locals.agentSession = session;
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const session = (res: Response) => res.locals.agentSession as AgentChatControlSession;
  publicApi.use(express.json({ limit: AGENT_CHAT_CONTROL_MAX_COMMAND_BYTES }));
  publicApi.get('/manifest', (_req, res) =>
    res.json({
      name: 'Chat Control API',
      protocolVersion: 1,
      basePath: AGENT_CHAT_CONTROL_BASE_PATH,
      commands: AGENT_CHAT_COMMAND_DEFINITIONS,
      commandEnvelope: {
        required: ['requestId', 'conversationId', 'grantVersion', 'type', 'parameters'],
        additionalProperties: false,
        requestId:
          '1–128 ASCII letters, digits, dot, underscore, colon or hyphen; first character alphanumeric',
        grantVersion:
          'Positive integer from the current conversation grant; use controllerVersion for conversation.create',
        parameters: 'Every declared parameter is required; undeclared fields are rejected',
      },
      limits: {
        commandBytes: AGENT_CHAT_CONTROL_MAX_COMMAND_BYTES,
        reportBytes: AGENT_CHAT_CONTROL_MAX_REPORT_BYTES,
      },
      endpoints: [
        'GET /manifest',
        'GET /state',
        'GET /conversations',
        'POST /commands',
        'GET /commands/:id',
        'GET /events?after=0',
      ],
      semantics: {
        editorRequired: true,
        diagnosticsRequired: false,
        grantRequiredForExistingConversations: true,
        idempotency:
          'Reuse the exact requestId and body. Unknown commands are retained, never blindly replayed.',
        results:
          'Command execution, Host state and committed renderer observations are independent evidence.',
      },
    }),
  );
  publicApi.get('/state', (_req, res) => res.json(requireHost().state(session(res))));
  publicApi.get('/conversations', (_req, res) =>
    res.json({
      conversations: requireHost()
        .state(session(res))
        .grants.filter((grant) => grant.status === 'active'),
    }),
  );
  publicApi.post('/commands', (req, res) => {
    let command;
    try {
      command = parseAgentChatCommand(req.body);
    } catch {
      return failure('invalid_command');
    }
    const receipt = requireHost().submit(session(res), command);
    res.status(202).json({
      protocolVersion: 1,
      receipt: requireHost().command(session(res), receipt.commandId),
    });
  });
  publicApi.get('/commands/:id', (req, res) =>
    res.json({
      protocolVersion: 1,
      receipt: requireHost().command(session(res), text(req.params.id)),
    }),
  );
  publicApi.get('/events', (req, res) => {
    const after = req.query.after ?? '0';
    if (typeof after !== 'string' || !/^(0|[1-9]\d*)$/.test(after)) failure('invalid_cursor');
    res.json({ protocolVersion: 1, ...requireHost().events(session(res), count(Number(after))) });
  });
  publicApi.use((_req, _res) => failure('route_not_found', 404));
  publicApi.use(errorResponse);
  app.use(AGENT_CHAT_CONTROL_BASE_PATH, publicApi);

  const managed = express.Router();
  managed.use(loopback);
  managed.use((req, res, next) => {
    const header = req.get('authorization') ?? '';
    if (options.managementToken) {
      const actual = Buffer.from(header);
      const expected = Buffer.from(`Bearer ${options.managementToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        failure('management_unauthorized', 401);
    } else if (isAgentChatExternalBearer(header)) failure('management_unauthorized', 401);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  managed.use(express.json({ limit: '5mb' }));
  managed.get('/control/status', (req, res) =>
    res.json(
      host
        ? host.status(workspace(req), text(req.query.rendererInstanceId))
        : { enabled: false, reason: 'control_unavailable' },
    ),
  );
  managed.post('/control/enable', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId']);
    res.json(requireHost().enable(workspace(req), text(input.rendererInstanceId)));
  });
  managed.post('/control/disable', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId']);
    requireHost().disable(workspace(req), text(input.rendererInstanceId));
    res.json({ enabled: false });
  });
  managed.post('/control/instructions', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId']);
    res.json({
      instructions: requireHost().instructions(
        workspace(req),
        text(input.rendererInstanceId),
        origin(req),
      ),
    });
  });
  managed.post('/control/grant', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId', 'proof', 'permissionChoices']);
    if (
      !Array.isArray(input.permissionChoices) ||
      input.permissionChoices.length > 3 ||
      input.permissionChoices.some(
        (choice) => !['once', 'always', 'reject'].includes(String(choice)),
      )
    )
      failure('invalid_permission_scope');
    res.json({
      grant: requireHost().grant(
        workspace(req),
        text(input.rendererInstanceId),
        proof(input.proof),
        input.permissionChoices as ('once' | 'always' | 'reject')[],
      ),
    });
  });
  managed.post('/control/revoke', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId', 'grantId', 'version']);
    requireHost().revoke(
      workspace(req),
      text(input.rendererInstanceId),
      text(input.grantId),
      count(input.version),
    );
    res.json({ revoked: true });
  });
  managed.post('/renderer/connect', (req, res) => {
    const input = fields(req.body, ['rendererInstanceId', 'pageId', 'proofs']);
    if (!Array.isArray(input.proofs) || input.proofs.length > 200) failure('invalid_proofs');
    res.json(
      requireHost().connect(
        workspace(req),
        text(input.rendererInstanceId),
        text(input.pageId),
        input.proofs.map(proof),
      ),
    );
  });
  managed.post('/renderer/poll', (req, res) => {
    const input = fields(req.body, ['controllerId', 'connectionId', 'secret', 'report']);
    res.json(
      requireHost().poll(
        workspace(req),
        text(input.controllerId),
        text(input.connectionId),
        text(input.secret),
        report(input.report),
      ),
    );
  });
  managed.post('/renderer/claim', (req, res) => {
    const input = fields(req.body, ['controllerId', 'connectionId', 'secret', 'commandId']);
    res.json(
      requireHost().claim(
        workspace(req),
        text(input.controllerId),
        text(input.connectionId),
        text(input.secret),
        text(input.commandId),
      ),
    );
  });
  managed.post('/renderer/finish', (req, res) => {
    const input = fields(req.body, [
      'controllerId',
      'connectionId',
      'secret',
      'commandId',
      'result',
      'proof',
    ]);
    const result = object(input.result);
    if (typeof result.executed !== 'boolean') failure('invalid_result');
    requireHost().finish(
      workspace(req),
      text(input.controllerId),
      text(input.connectionId),
      text(input.secret),
      text(input.commandId),
      result as { executed: boolean; [key: string]: unknown },
      input.proof === null ? null : proof(input.proof),
    );
    res.json({ acknowledged: true });
  });
  managed.use((_req, _res) => failure('route_not_found', 404));
  managed.use(errorResponse);
  app.use('/api/agent-chat', managed);
}
