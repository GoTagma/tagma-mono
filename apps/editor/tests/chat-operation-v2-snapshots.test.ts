import { expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES,
  assertChatMutationBasesMayChange,
  createChatInventorySnapshot,
  decodeChatReadSnapshot,
  encodeChatReadSnapshot,
  parseChatReadSnapshot,
  sealChatMutationBases,
  sealChatReadSnapshot,
  toChatReadSnapshotEvidence,
} from '../server/chat-operations/snapshots';

const candidate = {
  id: 'candidate_one',
  relativePath: 'pipeline-one/pipeline-one.yaml',
  contentHash: 'a'.repeat(64),
};

function makeReadSnapshot() {
  const inventory = createChatInventorySnapshot(12, [candidate]);
  return sealChatReadSnapshot(
    {
      operationId: 'operation_one',
      workspaceScopeId: 'workspace_one',
      generation: 3,
      candidateId: candidate.id,
      rendererInstanceId: 'renderer_one',
      localRevision: 9,
      canonicalYaml: 'pipeline:\n  name: dirty-editor-copy-中文\n',
      layoutJson: '{"positions":{}}',
      requirementsMarkdown: '# Requirements\n保留这些字节。\n',
      compileDiagnostics: [{ level: 'warning', code: 'dirty', message: 'Unsaved editor bytes.' }],
    },
    {
      workspaceScopeId: 'workspace_one',
      generation: 3,
      inventory,
      now: () => 1234,
      validateCanonicalYaml: (yaml) => {
        if (!yaml.startsWith('pipeline:')) throw new Error('invalid canonical YAML');
      },
    },
  );
}

test('Host inventory digest is canonical and rejects ambiguous candidates', () => {
  const first = createChatInventorySnapshot(7, [
    candidate,
    {
      id: 'candidate_two',
      relativePath: 'pipeline-two\\pipeline-two.yaml',
      contentHash: 'b'.repeat(64),
    },
  ]);
  const reordered = createChatInventorySnapshot(7, [
    {
      id: 'candidate_two',
      relativePath: 'pipeline-two/pipeline-two.yaml',
      contentHash: 'b'.repeat(64),
    },
    candidate,
  ]);

  expect(first.digest).toBe(reordered.digest);
  expect(first.candidates.map((entry) => entry.relativePath)).toEqual([
    'pipeline-one/pipeline-one.yaml',
    'pipeline-two/pipeline-two.yaml',
  ]);
  expect(() => createChatInventorySnapshot(7, [candidate, candidate])).toThrow('duplicate');
  expect(() =>
    createChatInventorySnapshot(7, [candidate, { ...candidate, id: 'candidate_two' }]),
  ).toThrow('duplicate');
  expect(() =>
    createChatInventorySnapshot(7, [{ ...candidate, relativePath: '../outside.yaml' }]),
  ).toThrow('relative path');
  expect(() =>
    createChatInventorySnapshot(7, [{ ...candidate, relativePath: 'pipeline-one/unsafe\0.yaml' }]),
  ).toThrow('relative path');
});

test('read snapshot takes candidate coordinates only from Host inventory and freezes dirty bytes', () => {
  const snapshot = makeReadSnapshot();

  expect(snapshot).toMatchObject({
    version: 2,
    operationId: 'operation_one',
    workspaceScopeId: 'workspace_one',
    generation: 3,
    candidateId: candidate.id,
    candidateRelativePath: candidate.relativePath,
    candidateDiskHash: candidate.contentHash,
    inventoryRevision: 12,
    inventoryDigest: createChatInventorySnapshot(12, [candidate]).digest,
    rendererInstanceId: 'renderer_one',
    localRevision: 9,
    createdAt: 1234,
    publishable: false,
  });
  expect(snapshot.yamlHash).not.toBe(candidate.contentHash);
  expect(snapshot.canonicalYaml).toContain('dirty-editor-copy');
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.compileDiagnostics)).toBe(true);
});

