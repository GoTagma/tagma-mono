import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  CHAT_OPERATION_V2_MAX_INVENTORY_CANDIDATES,
  CHAT_OPERATION_V2_MAX_INVENTORY_YAML_BYTES,
  ChatOperationV2InventoryError,
  buildChatOperationV2HostInventory,
} from '../server/chat-operations/inventory.js';

const tempRoots: string[] = [];

function makeWorkspace(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-inventory-'));
  tempRoots.push(workspaceRoot);
  mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
  return workspaceRoot;
}

function writeFolderedPipeline(
  workspaceRoot: string,
  stem: string,
  content: string,
  extension: 'yaml' | 'yml' = 'yaml',
): string {
  const folder = join(workspaceRoot, '.tagma', stem);
  mkdirSync(folder, { recursive: true });
  const yamlPath = join(folder, `${stem}.${extension}`);
  writeFileSync(yamlPath, content, 'utf8');
  return yamlPath;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ChatTurn Operation V2 Host pipeline inventory', () => {
  test('builds one canonical, bounded inventory from Host workspace enumeration', () => {
    const workspaceRoot = makeWorkspace();
    const alphaYaml = 'pipeline:\n  name: Alpha Pipeline\ntracks: []\n';
    const zetaYaml = 'name: Zeta Legacy Name\ntracks: []\n';
    const legacyYaml = 'pipeline:\n  name: Legacy Flat\ntracks: []\n';
    const alphaPath = writeFolderedPipeline(workspaceRoot, 'alpha', alphaYaml);
    const zetaPath = writeFolderedPipeline(workspaceRoot, 'zeta', zetaYaml, 'yml');
    const legacyPath = join(workspaceRoot, '.tagma', 'legacy.yaml');
    writeFileSync(legacyPath, legacyYaml, 'utf8');

    const inventory = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 41,
      currentCanvasPath: alphaPath,
      sessionOwnedPath: legacyPath,
      manualNewDraftPath: zetaPath,
    });

    expect(inventory.inventory.revision).toBe(41);
    expect(inventory.inventory.candidates.map(({ relativePath }) => relativePath).sort()).toEqual([
      'alpha/alpha.yaml',
      'legacy.yaml',
      'zeta/zeta.yml',
    ]);
    expect(inventory.candidates.map(({ path }) => path)).toEqual([
      'alpha/alpha.yaml',
      'legacy.yaml',
      'zeta/zeta.yml',
    ]);
    expect(inventory.candidates).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pipeline_[a-f0-9]{64}$/),
        pipelineName: 'Alpha Pipeline',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^pipeline_[a-f0-9]{64}$/),
        pipelineName: 'Legacy Flat',
        currentCanvas: false,
        sessionOwned: true,
        manualNewDraft: false,
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^pipeline_[a-f0-9]{64}$/),
        pipelineName: 'Zeta Legacy Name',
        currentCanvas: false,
        sessionOwned: false,
        manualNewDraft: true,
      }),
    ]);
    expect(
      Object.fromEntries(
        inventory.inventory.candidates.map(({ relativePath, contentHash }) => [
          relativePath,
          contentHash,
        ]),
      ),
    ).toEqual({
      'alpha/alpha.yaml': sha256(alphaYaml),
      'legacy.yaml': sha256(legacyYaml),
      'zeta/zeta.yml': sha256(zetaYaml),
    });
    expect(new Set(inventory.inventory.candidates.map(({ id }) => id)).size).toBe(3);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.inventory)).toBe(true);
    expect(Object.isFrozen(inventory.candidates)).toBe(true);
    expect(inventory.candidates.every(Object.isFrozen)).toBe(true);
  });

  test('keeps opaque candidate IDs stable across order and content changes while digest tracks bytes', () => {
    const workspaceRoot = makeWorkspace();
    const betaPath = writeFolderedPipeline(
      workspaceRoot,
      'beta',
      'pipeline:\n  name: Beta\ntracks: []\n',
    );
    const first = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 7,
    });
    const repeated = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 7,
    });

    expect(repeated.inventory).toEqual(first.inventory);
    expect(repeated.candidates).toEqual(first.candidates);

    writeFolderedPipeline(workspaceRoot, 'alpha', 'pipeline:\n  name: Alpha\ntracks: []\n');
    const inserted = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 8,
    });
    const betaId = first.inventory.candidates[0]!.id;
    expect(
      inserted.inventory.candidates.find(({ relativePath }) => relativePath.startsWith('beta/')),
    ).toMatchObject({ id: betaId });

    writeFileSync(betaPath, 'pipeline:\n  name: Beta Updated\ntracks: []\n', 'utf8');
    const changed = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 9,
    });
    const changedBeta = changed.inventory.candidates.find(({ id }) => id === betaId);
    expect(changedBeta).toBeDefined();
    expect(changedBeta?.contentHash).not.toBe(first.inventory.candidates[0]!.contentHash);
    expect(changed.inventory.digest).not.toBe(inserted.inventory.digest);
    expect(changed.candidates.find(({ id }) => id === betaId)?.pipelineName).toBe('Beta Updated');
  });

  test('keeps absolute workspace coordinates private and resolves only exact Host IDs', () => {
    const workspaceRoot = makeWorkspace();
    const yamlPath = writeFolderedPipeline(
      workspaceRoot,
      'orders',
      'pipeline:\n  name: Orders\ntracks: []\n',
    );
    const inventory = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 1,
    });
    const id = inventory.inventory.candidates[0]!.id;
    const canonicalRoot = realpathSync.native(workspaceRoot);

    expect(JSON.stringify(inventory)).not.toContain(workspaceRoot);
    expect(JSON.stringify(inventory)).not.toContain(canonicalRoot);
    expect(JSON.stringify(inventory.inventory)).not.toContain(workspaceRoot);
    expect(JSON.stringify(inventory.candidates)).not.toContain(workspaceRoot);
    expect(inventory.resolveCandidate(id)).toEqual({
      id,
      relativePath: 'orders/orders.yaml',
      yamlPath: realpathSync.native(yamlPath),
      contentHash: sha256('pipeline:\n  name: Orders\ntracks: []\n'),
      content: 'pipeline:\n  name: Orders\ntracks: []\n',
      pipelineName: 'Orders',
    });

    for (const unknown of ['pipeline_missing', '../orders/orders.yaml', yamlPath, '', id + 'x']) {
      let caught: unknown;
      try {
        inventory.resolveCandidate(unknown);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ChatOperationV2InventoryError);
      expect(caught).toMatchObject({ code: 'unknown_candidate' });
      expect(String(caught)).not.toContain(workspaceRoot);
    }
  });

  test('keeps the exact UTF-8 disk text paired with its byte-authored content hash', () => {
    const workspaceRoot = makeWorkspace();
    const yamlPath = writeFolderedPipeline(workspaceRoot, 'bom', 'placeholder');
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('pipeline:\n  name: BOM\ntracks: []\n', 'utf8'),
    ]);
    writeFileSync(yamlPath, bytes);

    const inventory = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 2,
    });
    const candidate = inventory.resolveCandidate(inventory.inventory.candidates[0]!.id);

    expect(candidate.content.charCodeAt(0)).toBe(0xfeff);
    expect(Buffer.from(candidate.content, 'utf8')).toEqual(bytes);
    expect(candidate.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(candidate.pipelineName).toBe('BOM');
  });

  test('skips symlinked candidate entries and fails closed when .tagma itself is a symlink', () => {
    const workspaceRoot = makeWorkspace();
    writeFolderedPipeline(workspaceRoot, 'safe', 'pipeline:\n  name: Safe\ntracks: []\n');
    const outsideFolder = join(workspaceRoot, 'outside');
    mkdirSync(outsideFolder);
    writeFileSync(join(outsideFolder, 'linked.yaml'), 'pipeline:\n  name: Outside\n', 'utf8');

    let directoryLinkCreated = false;
    try {
      symlinkSync(outsideFolder, join(workspaceRoot, '.tagma', 'linked'), 'dir');
      directoryLinkCreated = true;
    } catch {
      // Windows may require Developer Mode or elevation for symlink coverage.
    }
    const linkFileFolder = join(workspaceRoot, '.tagma', 'file-link');
    mkdirSync(linkFileFolder);
    let fileLinkCreated = false;
    try {
      symlinkSync(
        join(outsideFolder, 'linked.yaml'),
        join(linkFileFolder, 'file-link.yaml'),
        'file',
      );
      fileLinkCreated = true;
    } catch {
      // Same platform limitation as above.
    }

    const inventory = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 2,
    });
    expect(inventory.inventory.candidates.map(({ relativePath }) => relativePath)).toEqual([
      'safe/safe.yaml',
    ]);
    if (directoryLinkCreated || fileLinkCreated) {
      expect(inventory.candidates.every(({ pipelineName }) => pipelineName !== 'Outside')).toBe(
        true,
      );
    }

    const tagmaDir = join(workspaceRoot, '.tagma');
    const realTagma = join(workspaceRoot, 'real-tagma');
    rmSync(tagmaDir, { recursive: true, force: true });
    mkdirSync(realTagma);
    let rootLinkCreated = false;
    try {
      symlinkSync(realTagma, tagmaDir, 'dir');
      rootLinkCreated = true;
    } catch {
      // Skip only the platform-specific symlink assertion.
    }
    if (rootLinkCreated) {
      expect(() =>
        buildChatOperationV2HostInventory({
          canonicalWorkspaceRoot: workspaceRoot,
          revision: 3,
        }),
      ).toThrow(expect.objectContaining({ code: 'unsafe_workspace' }));
    }

    const danglingWorkspace = makeWorkspace();
    const danglingTagma = join(danglingWorkspace, '.tagma');
    rmSync(danglingTagma, { recursive: true, force: true });
    let danglingLinkCreated = false;
    try {
      symlinkSync(join(danglingWorkspace, 'missing-tagma'), danglingTagma, 'dir');
      danglingLinkCreated = true;
    } catch {
      // Skip only the platform-specific symlink assertion.
    }
    if (danglingLinkCreated) {
      expect(() =>
        buildChatOperationV2HostInventory({
          canonicalWorkspaceRoot: danglingWorkspace,
          revision: 4,
        }),
      ).toThrow(expect.objectContaining({ code: 'unsafe_workspace' }));
    }
  });

  test('rejects invalid Host revisions and oversized candidate YAML without leaking paths', () => {
    const workspaceRoot = makeWorkspace();
    for (const revision of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        buildChatOperationV2HostInventory({
          canonicalWorkspaceRoot: workspaceRoot,
          revision,
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_revision' }));
    }

    const hugePath = writeFolderedPipeline(
      workspaceRoot,
      'huge',
      `pipeline:\n  name: Huge\n#${'x'.repeat(CHAT_OPERATION_V2_MAX_INVENTORY_YAML_BYTES)}`,
    );
    let caught: unknown;
    try {
      buildChatOperationV2HostInventory({
        canonicalWorkspaceRoot: workspaceRoot,
        revision: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'candidate_too_large' });
    expect(String(caught)).not.toContain(hugePath);

    const crowdedWorkspace = makeWorkspace();
    for (let index = 0; index <= CHAT_OPERATION_V2_MAX_INVENTORY_CANDIDATES; index += 1) {
      const stem = `pipeline-${String(index).padStart(3, '0')}`;
      writeFileSync(join(crowdedWorkspace, '.tagma', `${stem}.yaml`), 'pipeline:\n', 'utf8');
    }
    expect(() =>
      buildChatOperationV2HostInventory({
        canonicalWorkspaceRoot: crowdedWorkspace,
        revision: 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'inventory_too_large' }));
  });

  test('canonicalizes a workspace alias without changing identities when symlinks are supported', () => {
    const realWorkspace = makeWorkspace();
    writeFolderedPipeline(realWorkspace, 'demo', 'pipeline:\n  name: Demo\ntracks: []\n');
    const aliasParent = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-inventory-alias-'));
    tempRoots.push(aliasParent);
    const alias = join(aliasParent, 'workspace-link');
    try {
      symlinkSync(realWorkspace, alias, 'dir');
    } catch {
      return;
    }

    const direct = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: realWorkspace,
      revision: 4,
    });
    const throughAlias = buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: alias,
      revision: 4,
    });
    expect(throughAlias.inventory).toEqual(direct.inventory);
    expect(throughAlias.candidates).toEqual(direct.candidates);
    expect(JSON.stringify(throughAlias)).not.toContain(relative(aliasParent, alias));
  });
});
