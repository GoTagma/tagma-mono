import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/client';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBotPromptAsyncBody,
  createAssistantPartGate,
  createLoopbackOpencodeClient,
  describeOpencodeSessionError,
} from '../server/chat-bridge/opencode-driver';
import { workspaceRegistry } from '../server/workspace-registry';

const userInfo = (id: string): Message =>
  ({
    id,
    sessionID: 's1',
    role: 'user',
    time: { created: Date.now() },
    agent: 'tagma',
    model: { providerID: 'test', modelID: 'test' },
  }) as Message;

const assistantInfo = (id: string): Message =>
  ({
    id,
    sessionID: 's1',
    role: 'assistant',
    time: { created: Date.now() },
    parentID: '',
    modelID: 'test',
    providerID: 'test',
    mode: '',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as Message;

const textPart = (messageID: string, text: string): Part =>
  ({
    id: `part-${messageID}`,
    sessionID: 's1',
    messageID,
    type: 'text',
    text,
  }) as Part;

describe('opencode-driver assistant part gate', () => {
  test('drops user prompt parts so editor-context is never rendered back to the bot', () => {
    const gate = createAssistantPartGate();
    gate.observeMessage(userInfo('user-message'));

    const delivered = gate.observePart(
      textPart(
        'user-message',
        '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\nhi',
      ),
    );

    expect(delivered).toEqual([]);
  });

  test('renders safe orphan assistant parts without waiting for the envelope', () => {
    const gate = createAssistantPartGate();
    const part = textPart('assistant-message', 'real assistant answer');

    expect(gate.observePart(part)).toEqual([part]);
    expect(gate.observeMessage(assistantInfo('assistant-message'))).toEqual([]);
  });

  test('does not render orphan bridge prompt parts before their user envelope', () => {
    const gate = createAssistantPartGate();
    const part = textPart(
      'user-message',
      '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\nhi',
    );

    expect(gate.observePart(part)).toEqual([]);
    expect(gate.observeMessage(userInfo('user-message'))).toEqual([]);
  });
});

describe('opencode-driver loopback client', () => {
  test('routes event.subscribe through loopback fetch instead of global fetch', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== '/event')
          return new Response('not found', { status: 404 });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } })}\n\n`,
              ),
            );
            await gate;
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const originalFetch = globalThis.fetch;
    try {
      const client = createLoopbackOpencodeClient(server.url.href);
      globalThis.fetch = (() =>
        Promise.reject(new Error('global fetch should not be used'))) as unknown as typeof fetch;

      const { stream } = await client.event.subscribe();
      const first = await Promise.race([
        stream.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('event.subscribe did not yield loopback SSE')), 1000),
        ),
      ]);

      expect(first.done).toBe(false);
      expect(first.value).toEqual({ type: 'session.idle', properties: { sessionID: 's1' } });
      await stream.return(undefined);
    } finally {
      globalThis.fetch = originalFetch;
      release();
      server.stop(true);
    }
  });
});

describe('opencode-driver session error formatting', () => {
  test('uses APIError data payload instead of only the generic error name', () => {
    expect(
      describeOpencodeSessionError({
        name: 'APIError',
        data: { statusCode: 429, message: 'rate limit exceeded' },
      }),
    ).toBe('APIError 429: rate limit exceeded');
  });
});

describe('opencode-driver bot prompt body', () => {
  test('uses the persisted editor chat model for remote bot turns', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-model-'));
    try {
      workspaceRegistry.getOrCreate(workDir);
      mkdirSync(join(workDir, '.tagma'), { recursive: true });
      writeFileSync(
        join(workDir, '.tagma', 'editor-settings.json'),
        JSON.stringify({
          opencodeChatModel: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4.5' },
        }),
      );

      const body = buildBotPromptAsyncBody(workDir, 'hello from slack');

      expect(body.model).toEqual({
        providerID: 'openrouter',
        modelID: 'anthropic/claude-sonnet-4.5',
      });
      expect(body.agent).toBe('tagma-router');
      expect(body.parts[0]?.text).toContain('hello from slack');
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('includes workspace yaml folder entries for remote bot turns', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-yamls-'));
    try {
      const ws = workspaceRegistry.getOrCreate(workDir);
      const buildYaml = join(workDir, '.tagma', 'build', 'build.yaml');
      const deployYaml = join(workDir, '.tagma', 'deploy', 'deploy.yaml');
      const legacyYaml = join(workDir, '.tagma', 'pipeline-9giapbf6.yaml');
      mkdirSync(join(workDir, '.tagma', 'build'), { recursive: true });
      mkdirSync(join(workDir, '.tagma', 'deploy'), { recursive: true });
      writeFileSync(buildYaml, 'pipeline:\n  name: Build\n  tracks: []\n', 'utf-8');
      writeFileSync(deployYaml, 'pipeline:\n  name: Deploy\n  tracks: []\n', 'utf-8');
      writeFileSync(legacyYaml, 'pipeline:\n  name: Legacy\n  tracks: []\n', 'utf-8');
      ws.yamlPath = buildYaml;

      const body = buildBotPromptAsyncBody(workDir, 'edit deploy');
      const text = body.parts[0]?.text ?? '';

      expect(text).toContain('<workspace>');
      expect(text).toContain('<current-file>.tagma/build/build.yaml</current-file>');
      expect(text).toContain('<workspace-yaml-folders>');
      expect(text).toContain('<folder>.tagma/build</folder>');
      expect(text).toContain('<yaml>.tagma/build/build.yaml</yaml>');
      expect(text).toContain('<manifest>.tagma/build/build.manifest.json</manifest>');
      expect(text).toContain('<folder>.tagma/deploy</folder>');
      expect(text).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
      expect(text).toContain('<manifest>.tagma/deploy/deploy.manifest.json</manifest>');
      expect(text).toContain('<pipeline legacy="flat">');
      expect(text).toContain('<yaml>.tagma/pipeline-9giapbf6.yaml</yaml>');
      expect(text).toContain('<manifest>.tagma/pipeline-9giapbf6.manifest.json</manifest>');
      expect(text).toContain('edit deploy');
      expect(existsSync(join(workDir, '.tagma', 'build', 'build.manifest.json'))).toBe(true);
      expect(existsSync(join(workDir, '.tagma', 'deploy', 'deploy.manifest.json'))).toBe(true);
      expect(existsSync(join(workDir, '.tagma', 'pipeline-9giapbf6.manifest.json'))).toBe(true);
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('marks remote bot create-pipeline turns so similar existing pipelines are not edit targets', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-create-intent-'));
    try {
      workspaceRegistry.getOrCreate(workDir);
      const deployYaml = join(workDir, '.tagma', 'deploy', 'deploy.yaml');
      mkdirSync(join(workDir, '.tagma', 'deploy'), { recursive: true });
      writeFileSync(deployYaml, 'pipeline:\n  name: Deploy\n  tracks: []\n', 'utf-8');

      const body = buildBotPromptAsyncBody(workDir, 'create a new deploy pipeline');
      const text = body.parts[0]?.text ?? '';

      expect(text).toContain('<requested-action kind="create-new-pipeline">');
      expect(text).toContain(
        '<collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
      );
      expect(text).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('does not mark remote bot task creation inside a pipeline as new-pipeline creation', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-task-intent-'));
    try {
      workspaceRegistry.getOrCreate(workDir);
      const deployYaml = join(workDir, '.tagma', 'deploy', 'deploy.yaml');
      mkdirSync(join(workDir, '.tagma', 'deploy'), { recursive: true });
      writeFileSync(deployYaml, 'pipeline:\n  name: Deploy\n  tracks: []\n', 'utf-8');

      const body = buildBotPromptAsyncBody(
        workDir,
        'create a new smoke test task in the deploy pipeline',
      );
      const text = body.parts[0]?.text ?? '';

      expect(text).not.toContain('<requested-action kind="create-new-pipeline">');
      expect(text).toContain('<yaml>.tagma/deploy/deploy.yaml</yaml>');
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