test('sealed read snapshot canonical bytes survive restart and reject tampering', () => {
  const snapshot = makeReadSnapshot();
  const encoded = encodeChatReadSnapshot(snapshot);
  const decoded = decodeChatReadSnapshot(encoded);

  expect(decoded).toEqual(snapshot);
  expect(new TextDecoder().decode(encoded)).toContain('dirty-editor-copy-中文');
  expect(decoded.requirementsMarkdown).toBe('# Requirements\n保留这些字节。\n');
  expect(Object.isFrozen(decoded)).toBe(true);

  expect(() => parseChatReadSnapshot({ ...snapshot, yamlHash: 'f'.repeat(64) })).toThrow(
    'YAML hash',
  );
  expect(() => parseChatReadSnapshot({ ...snapshot, snapshotHash: 'f'.repeat(64) })).toThrow(
    'snapshot hash',
  );
  expect(() => parseChatReadSnapshot({ ...snapshot, publishable: true })).toThrow('publishable');
  expect(() =>
    parseChatReadSnapshot({
      ...snapshot,
      compileDiagnostics: [
        { level: 'warning', code: 'dirty', message: 'safe', extra: 'not authenticated' },
      ],
    }),
  ).toThrow('unknown fields');
  expect(() => decodeChatReadSnapshot(Uint8Array.of(0xff, 0xfe))).toThrow('UTF-8');
});

test('read snapshot journal evidence excludes authored bytes and filesystem coordinates', () => {
  const evidence = toChatReadSnapshotEvidence(makeReadSnapshot());
  const serialized = JSON.stringify(evidence);

  expect(evidence).toMatchObject({
    snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    candidateId: candidate.id,
    inventoryRevision: 12,
    localRevision: 9,
    compileDiagnosticCount: 1,
  });
  for (const forbidden of [
    'dirty-editor-copy',
    '保留这些字节',
    'pipeline-one.yaml',
    'Unsaved editor bytes',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test('read snapshot fails closed on stale authority, unknown candidates, invalid schema, and bounds', () => {
  const inventory = createChatInventorySnapshot(1, [candidate]);
  const valid = {
    operationId: 'operation_one',
    workspaceScopeId: 'workspace_one',
    generation: 2,
    candidateId: candidate.id,
    rendererInstanceId: 'renderer_one',
    localRevision: 0,
    canonicalYaml: 'pipeline: {}\n',
    layoutJson: null,
    requirementsMarkdown: null,
    compileDiagnostics: [],
  } as const;
  const host = {
    workspaceScopeId: 'workspace_one',
    generation: 2,
    inventory,
    validateCanonicalYaml: (yaml: string) => {
      if (yaml !== 'pipeline: {}\n') throw new Error('invalid canonical YAML');
    },
  };

  expect(() =>
    sealChatReadSnapshot({ ...valid, workspaceScopeId: 'workspace_other' }, host),
  ).toThrow('workspace scope');
  expect(() => sealChatReadSnapshot({ ...valid, generation: 1 }, host)).toThrow('generation');
  expect(() =>
    sealChatReadSnapshot({ ...valid, generation: 0 }, { ...host, generation: 0 }),
  ).toThrow('positive integer');
  expect(() => sealChatReadSnapshot({ ...valid, candidateId: 'candidate_unknown' }, host)).toThrow(
    'inventory',
  );
  expect(() =>
    sealChatReadSnapshot(valid, {
      ...host,
      inventory: { ...inventory, digest: 'f'.repeat(64) },
    }),
  ).toThrow('inventory digest');
  expect(() => sealChatReadSnapshot({ ...valid, canonicalYaml: 'not yaml' }, host)).toThrow(
    'invalid canonical YAML',
  );
  expect(() =>
    sealChatReadSnapshot(
      {
        ...valid,
        canonicalYaml: `pipeline: ${'x'.repeat(CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES)}`,
      },
      { ...host, validateCanonicalYaml: () => {} },
    ),
  ).toThrow('too large');
});

test('mutating baselines are immutable from reserving onward', () => {
  const bases = sealChatMutationBases({
    diskBase: { yamlHash: 'a'.repeat(64), layoutHash: null, requirementsHash: null },
    editorBase: { yamlHash: 'b'.repeat(64), layoutHash: null, requirementsHash: null },
    agentBase: { yamlHash: 'c'.repeat(64), layoutHash: null, requirementsHash: null },
  });

  expect(Object.isFrozen(bases)).toBe(true);
  expect(Object.isFrozen(bases.editorBase)).toBe(true);
  expect(() => assertChatMutationBasesMayChange('created')).not.toThrow();
  expect(() => assertChatMutationBasesMayChange('classifying')).not.toThrow();
  expect(() => assertChatMutationBasesMayChange('awaiting_input')).not.toThrow();
  for (const phase of [
    'reserving',
    'staging',
    'authoring',
    'verifying',
    'trial-running',
    'repairing',
    'commit_preparing',
    'commit_decided',
    'commit_applying',
    'commit_recovering',
    'terminal',
  ] as const) {
    expect(() => assertChatMutationBasesMayChange(phase)).toThrow('immutable');
  }
});
