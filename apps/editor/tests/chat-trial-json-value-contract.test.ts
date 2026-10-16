import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma } from '@tagma/sdk';
import { serializePipeline } from '@tagma/sdk/yaml';
import type { RawPipelineConfig } from '@tagma/types';

test('real JSON completion preserves declared scalar types and blocks downstream work until the contract passes', async () => {
  const claim = 'A measured height is 330 cm.';
  const vectors = [
    { union: false, data: { claim, observations: [{ amount: 330 }] }, passes: false },
    { union: false, data: { claim, observations: [{ amount: '330' }] }, passes: true },
    { union: true, data: { claim, observations: [{ amount: 330 }] }, passes: true },
    { union: true, data: { claim, observations: [{ amount: '330' }] }, passes: true },
    { union: true, data: { claim, observations: [{ amount: true }] }, passes: false },
    { union: true, data: { claim: 330, observations: [{ amount: 330 }] }, passes: false },
    { union: true, data: { claim, observations: [{}] }, passes: false },
  ];
  for (const vector of vectors) {
    const root = mkdtempSync(join(tmpdir(), 'tagma-json-value-contract-'));
    const folder = join(root, '.tagma', 'json-contract');
    mkdirSync(folder, { recursive: true });
    try {
      writeFileSync(
        join(folder, 'write.js'),
        `const fs = require('node:fs');
fs.mkdirSync('work', { recursive: true });
fs.writeFileSync('work/payload.json', process.argv[2]);
`,
      );
      writeFileSync(
        join(folder, 'payload.schema.json'),
        JSON.stringify({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          required: ['claim', 'observations'],
          additionalProperties: false,
          properties: {
            claim: { type: 'string', minLength: 1 },
            observations: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['amount'],
                additionalProperties: false,
                properties: { amount: { type: vector.union ? ['string', 'number'] : 'string' } },
              },
            },
          },
        }),
      );
      const pipeline: RawPipelineConfig = {
        name: 'Declared scalar contract',
        tracks: [
          {
            id: 'measure',
            name: 'Measure',
            cwd: '.tagma/json-contract',
            tasks: [
              {
                id: 'write',
                command: { argv: [process.execPath, 'write.js', JSON.stringify(vector.data)] },
                completion: {
                  type: 'json_schema',
                  path: 'work/payload.json',
                  schema_path: 'payload.schema.json',
                },
              },
              {
                id: 'consume',
                depends_on: ['measure.write'],
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    "require('node:fs').writeFileSync('work/downstream.txt', 'validated')",
                  ],
                },
                completion: { type: 'file_exists', path: 'work/downstream.txt', kind: 'file' },
              },
            ],
          },
        ],
      };
      // Only real command tasks run. No fake driver or provider response can
      // substitute for the actual completion plugin and dependency scheduler.
      const outcome = await createTagma().runYaml(serializePipeline(pipeline), {
        cwd: root,
        skipPluginLoading: true,
      });
      expect(outcome.kind).toBe('pipeline');
      if (outcome.kind !== 'pipeline') throw new Error('Expected actual pipeline execution.');
      const producer = outcome.result.states.get('measure.write')!;
      const consumer = outcome.result.states.get('measure.consume')!;
      expect(JSON.parse(readFileSync(join(folder, 'work', 'payload.json'), 'utf8'))).toEqual(
        vector.data,
      );
      expect(outcome.result.success).toBe(vector.passes);
      expect(existsSync(join(folder, 'work', 'downstream.txt'))).toBe(vector.passes);
      if (vector.passes) {
        expect(producer.status).toBe('success');
        expect(consumer.status).toBe('success');
      } else {
        expect(producer.status).toBe('failed');
        expect(producer.result?.failureKind).toBe('completion_failed');
        expect(producer.result?.stderr).toContain('json_schema completion: validation failed');
        expect(consumer.status).toBe('skipped');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
