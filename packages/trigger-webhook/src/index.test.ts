import { describe, expect, test } from 'bun:test';
import plugin, { WebhookTrigger } from './index';
import type { TriggerContext } from '@tagma/types';
import { connect } from 'node:net';
import manifest from '../package.json' with { type: 'json' };

function triggerContext(signal = new AbortController().signal): TriggerContext {
  return {
    taskId: 't.x',
    trackId: 't',
    workDir: process.cwd(),
    signal,
    approvalGateway: {} as TriggerContext['approvalGateway'],
    runtime: {} as TriggerContext['runtime'],
  };
}

function unusedPort(): number {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('ok');
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

function rawPost(
  port: number,
  path: string,
  body: string,
): Promise<{ readonly status: number; readonly text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    let data = '';

    const finish = () => {
      if (settled) return;
      settled = true;
      const status = Number(data.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      resolve({ status, text: data });
    };

    socket.on('connect', () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Content-Type: text/plain',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

describe('trigger-webhook plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('triggers');
    expect(manifest.tagmaPlugin.type).toBe('webhook');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.triggers?.[manifest.tagmaPlugin.type]).toBe(WebhookTrigger);
  });

  test('watch is a function', () => {
    expect(typeof plugin.capabilities!.triggers!.webhook.watch).toBe('function');
  });

  test('schema documents bounded bodies and finite default wait', () => {
    expect(WebhookTrigger.schema?.fields.max_body_bytes?.default).toBe(1024 * 1024);
    expect(WebhookTrigger.schema?.fields.timeout?.default).toBe('30m');
  });

  test('manifest requires the types release that exports plugin timeout parsing', () => {
    expect(manifest.peerDependencies?.['@tagma/types']).toBe('>=0.4.18 <0.5.0');
  });
});

describe('trigger-webhook hardening', () => {
  test('shares one listener across different paths on the same host and port', async () => {
    const port = unusedPort();
    const first = WebhookTrigger.watch({ port, path: '/first', timeout: '5s' }, triggerContext());
    let second: ReturnType<typeof WebhookTrigger.watch> | null = null;

    try {
      second = WebhookTrigger.watch({ port, path: '/second', timeout: '5s' }, triggerContext());
      const secondResponse = await rawPost(port, '/second', 'two');
      expect(secondResponse.status).toBe(202);
      await expect(second.fired).resolves.toBe('two');

      const firstResponse = await rawPost(port, '/first', 'one');
      expect(firstResponse.status).toBe(202);
      await expect(first.fired).resolves.toBe('one');
    } finally {
      await first.dispose('test cleanup');
      await second?.dispose('test cleanup');
      await Promise.allSettled([first.fired, ...(second ? [second.fired] : [])]);
    }
  });

  test('can immediately reuse a port after the final waiter fires', async () => {
    const port = unusedPort();

    for (let index = 0; index < 5; index += 1) {
      const handle = WebhookTrigger.watch(
        { port, path: `/round-${index}`, timeout: '5s' },
        triggerContext(),
      );
      try {
        const response = await rawPost(port, `/round-${index}`, String(index));
        expect(response.status).toBe(202);
        await expect(handle.fired).resolves.toBe(String(index));
      } finally {
        await handle.dispose('test cleanup');
        await Promise.allSettled([handle.fired]);
      }
    }
  });

  test('port must be an integer before the listener starts', () => {
    expect(() =>
      WebhookTrigger.watch(
        {
          port: 8787.5,
          path: '/fractional',
        },
        triggerContext(),
      ),
    ).toThrow(/"port" must be an integer from 1-65535/);
  });

  test('secret_env must resolve before the listener starts', () => {
    const envName = `TAGMA_TEST_MISSING_${Date.now()}`;
    delete process.env[envName];

    expect(() =>
      WebhookTrigger.watch(
        {
          port: unusedPort(),
          path: '/secret',
          secret_env: envName,
        },
        triggerContext(),
      ),
    ).toThrow(new RegExp(`env var ${envName} not set`));
  });

  test('aborted signal does not leave a listener bound', () => {
    const controller = new AbortController();
    controller.abort();
    const port = unusedPort();

    expect(() =>
      WebhookTrigger.watch(
        {
          port,
          path: '/aborted',
        },
        triggerContext(controller.signal),
      ),
    ).toThrow(/Pipeline aborted/);

    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch() {
        return new Response('ok');
      },
    });
    server.stop(true);
  });

  test('requests larger than max_body_bytes are rejected without firing the waiter', async () => {
    const controller = new AbortController();
    const port = unusedPort();
    const handle = WebhookTrigger.watch(
      {
        port,
        path: '/limit',
        max_body_bytes: 4,
      },
      triggerContext(controller.signal),
    );
    let fired = false;
    const observed = handle.fired
      .then(() => {
        fired = true;
      })
      .catch(() => {
        /* disposed at test cleanup */
      });

    try {
      const res = await rawPost(port, '/limit', '12345');
      expect(res.status).toBe(413);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fired).toBe(false);
    } finally {
      await handle.dispose('test cleanup');
      await observed;
      controller.abort();
    }
  });
});
