import type express from 'express';

export const CHAT_OPERATION_V2_LEGACY_STAGE_PREFIX = '/api/workspace/chat-yaml-stage';

export function registerChatOperationV2LegacyStageFence(app: express.Express): void {
  app.use(CHAT_OPERATION_V2_LEGACY_STAGE_PREFIX, (_req, res) =>
    res.status(426).json({
      error: 'Renderer-owned Chat YAML staging is unavailable. Use Chat Operation V2.',
      requiredProtocolVersion: 2,
    }),
  );
}
