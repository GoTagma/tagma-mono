import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from '@tagma/core';
import { bunRuntime } from '@tagma/runtime-bun';
import type {
  CompletionCheckResult,
  CompletionContext,
  CompletionPlugin,
  TaskResult,
} from '@tagma/types';
import { bootstrapBuiltins } from '../bootstrap';

const directories: string[] = [];

function fixture(schema: unknown, rawData = '{}') {
  const workDir = mkdtempSync(join(tmpdir(), 'tagma-json-schema-'));
  directories.push(workDir);
  writeFileSync(join(workDir, 'schema.json'), JSON.stringify(schema));
  writeFileSync(join(workDir, 'data.json'), rawData);
  const registry = new PluginRegistry();
  bootstrapBuiltins(registry);
  const ctx: CompletionContext = { workDir, runtime: bunRuntime() };
  return { workDir, registry, ctx };
}

function childResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    durationMs: 0,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

async function check(schema: unknown, rawData: string) {
  const { registry, ctx } = fixture(schema, rawData);
  return registry
    .getHandler<CompletionPlugin>('completions', 'json_schema')
    .check({ path: 'data.json', schema_path: 'schema.json' }, childResult(), ctx);
}

function failure(outcome: boolean | CompletionCheckResult): CompletionCheckResult {
  expect(typeof outcome).toBe('object');
  if (typeof outcome === 'boolean') throw new Error('Expected structured failure diagnostics');
  expect(outcome.passed).toBe(false);
  expect(outcome.feedback).toBeTruthy();
  return outcome;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('host built-in JSON Schema file completion', () => {
  test('rejects invalid producer bytes before a consumer in a workspace without an SDK install', async () => {
    const { workDir, registry, ctx } = fixture({
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    });
    expect(existsSync(join(workDir, 'node_modules'))).toBe(false);
    const result = await runPipeline(
      {
        name: 'authoritative-file-contract',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'producer',
                name: 'Producer',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    "require('node:fs').writeFileSync('data.json', JSON.stringify({items:[{}]}));process.stderr.write('child diagnostic')",
                  ],
                },
                completion: { type: 'json_schema', path: 'data.json', schema_path: 'schema.json' },
              },
              {
                id: 'consumer',
                name: 'Consumer',
                depends_on: ['producer'],
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    "require('node:fs').writeFileSync('consumed', 'bad')",
                  ],
                },
              },
            ],
          },
        ],
      },
      workDir,
      { registry, runtime: ctx.runtime, skipPluginLoading: true },
    );
    expect(result.success).toBe(false);
    expect(result.states.get('main.producer')?.status).toBe('failed');
    const producer = result.states.get('main.producer')?.result;
    expect(producer?.failureKind).toBe('completion_failed');
    expect(producer?.stderr).toContain('child diagnostic');
    expect(producer?.stderrDiagnostics?.completeSuffix).toContain('required');
    expect(producer?.stderrDiagnostics?.completeSuffix).toContain('/items/0');
    expect(result.states.get('main.consumer')?.status).toBe('skipped');
    expect(existsSync(join(workDir, 'consumed'))).toBe(false);
  });

  test('accepts nested nullable values, legal empties, and schema-permitted extras without mutation', async () => {
    const schema = {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['value'],
            properties: { value: { type: ['number', 'null'] } },
          },
        },
        optional: { type: 'string', default: 'must not be inserted' },
      },
    };
    for (const data of [{ items: [] }, { items: [{ value: null, extra: true }], other: 7 }]) {
      const rawData = JSON.stringify(data);
      const { workDir, registry, ctx } = fixture(schema, rawData);
      const outcome = await registry
        .getHandler<CompletionPlugin>('completions', 'json_schema')
        .check({ path: 'data.json', schema_path: 'schema.json' }, childResult(), ctx);
      expect(outcome).toBe(true);
      expect(readFileSync(join(workDir, 'data.json'), 'utf8')).toBe(rawData);
    }
  });

  test('checks all declared nested types, enum, bounds, and closed extra keys', async () => {
    const outcome = failure(
      await check(
        {
          type: 'object',
          required: ['rows'],
          additionalProperties: false,
          properties: {
            rows: {
              type: 'array',
              items: {
                type: 'object',
                required: ['value', 'status'],
                additionalProperties: false,
                properties: {
                  value: { type: 'number', minimum: 0, maximum: 1 },
                  status: { enum: ['ready', 'unknown'] },
                },
              },
            },
          },
        },
        '{"rows":[{"value":"0.5","status":"invented","extra":1},{"value":2}],"extra":true}',
      ),
    );
    for (const keyword of ['type', 'enum', 'maximum', 'required', 'additionalProperties'])
      expect(outcome.feedback).toContain(keyword);
  });

  test('honors conditional requiredness and local Draft 7 references', async () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: {
        row: {
          type: 'object',
          properties: { status: { enum: ['ready', 'unknown'] }, value: { type: 'number' } },
          required: ['status'],
          if: { properties: { status: { const: 'ready' } } },
          then: { required: ['value'] },
        },
      },
      $ref: '#/definitions/row',
    };
    expect(await check(schema, '{"status":"unknown"}')).toBe(true);
    failure(await check(schema, '{"status":"ready"}'));
    expect(await check(schema, '{"status":"ready","value":3}')).toBe(true);
  });

  test('validates standard formats only when requested by the schema', async () => {
    expect(await check({ type: 'string' }, '"not a URI"')).toBe(true);
    failure(await check({ type: 'string', format: 'uri' }, '"https://["'));
    expect(await check({ type: 'string', format: 'uri' }, '"mailto:reader@example.test"')).toBe(
      true,
    );
    expect(await check({ type: 'string', format: 'uri' }, '"https://example.test/a"')).toBe(true);
  });

  test('fails closed for invalid schemas, unknown constraints, and unsupported drafts', async () => {
    for (const schema of [
      { required: 'wrong' },
      { unknown_constraint: true },
      { type: 'string', format: 'invented-format' },
      { $schema: 'https://json-schema.org/draft/2020-12/schema' },
    ]) {
      expect(failure(await check(schema, '{}')).feedback).toContain('schema');
    }
  });

  test('rejects async validation and unresolved external references without a fetch path', async () => {
    expect(failure(await check({ $async: true, type: 'object' }, '{}')).feedback).toContain(
      'async',
    );
    expect(
      failure(await check({ $ref: 'https://example.test/schema.json' }, '{}')).feedback,
    ).toContain('schema');
    failure(await check({ $ref: '#/definitions/missing' }, '{}'));
  });

  test('requires a whole strict JSON document and finite numeric values even under an empty schema', async () => {
    for (const rawData of [
      '{} {}',
      '{"value":NaN}',
      '{"value":Infinity}',
      '{"value":1e999}',
      '{"nested":[1,-1e999]}',
    ])
      failure(await check({}, rawData));
    expect(await check({}, '{"nested":[1,2]}')).toBe(true);
    expect(await check(true, 'null')).toBe(true);
    failure(await check(false, '{}'));
  });

  test('rejects schema non-finite numeric literals and malformed schema bytes', async () => {
    const { workDir, registry, ctx } = fixture({});
    const plugin = registry.getHandler<CompletionPlugin>('completions', 'json_schema');
    for (const rawSchema of ['{"maximum":1e999}', '{"required":']) {
      writeFileSync(join(workDir, 'schema.json'), rawSchema);
      expect(
        failure(
          await plugin.check({ path: 'data.json', schema_path: 'schema.json' }, childResult(), ctx),
        ).feedback,
      ).toContain('schema');
    }
  });

  test('preserves effective-cwd path boundaries for both files and reports missing files', async () => {
    const { registry, ctx } = fixture({});
    const plugin = registry.getHandler<CompletionPlugin>('completions', 'json_schema');
    for (const config of [
      { path: '../outside.json', schema_path: 'schema.json' },
      { path: 'data.json', schema_path: '../outside.json' },
    ]) {
      await expect(plugin.check(config, childResult(), ctx)).rejects.toThrow(
        /escapes project root/i,
      );
    }
    failure(
      await plugin.check({ path: 'missing.json', schema_path: 'schema.json' }, childResult(), ctx),
    );
    failure(
      await plugin.check({ path: 'data.json', schema_path: 'missing.json' }, childResult(), ctx),
    );
    await expect(plugin.check({ path: 'data.json' }, childResult(), ctx)).rejects.toThrow(
      /schema_path/,
    );
  });

  test('respects an already aborted completion signal', async () => {
    const { registry, ctx } = fixture({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry
        .getHandler<CompletionPlugin>('completions', 'json_schema')
        .check({ path: 'data.json', schema_path: 'schema.json' }, childResult(), {
          ...ctx,
          signal: controller.signal,
        }),
    ).rejects.toThrow();
  });

  test('keeps every validation diagnostic in the canonical suffix while the display remains bounded', async () => {
    const { workDir, registry, ctx } = fixture(
      { type: 'array', items: { type: 'object', required: ['value'] } },
      JSON.stringify(Array.from({ length: 350 }, () => ({}))),
    );
    const result = await runPipeline(
      {
        name: 'complete-contract-feedback',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'producer',
                name: 'Producer',
                command: {
                  argv: [process.execPath, '-e', "process.stderr.write('child diagnostic')"],
                },
                completion: { type: 'json_schema', path: 'data.json', schema_path: 'schema.json' },
              },
            ],
          },
        ],
      },
      workDir,
      { registry, runtime: ctx.runtime, skipPluginLoading: true },
    );
    const producer = result.states.get('main.producer')?.result;
    expect(producer?.failureKind).toBe('completion_failed');
    expect(producer?.stderrDiagnostics?.completeSuffix).toContain('"instancePath": "/0"');
    expect(producer?.stderrDiagnostics?.completeSuffix).toContain('"instancePath": "/349"');
    expect(producer?.stderrDiagnostics?.completeSuffix.length).toBeGreaterThan(16_000);
    expect(producer?.stderr.length).toBeLessThan(17_000);
  });
});
