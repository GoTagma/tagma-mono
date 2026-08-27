import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CHAT_OPERATION_V2_LEGACY_STAGE_PREFIX,
  registerChatOperationV2LegacyStageFence,
} from '../server/chat-operations/legacy-stage-fence.js';

describe('Chat Operation V2 legacy renderer staging fence', () => {
  test('rejects the entire old renderer staging subtree with HTTP 426', () => {
    type Handler = (req: unknown, res: ReturnType<typeof response>) => unknown;
    const registration: { prefix?: string; handler?: Handler } = {};
    const app = {
      use(registeredPrefix: string, registeredHandler: Handler) {
        registration.prefix = registeredPrefix;
        registration.handler = registeredHandler;
        return app;
      },
    };
    registerChatOperationV2LegacyStageFence(app as never);

    const res = response();
    const invoke = registration.handler;
    if (!invoke) throw new Error('legacy staging fence was not registered');
    invoke({}, res);

    expect(registration.prefix).toBe(CHAT_OPERATION_V2_LEGACY_STAGE_PREFIX);
    expect(res.statusCode).toBe(426);
    expect(res.body).toEqual({
      error: 'Renderer-owned Chat YAML staging is unavailable. Use Chat Operation V2.',
      requiredProtocolVersion: 2,
    });
  });

  test('renderer API exposes no legacy staging or finalize client', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'client.ts'), 'utf8');

    expect(source).not.toContain("'/workspace/chat-yaml-stage/");
    expect(source).not.toContain('finalizeChatYamlStage:');
    expect(source).not.toContain('startChatYamlStage:');
  });
});

function response() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
