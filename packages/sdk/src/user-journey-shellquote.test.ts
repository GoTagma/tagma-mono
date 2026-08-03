import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type RunEventPayload } from './index';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-shellquote-journey-'));
}

function commandYaml(value: string): string {
  const quote = String.fromCharCode(34);
  const single = String.fromCharCode(39);
  const command =
    'node -e ' +
    quote +
    'process.stdout.write(Buffer.from(process.argv[1], ' +
    single +
    'utf8' +
    single +
    ').toString(' +
    single +
    'base64' +
    single +
    '))' +
    quote +
    ' {{inputs.value | shellquote}}';
  return [
    'pipeline:',
    '  name: shellquote-user-journey',
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      tasks:',
    '        - id: capture',
    '          name: Capture one shellquoted argument',
    '          command: >-',
    '            ' + command,
    '          inputs:',
    '            value:',
    '              type: string',
    '              value: ' + JSON.stringify(value),
  ].join(String.fromCharCode(10));
}

function finalTaskEvent(events: RunEventPayload[]) {
  const updates = events.filter(
    (event) => event.type === 'task_update' && event.taskId === 'main.capture',
  );
  return updates[updates.length - 1];
}

async function captureValue(dir: string, value: string, name: string): Promise<string> {
  const events: RunEventPayload[] = [];
  const result = await createTagma().runYaml(commandYaml(value), {
    cwd: dir,
    onEvent: (event) => events.push(event),
  });

  expect(result.kind, name).toBe('pipeline');
  if (result.kind !== 'pipeline') return '';
  expect(result.result.success, name).toBe(true);

  const final = finalTaskEvent(events);
  expect(final, name).toBeDefined();
  if (!final || final.type !== 'task_update') return '';
  expect(final.status, name).toBe('success');
  return final.stdout ?? '';
}

describe('user journey - shellquote in YAML command strings', () => {
  test('preserves one exact PowerShell argument for each boundary value', async () => {
    const dir = makeDir();
    try {
      const quote = String.fromCharCode(34);
      const single = String.fromCharCode(39);
      const slash = String.fromCharCode(92);
      const backtick = String.fromCharCode(96);
      const cases = [
        { name: 'empty', value: '' },
        { name: 'spaces', value: 'two words and a path segment' },
        {
          name: 'single and double quotes',
          value: 'double ' + quote + 'quotes' + quote + ' and single ' + single + 'quotes' + single,
        },
        {
          name: 'backslashes before a quote and at the end',
          value: ['C:', 'Program Files', 'Tagma', quote + 'quoted' + quote, ''].join(slash),
        },
        { name: 'dollar and backtick', value: 'price $HOME ' + backtick + 'cmd' },
        { name: 'semicolon and pipe', value: 'semi;colon | pipe' },
        { name: 'redirection and ampersand', value: 'literal <in >out & another' },
        {
          name: 'newline and tab',
          value:
            'line one' + String.fromCharCode(10) + 'line two' + String.fromCharCode(9) + 'indented',
        },
        {
          name: 'Unicode',
          value: String.fromCharCode(19978, 28023) + ' cafe ' + String.fromCodePoint(128077),
        },
      ];

      for (const { name, value } of cases) {
        const stdout = await captureValue(dir, value, name);
        expect(stdout, name).toBe(Buffer.from(value, 'utf8').toString('base64'));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('keeps a shell metacharacter payload inert while preserving it exactly', async () => {
    const dir = makeDir();
    const injectedMarker = join(dir, 'shellquote-injected-marker');
    try {
      const quote = String.fromCharCode(34);
      const single = String.fromCharCode(39);
      const backtick = String.fromCharCode(96);
      const markerPathBase64 = Buffer.from(injectedMarker, 'utf8').toString('base64');
      const injectedCommand =
        'node -e ' +
        quote +
        'require(' +
        single +
        'node:fs' +
        single +
        ').writeFileSync(Buffer.from(' +
        single +
        markerPathBase64 +
        single +
        ', ' +
        single +
        'base64' +
        single +
        ').toString(), ' +
        single +
        'injected' +
        single +
        ')' +
        quote;
      const value = [
        'literal; ',
        injectedCommand,
        '; # $() ',
        backtick,
        'whoami',
        backtick,
        ' & | < > ',
        String.fromCharCode(92, 92),
        ' ',
        quote,
        'quoted',
        quote,
      ].join('');
      const stdout = await captureValue(dir, value, 'injection payload');

      expect(stdout).toBe(Buffer.from(value, 'utf8').toString('base64'));
      expect(existsSync(injectedMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
