import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type PipelineConfig } from '@tagma/sdk';
import { serializePipeline } from '@tagma/sdk/yaml';
import { buildTagmaNativePrimitivesSkill, seedOpencodeArtifacts } from '../server/opencode-seed';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-content-contract-')));
  roots.push(root);
  return root;
}

test('seeded author contract assigns exact bytes and digests to deterministic commands without expanding prompt authority', () => {
  const root = workspace();
  seedOpencodeArtifacts(root);
  const emitted = readFileSync(
    join(root, '.opencode/skills/tagma-native-primitives/SKILL.md'),
    'utf8',
  );
  expect(emitted).toBe(buildTagmaNativePrimitivesSkill());
  expect(emitted).toContain(
    'Compute file digests and byte-preserving transformations in deterministic command tasks',
  );
  expect(emitted).toContain(
    'never shorten, summarize or replace fetched content to make a digest easier',
  );
  expect(emitted).toContain('Do not send content to an external hashing service');
  expect(emitted).toContain('web access does not grant execute permission');
  expect(emitted).toContain('Never add execute permission merely for web access');
});

async function execute(preserve: boolean) {
  const root = workspace();
  const source =
    '# Independent sample\r\n\r\n**Revenue rose 17%** — café 日本語 ✓\r\nSecond paragraph.\n';
  writeFileSync(join(root, 'captured.txt'), source);
  writeFileSync(
    join(root, 'verify.cjs'),
    "const fs=require('node:fs'),c=require('node:crypto');const a=fs.readFileSync('captured.txt'),b=fs.readFileSync('saved.txt');const validDigest=c.createHash('sha256').update(b).digest('hex')===fs.readFileSync('digest.txt','utf8');if(!validDigest)throw Error('Digest mismatch');if(!a.equals(b))throw Error('Complete source bytes not preserved');console.log('Complete bytes and digest verified');",
  );
  const command = (code: string) => ({ argv: [process.execPath, '-e', code] });
  const config: PipelineConfig = {
    name: 'Exact source bytes with deterministic digest',
    tracks: [
      {
        id: 'files',
        name: 'File operations',
        tasks: [
          {
            id: 'materialize',
            name: 'Materialize captured text and hash its actual bytes',
            command: command(
              `const fs=require('node:fs'),c=require('node:crypto');const source=fs.readFileSync('captured.txt');const body=${preserve ? 'source' : "Buffer.from('# Independent sample')"};fs.writeFileSync('saved.txt',body);fs.writeFileSync('digest.txt',c.createHash('sha256').update(body).digest('hex'));`,
            ),
            completion: { type: 'file_exists', path: 'digest.txt' },
          },
          {
            id: 'verify',
            name: 'Verify complete input identity as well as digest',
            depends_on: ['files.materialize'],
            command: { argv: [process.execPath, join(root, 'verify.cjs')] },
          },
        ],
      },
    ],
  };
  const result = await createTagma().runYaml(serializePipeline(config), {
    cwd: root,
    runId: 'run_content_contract_' + (preserve ? 'preserved' : 'truncated'),
    skipPluginLoading: true,
  });
  expect(result.kind).toBe('pipeline');
  if (result.kind !== 'pipeline') throw Error('Actual SDK execution required');
  const saved = readFileSync(join(root, 'saved.txt'));
  expect(readFileSync(join(root, 'digest.txt'), 'utf8')).toBe(
    createHash('sha256').update(saved).digest('hex'),
  );
  expect(readFileSync(join(root, 'captured.txt'), 'utf8')).toBe(source);
  expect(result.result.states.get('files.materialize')?.status).toBe('success');
  return { result: result.result, saved, source };
}

test('actual SDK deterministic commands preserve multiline Unicode source bytes before hashing', async () => {
  const h = await execute(true);
  expect(h.result.success).toBe(true);
  expect(h.result.states.get('files.verify')?.status).toBe('success');
  expect(h.saved.equals(Buffer.from(h.source))).toBe(true);
});

test('actual SDK source-byte check rejects truncated content even with a correct digest', async () => {
  const h = await execute(false);
  expect(h.result.success).toBe(false);
  expect(h.result.states.get('files.verify')?.status).toBe('failed');
  expect(h.result.states.get('files.verify')?.result?.stderr).toContain(
    'Complete source bytes not preserved',
  );
  expect(h.saved.equals(Buffer.from(h.source))).toBe(false);
});
