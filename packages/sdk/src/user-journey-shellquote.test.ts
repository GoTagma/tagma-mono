import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from './index';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-shellquote-journey-'));
}

function commandYaml(value: string): string {
  return `
pipeline:
  name: shellquote-user-journey
  tracks:
    - id: main
      name: Main
      tasks:
        - id: capture
          name: Capture one shellquoted argument
          command: >-
            node -e "process.stdout.write(Buffer.from(process.argv[1], 'utf8').toString('base64'))" {{inputs.value | shellquote}}
          inputs:
            value:
              type: string
              value: ${JSON.stringify(value)}
`;
}

function finalTaskEvent(events: RunEventPayload[]) {
  const updates = events.filter(
    (event) => event.type === 'task_update' && event.taskId === 'main.capture',
  );
  return updates[updates.length - 1];
}

describe('user journey - shellquote in YAML command strings', () => {
  test('preserves each input as one exact argument and prevents shell injection on Windows', async () => {
    const dir = makeDir();
    const injectedMarker = join(dir, 'shellquote-injected-marker');

    try {
      const markerPathBase64 = Buffer.from(injectedMarker, 'utf8').toString('base64');
      const injectedCommand =
        `node -e "require('node:fs').writeFileSync(` +
        `Buffer.from('${markerPathBase64}', 'base64').toString(), 'injected')"`;
      const cases = [
        { name: 'spaces', value: 'two words and a path segment' },
        { name: 'quotes', value: `double "quotes" and single 'quotes'` },
        { name: 'empty string', value: '' },
        { name: 'Unicode', value: '上海 café 👋' },
        {
          name: 'shell metacharacters',
          // Without | shellquote, the semicolon starts injectedCommand. The
          // remaining characters must arrive at Node literally as well.
          value: `literal; ${injectedCommand}; # $() & | < >`,
        },
      ];

      for (const { name, value } of cases) {
        const events: RunEventPayload[] = [];
        const result = await createTagma().runYaml(commandYaml(value), {
          cwd: dir,
          onEvent: (event) => events.push(event),
        });

        expect(result.kind, name).toBe('pipeline');
        if (result.kind !== 'pipeline') continue;

        expect(result.result.success, name).toBe(true);
        const final = finalTaskEvent(events);
        expect(final, name).toBeDefined();
        if (!final || final.type !== 'task_update') continue;

        expect(final.status, name).toBe('success');
        expect(final.stdout, name).toBe(Buffer.from(value, 'utf8').toString('base64'));
        expect(existsSync(injectedMarker), name).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
