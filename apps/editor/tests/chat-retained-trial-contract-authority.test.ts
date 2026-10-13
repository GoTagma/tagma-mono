import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listChatYamlStage,
  readChatYamlStageVerifiedRetainedTrialReceipt,
  type ChatYamlStageRetainedTrialOwner,
} from '../server/chat-yaml-staging.js';
import { readAuthenticatedServerRecordSync } from '../server/server-record-auth.js';
import { frozenIntent } from './chat-retained-trial-contract.fixture.js';
import { registerRetainedPlanAuthorityNegatives } from './chat-retained-trial-contract-authority.cases.js';
const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
interface BaselineProjection {
  version: 1;
  owner: ChatYamlStageRetainedTrialOwner;
  relativePath: string;
  intentDigest: string;
  originalPlanHash: string;
  originalPlanRaw: string;
  beforeSource: {
    stageSourceHash: string;
    entries: Array<{ relativePath: string; yamlHash: string; planHash: string | null }>;
  };
}
interface RecordProjection {
  version: 1;
  state: 'captured' | 'verified';
  baselineHash: string;
  baseline: BaselineProjection;
}
registerRetainedPlanAuthorityNegatives(async (value) => {
  const op = value.store.getOperation('operation-1')!;
  const descriptor = value.stageDescriptor ?? listChatYamlStage(value.workspace, op.stageId!, true);
  expect(descriptor.id).toBe(op.stageId!);
  const recordPath = join(descriptor.rootDir, 'retained-trial-contract.json');
  let record: RecordProjection | null = null;
  if (existsSync(recordPath)) {
    record = readAuthenticatedServerRecordSync<RecordProjection>(recordPath, {
      workspaceTagmaDir: join(value.workspaceRoot, '.tagma'),
      controlRoot: descriptor.rootDir,
      stageId: descriptor.id,
      kind: 'stage-metadata',
    });
    expect(record.version).toBe(1);
    expect(['captured', 'verified']).toContain(record.state);
    expect(record.baselineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.baseline.version).toBe(1);
    expect(record.baseline.relativePath).toBe('alpha/alpha.yaml');
    expect(record.baseline.intentDigest).toBe(sha256(frozenIntent));
    expect(record.baseline.originalPlanHash).toBe(sha256(value.committedPlanBytes));
    expect(record.baseline.originalPlanRaw).toBe(value.committedPlanBytes);
    const repair = value.openCode.incomingRequests.find((input) => input.purpose === 'repair');
    expect(repair).toBeDefined();
    expect(record.baseline.owner).toMatchObject({
      workspaceScopeId: 'scope-1',
      operationId: 'operation-1',
      operationGeneration: 1,
      stageId: descriptor.id,
      bindingId: op.bindingId,
      targetId: 'local-full-core-target',
      invocationId: repair!.invocationId,
      requestDigest: sha256(repair!.canonicalRequestBytes),
      repairAttempt: 1,
    });
    const before = record.baseline.beforeSource.entries.find(
      (entry) => entry.relativePath === 'alpha/alpha.yaml',
    );
    expect(before).toMatchObject({
      yamlHash: sha1(value.originalYaml),
      planHash: sha256(value.committedPlanBytes),
    });
    expect(record.baseline.beforeSource.stageSourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(recordPath).byteLength).toBeGreaterThan(0);
  }
  // Current-source authenticated authority is distinct from the valid historical captured baseline.
  const verified = readChatYamlStageVerifiedRetainedTrialReceipt(value.workspace, {
    stageId: descriptor.id,
    relativePath: 'alpha/alpha.yaml',
    intentText: frozenIntent,
  });
  return {
    baselinePresent: record !== null,
    verified: verified !== null,
    phase: record?.state ?? null,
  };
});
