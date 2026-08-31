/* eslint-disable @typescript-eslint/no-explicit-any -- OpenCode 1.18.18 mixes generated compatibility and native-v2 clients behind runtime-only extension surfaces. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { createOpencodeClient as createOpencodeV2Client } from '@opencode-ai/sdk/v2/client';

import { sameFilesystemPathCoordinate } from '../../shared/filesystem-paths.js';
import { CREATE_NEW_PIPELINE_ACTION_KIND } from '../../shared/requested-action.js';
import { pipelineTrialPlanPath } from '../chat-pipeline-trial-plan.js';
import {
  cancelChatPipelineTrial,
  trialRunChatYamlStage,
  type ChatPipelineTrialRunResult,
} from '../chat-pipeline-trial-run.js';
import {
  advanceChatYamlStageSessionRelocation,
  clearChatYamlStageSessionRelocation,
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStageWithDisposition,
  listChatYamlStage,
  prepareChatYamlStageSessionRelocation,
  readChatYamlStageSessionRelocation,
  type ChatYamlStageDescriptor,
  type ChatYamlStageSessionRelocationBinding,
} from '../chat-yaml-staging.js';
import { createStreamingLoopbackFetch } from '../loopback-fetch.js';
import { ensureOpencode, ensureRealTagmaDirectory } from '../opencode-lifecycle.js';
import { TAGMA_PIPELINE_AGENT, TAGMA_TRIAL_PLANNER_AGENT } from '../opencode-seed.js';
import {
  assertPipelineYamlPath,
  pipelineCompileLogPath,
  pipelineLayoutPath,
  pipelineRequirementsPath,
  sanitizePipelineStem,
  tagmaDirOf,
} from '../pipeline-paths.js';
import { pipelineManifestPath } from '../pipeline-manifest.js';
import {
  ensureServerRecordControlRootSync,
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from '../server-record-auth.js';
import { WorkspaceState } from '../workspace-state.js';
import type { ChatOperationV2Admission } from './admission.js';
import {
  ChatOperationV2AuthoringProtocolError,
  parseChatOperationV2SessionRelocation,
  sealChatOperationV2SessionRelocation,
  type ChatOperationV2AuthoringInvocationRequest,
  type ChatOperationV2AuthoringInvocationPurpose,
  type ChatOperationV2AuthoringInvocationResult,
  type ChatOperationV2AuthoringInvocationUsage,
  type ChatOperationV2AuthoringRuntime,
  type ChatOperationV2AuthoringStage,
  type ChatOperationV2AuthoringVerificationResult,
  type ChatOperationV2TrialPlanRequest,
  type ChatOperationV2RuntimeInteractiveRequest,
  type ChatOperationV2SessionRelocation,
} from './authoring.js';
import type { ChatOperationV2BindingReservedRecord } from './binding.js';
import type { ChatOperationV2InteractiveForwardingCommand } from './interactive-requests.js';
import {
  OpenCodeInvocationController,
  sha256CanonicalOpenCodeRequest,
  type OpenCodeInvocationOutcome,
  type OpenCodeInvocationStore,
} from './opencode-invocation.js';
import {
  OpenCodeSdkAdapter,
  openCodeProviderFailureCode,
  type OpenCodeAdapterSdkClient,
} from './opencode-adapter.js';

const AUTHORING_AUTHORITY_VERSION = 1 as const;
const AUTHORING_AUTHORITY_FILE = 'chat-operation-v2-authoring-runtime.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_DIAGNOSTIC_CODES = 16;
const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function directoryIdentity(value: string): string {
  const canonical = realpathSync.native(value);
  const comparable = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return sha256(`tagma-chat-operation-v2-directory\0${comparable}`);
}

function safeCode(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return SAFE_CODE_RE.test(normalized) ? normalized : fallback;
}

/**
 * OpenCode 1.18.18 exposes `/session/status` as a sparse activity map: an idle
 * session may be absent altogether. Only an explicit idle record or absence is
 * quiescent; malformed and explicitly active records fail closed as active.
 */
export function isOpenCodeSessionStatusActive(status: unknown): boolean {
  if (status === undefined) return false;
  return !(
    typeof status === 'object' &&
    status !== null &&
    !Array.isArray(status) &&
    (status as { readonly type?: unknown }).type === 'idle'
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function replaceControlCharacters(value: string): string {
  return [...value].map((character) => (hasControlCharacter(character) ? ' ' : character)).join('');
}

function exactPipelineRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    hasControlCharacter(value)
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Binding target is not a canonical relative pipeline coordinate.',
    );
  }
  const segments = value.split('/');
  if (segments.length !== 2 || !/\.ya?ml$/i.test(segments[1] ?? '')) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Binding target must identify one same-named pipeline folder.',
    );
  }
  const stem = sanitizePipelineStem(segments[0]);
  if (segments[1].replace(/\.ya?ml$/i, '') !== stem) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Binding target folder and YAML stem differ.',
    );
  }
  return value;
}

function stageSnapshotHash(descriptor: ChatYamlStageDescriptor): string {
  return sha256(
    `tagma-chat-operation-v2-stage-snapshot\0${canonicalJson({
      stageId: descriptor.id,
      activeRelativePath: descriptor.activeRelativePath,
      createTargetRelativePath: descriptor.createTargetRelativePath,
      entries: [...descriptor.entries]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((entry) => ({
          relativePath: entry.relativePath,
          contentHash: entry.contentHash,
          layoutHash: entry.layoutHash,
          requirementsHash: entry.requirementsHash,
          supportHash: entry.supportHash ?? null,
          trialPlanHash: entry.trialPlanHash,
        })),
    })}`,
  );
}

const COMMIT_SUPPORT_MAX_ENTRIES = 1_024;
const COMMIT_SUPPORT_MAX_DEPTH = 32;
const COMMIT_SUPPORT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const COMMIT_SUPPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ManagedChatOperationV2CommitArtifactKind =
  'yaml' | 'layout' | 'requirements' | 'support';

export interface ManagedChatOperationV2CommitArtifactProjection {
  readonly artifactId: string;
  readonly kind: ManagedChatOperationV2CommitArtifactKind;
  readonly supportRelativePath: string | null;
  readonly stagedRelativePath: string;
  readonly newHash: string | null;
}

export interface ManagedChatOperationV2CommitArtifactSetProjection {
  readonly artifacts: readonly ManagedChatOperationV2CommitArtifactProjection[];
  readonly artifactSetHash: string;
}

function regularFileHashOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Commit artifact must be a regular non-symlink file.');
  }
  if (stat.size > COMMIT_SUPPORT_MAX_FILE_BYTES) {
    throw new Error('Commit artifact exceeds its bounded file size.');
  }
  return sha256(readFileSync(path));
}

function supportReservedNames(yamlPath: string): Set<string> {
  return new Set(
    [
      yamlPath,
      pipelineLayoutPath(yamlPath),
      pipelineRequirementsPath(yamlPath),
      pipelineManifestPath(yamlPath),
      pipelineCompileLogPath(yamlPath),
      pipelineTrialPlanPath(yamlPath),
    ].map((path) => basename(path).toLowerCase()),
  );
}

function listSupportRelativePaths(yamlPath: string): readonly string[] {
  const root = dirname(yamlPath);
  if (!existsSync(root)) return [];
  const reserved = supportReservedNames(yamlPath);
  const files: string[] = [];
  let entriesSeen = 0;
  let bytesSeen = 0;
  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > COMMIT_SUPPORT_MAX_DEPTH) {
      throw new Error('Commit support tree exceeds its nesting bound.');
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory() && entry.name.toLowerCase() === '.opencode') continue;
      if (!relativeDirectory && reserved.has(entry.name.toLowerCase())) continue;
      if (/\.trial-plan\.json$/i.test(entry.name)) continue;
      entriesSeen += 1;
      if (entriesSeen > COMMIT_SUPPORT_MAX_ENTRIES) {
        throw new Error('Commit support tree exceeds its entry bound.');
      }
      const absolute = join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Commit support tree contains a symbolic link.');
      if (stat.isDirectory()) {
        visit(absolute, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.size > COMMIT_SUPPORT_MAX_FILE_BYTES) {
        throw new Error('Commit support artifact is not one bounded regular file.');
      }
      bytesSeen += stat.size;
      if (bytesSeen > COMMIT_SUPPORT_MAX_TOTAL_BYTES) {
        throw new Error('Commit support tree exceeds its total byte bound.');
      }
      files.push(relativePath.replace(/\\/g, '/'));
    }
  };
  visit(root, '', 0);
  return files.sort();
}

function commitArtifactId(
  kind: ManagedChatOperationV2CommitArtifactKind,
  logicalPath: string,
): string {
  return `artifact_${sha256(`tagma-chat-operation-v2-artifact\0${kind}\0${logicalPath}`).slice(0, 48)}`;
}

export function deriveManagedChatOperationV2CommitArtifactSet(
  descriptor: ChatYamlStageDescriptor,
): ManagedChatOperationV2CommitArtifactSetProjection {
  const workingRelativePath = descriptor.activeRelativePath ?? descriptor.createTargetRelativePath;
  if (!workingRelativePath) throw new Error('Managed stage has no commit working target.');
  const stagedYamlPath = resolve(descriptor.agentTagmaDir, workingRelativePath);
  const baseYamlPath = resolve(tagmaDirOf(descriptor.baseWorkspaceDir), workingRelativePath);
  const fixed = [
    { kind: 'yaml' as const, path: stagedYamlPath },
    { kind: 'layout' as const, path: pipelineLayoutPath(stagedYamlPath) },
    { kind: 'requirements' as const, path: pipelineRequirementsPath(stagedYamlPath) },
  ];
  const supportPaths = new Set([
    ...listSupportRelativePaths(stagedYamlPath),
    ...listSupportRelativePaths(baseYamlPath),
  ]);
  const artifacts: ManagedChatOperationV2CommitArtifactProjection[] = fixed.map(
    ({ kind, path }) => ({
      artifactId: commitArtifactId(kind, kind),
      kind,
      supportRelativePath: null,
      stagedRelativePath: relative(descriptor.agentTagmaDir, path).replace(/\\/g, '/'),
      newHash: regularFileHashOrNull(path),
    }),
  );
  for (const supportRelativePath of [...supportPaths].sort()) {
    const path = resolve(dirname(stagedYamlPath), ...supportRelativePath.split('/'));
    artifacts.push({
      artifactId: commitArtifactId('support', supportRelativePath),
      kind: 'support',
      supportRelativePath,
      stagedRelativePath: relative(descriptor.agentTagmaDir, path).replace(/\\/g, '/'),
      newHash: regularFileHashOrNull(path),
    });
  }
  artifacts.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(artifacts.map(({ artifactId }) => artifactId)).size !== artifacts.length) {
    throw new Error('Commit artifact identity collision.');
  }
  const frozen = Object.freeze(artifacts.map((artifact) => Object.freeze({ ...artifact })));
  return Object.freeze({
    artifacts: frozen,
    artifactSetHash: sha256(
      JSON.stringify(frozen.map(({ artifactId, newHash }) => [artifactId, newHash])),
    ),
  });
}

export interface ManagedChatOperationV2AuthoringStageSnapshot {
  readonly stageId: string;
  readonly sourceDirectory: string;
  readonly stageDirectory: string;
  readonly workingRelativePath: string;
  readonly snapshotHash: string;
  readonly artifactSetHash: string;
  readonly artifactCount: number;
}

export interface ManagedChatOperationV2InvocationAuthority {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
  /** Renderer correlation metadata only; never an OpenCode or binding identity. */
  readonly conversationId: string;
  readonly requestDigest: string;
  readonly executionMessageId: string;
  readonly baselineSnapshotHash: string;
  readonly executionSubmitted: boolean;
  readonly completed: Extract<
    ChatOperationV2AuthoringInvocationResult,
    { kind: 'completed' }
  > | null;
}

export interface ManagedChatOperationV2AuthoringAuthorityRecord {
  readonly version: typeof AUTHORING_AUTHORITY_VERSION;
  readonly workspaceScopeId: string;
  /** Renderer correlation metadata only; populated from the sealed admission. */
  readonly conversationId: string | null;
  readonly sessionId: string;
  readonly intent: 'create' | 'edit';
  readonly originHash: string | null;
  readonly targetRelativePath: string;
  readonly workingRelativePath: string;
  readonly sourceDirectory: string;
  readonly stageDirectory: string;
  readonly stage: ChatOperationV2AuthoringStage;
  readonly relocation: ChatOperationV2SessionRelocation | null;
  readonly invocations: Readonly<Record<string, ManagedChatOperationV2InvocationAuthority>>;
}

export interface ManagedChatOperationV2CompileResult {
  readonly success: boolean;
  readonly parseOk: boolean;
  readonly summary: string;
  readonly validation: {
    readonly errors: readonly { readonly path: string; readonly message: string }[];
    readonly warnings: readonly { readonly path: string; readonly message: string }[];
  };
}

export interface ManagedChatOperationV2AuthoringStagingAdapter {
  createStage(input: {
    readonly stageId: string;
    readonly intent: 'create' | 'edit';
    readonly targetRelativePath: string;
    readonly sourceRelativePath: string | null;
    readonly originHash: string | null;
  }): Promise<ManagedChatOperationV2AuthoringStageSnapshot>;
  inspectStage(stageId: string): Promise<ManagedChatOperationV2AuthoringStageSnapshot | null>;
  discardStage(stageId: string): Promise<'discarded' | 'missing'>;
  readAuthority(stageId: string): Promise<ManagedChatOperationV2AuthoringAuthorityRecord | null>;
  writeAuthority(
    stageId: string,
    record: ManagedChatOperationV2AuthoringAuthorityRecord,
  ): Promise<void>;
  readRelocation(stageId: string): Promise<ChatYamlStageSessionRelocationBinding | null>;
  prepareRelocation(input: {
    readonly stageId: string;
    readonly sessionId: string;
    readonly relocationId: string;
  }): Promise<ChatYamlStageSessionRelocationBinding>;
  advanceRelocation(input: {
    readonly stageId: string;
    readonly sessionId: string;
    readonly relocationId: string;
    readonly expectedPhase: 'prepared' | 'staged' | 'restoring';
    readonly phase: 'prepared' | 'staged' | 'restoring';
  }): Promise<ChatYamlStageSessionRelocationBinding>;
  clearRelocation(input: {
    readonly stageId: string;
    readonly sessionId: string;
    readonly relocationId: string;
    readonly expectedPhase: 'prepared' | 'restoring';
    readonly verifiedHomeDirectory?: string;
    readonly verifiedSessionMissing?: true;
  }): Promise<void>;
  compileStage(
    stageId: string,
    targetRelativePath: string,
  ): Promise<ManagedChatOperationV2CompileResult>;
  runTrial(input: {
    readonly stageId: string;
    readonly targetRelativePath: string;
    readonly trialId: string;
    readonly signal: AbortSignal;
  }): Promise<ChatPipelineTrialRunResult>;
}

export interface ManagedChatOperationV2OpenCodeSessionTreeEntry {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly directory: string;
  readonly busy: boolean;
  readonly workspaceBound?: boolean;
}

export type ManagedChatOperationV2AdmissionResult =
  | {
      readonly kind: 'admitted';
      readonly admittedAggregateSeq: number;
      readonly source: { readonly aggregateSeq: number; readonly eventId: string };
    }
  | { readonly kind: 'submitted_unknown'; readonly code: string }
  | { readonly kind: 'conflict'; readonly code: string };

export type ManagedChatOperationV2AuthoringExecutionResult =
  | {
      readonly kind: 'completed';
      readonly text: string | null;
      readonly finishCode: string;
      readonly usage: ChatOperationV2AuthoringInvocationUsage | null;
    }
  | {
      readonly kind: 'provider_unavailable';
      readonly code: string;
      readonly submissionUnknown?: boolean;
    }
  | { readonly kind: 'cancelled'; readonly code: string };

export type ManagedChatOperationV2ExecutionSettlement =
  | {
      readonly kind: 'settled';
      readonly executionMessageId: string;
      readonly finishCode: string;
      readonly text: string | null;
      readonly usage: ChatOperationV2AuthoringInvocationUsage | null;
      readonly source: { readonly aggregateSeq: number; readonly eventId: string };
    }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'unavailable'; readonly code: string };

export interface ManagedChatOperationV2AuthoringOpenCodeAdapter {
  ensureSession(input: {
    readonly sessionId: string;
    readonly sourceDirectory: string;
  }): Promise<void>;
  listSessionTree(input: {
    readonly rootSessionId: string;
  }): Promise<readonly ManagedChatOperationV2OpenCodeSessionTreeEntry[]>;
  moveSession(input: {
    readonly sessionId: string;
    readonly destinationDirectory: string;
  }): Promise<void>;
  admit(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
    readonly canonicalRequestBytes: Uint8Array;
    readonly stageDirectory: string;
  }): Promise<ManagedChatOperationV2AdmissionResult>;
  reconcileAdmission(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
    readonly canonicalRequestBytes: Uint8Array;
    readonly stageDirectory: string;
  }): Promise<ManagedChatOperationV2AdmissionResult>;
  execute(input: {
    readonly invocationId: string;
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
    readonly intent: 'create' | 'edit';
    readonly stageDirectory: string;
    readonly targetRelativePath: string;
    readonly trialPlanRequest: ChatOperationV2TrialPlanRequest | null;
    readonly admission: ChatOperationV2Admission;
    readonly canonicalRequestBytes: Uint8Array;
    readonly signal: AbortSignal;
    readonly requestInteractive: (
      request: ChatOperationV2RuntimeInteractiveRequest,
    ) => Promise<void>;
  }): Promise<ManagedChatOperationV2AuthoringExecutionResult>;
  reconcileExecution(input: {
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly afterAggregateSeq: number;
    readonly stageDirectory: string;
  }): Promise<ManagedChatOperationV2ExecutionSettlement>;
  getSessionActivity(input: {
    readonly rootSessionId: string;
    readonly allowedDirectories: readonly string[];
  }): Promise<'busy' | 'idle' | 'missing'>;
  interruptInvocation(input: {
    readonly operationId: string;
    readonly invocationId: string;
  }): Promise<void>;
  forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand): Promise<void>;
}

type CommitPreparer = NonNullable<ChatOperationV2AuthoringRuntime['prepareCommit']>;

export interface CreateManagedChatOperationV2AuthoringRuntimeOptions {
  readonly workspaceScopeId: string;
  readonly workspace?: WorkspaceState;
  readonly invocationStore?: OpenCodeInvocationStore;
  readonly staging?: ManagedChatOperationV2AuthoringStagingAdapter;
  readonly openCode?: ManagedChatOperationV2AuthoringOpenCodeAdapter;
  readonly commitPreparer: CommitPreparer;
  /** Host inventory resolver for edit origins; never renderer path input. */
  readonly resolveTarget?: (input: {
    readonly targetId: string;
    readonly binding: ChatOperationV2BindingReservedRecord;
    readonly intent: 'create' | 'edit';
    readonly originHash: string | null;
  }) =>
    | { readonly sourceRelativePath: string | null }
    | Promise<{ readonly sourceRelativePath: string | null }>;
  readonly now?: () => number;
}

class ProductionStagingAdapter implements ManagedChatOperationV2AuthoringStagingAdapter {
  constructor(private readonly workspace: WorkspaceState) {}

  private workDir(): string {
    if (!this.workspace.workDir) throw new Error('Workspace directory is unavailable.');
    return this.workspace.workDir;
  }

  private descriptor(stageId: string): ChatYamlStageDescriptor {
    return listChatYamlStage(this.workspace, stageId, true);
  }

  private snapshot(
    descriptor: ChatYamlStageDescriptor,
  ): ManagedChatOperationV2AuthoringStageSnapshot {
    const workingRelativePath =
      descriptor.activeRelativePath ?? descriptor.createTargetRelativePath;
    if (!workingRelativePath || descriptor.pipelineBinding !== null) {
      throw new Error('Stage is not an isolated Host V2 target.');
    }
    const commitArtifacts = deriveManagedChatOperationV2CommitArtifactSet(descriptor);
    return {
      stageId: descriptor.id,
      sourceDirectory: ensureRealTagmaDirectory(this.workDir()),
      stageDirectory: realpathSync.native(descriptor.agentTagmaDir),
      workingRelativePath,
      snapshotHash: stageSnapshotHash(descriptor),
      artifactSetHash: commitArtifacts.artifactSetHash,
      artifactCount: commitArtifacts.artifacts.length,
    };
  }

  async createStage(input: {
    stageId: string;
    intent: 'create' | 'edit';
    targetRelativePath: string;
    sourceRelativePath: string | null;
    originHash: string | null;
  }): Promise<ManagedChatOperationV2AuthoringStageSnapshot> {
    const workDir = this.workDir();
    const source = input.sourceRelativePath
      ? assertPipelineYamlPath(
          workDir,
          resolve(tagmaDirOf(workDir), input.sourceRelativePath),
          'Chat Operation V2 authenticated edit origin',
        )
      : null;
    const liveTarget = assertPipelineYamlPath(
      workDir,
      resolve(tagmaDirOf(workDir), input.targetRelativePath),
      'Chat Operation V2 isolated publish target',
    );
    if (input.intent === 'edit') {
      if (!source || !existsSync(source) || input.originHash === null) {
        throw new Error('Authenticated edit origin is unavailable.');
      }
      if (sha256(readFileSync(source)) !== input.originHash) {
        throw new Error('Authenticated edit origin hash changed before staging.');
      }
    } else if (source || input.originHash !== null || existsSync(liveTarget)) {
      throw new Error('Authenticated create target is unavailable.');
    }
    const descriptor = createChatYamlStage(this.workspace, {
      stageId: input.stageId,
      ...(input.intent === 'edit'
        ? {
            activePath: source,
            hostEditTargetRelativePath: input.targetRelativePath,
          }
        : {
            requestedAction: CREATE_NEW_PIPELINE_ACTION_KIND,
            hostCreateTargetRelativePath: input.targetRelativePath,
          }),
    });
    const snapshot = this.snapshot(descriptor);
    if (snapshot.workingRelativePath !== input.targetRelativePath) {
      throw new Error('Authenticated staged working and publish targets diverged.');
    }
    return snapshot;
  }

  async inspectStage(
    stageId: string,
  ): Promise<ManagedChatOperationV2AuthoringStageSnapshot | null> {
    const root = join(tagmaDirOf(this.workDir()), '.chat-staging', stageId);
    if (!existsSync(root)) return null;
    return this.snapshot(this.descriptor(stageId));
  }

  async discardStage(stageId: string): Promise<'discarded' | 'missing'> {
    const disposition = discardChatYamlStageWithDisposition(this.workspace, stageId, true);
    if (disposition === 'finalized')
      throw new Error('V2 runtime cannot discard a finalized stage.');
    return disposition;
  }

  private authorityPath(stageId: string): { path: string; context: ServerRecordContext } {
    const descriptor = this.descriptor(stageId);
    const sourceDirectory = ensureRealTagmaDirectory(this.workDir());
    return {
      path: join(descriptor.rootDir, AUTHORING_AUTHORITY_FILE),
      context: {
        workspaceTagmaDir: sourceDirectory,
        controlRoot: descriptor.rootDir,
        stageId,
        kind: 'stage-metadata',
      },
    };
  }

  async readAuthority(
    stageId: string,
  ): Promise<ManagedChatOperationV2AuthoringAuthorityRecord | null> {
    const authority = this.authorityPath(stageId);
    if (!existsSync(authority.path)) return null;
    return readAuthenticatedServerRecordSync<ManagedChatOperationV2AuthoringAuthorityRecord>(
      authority.path,
      authority.context,
    );
  }

  async writeAuthority(
    stageId: string,
    record: ManagedChatOperationV2AuthoringAuthorityRecord,
  ): Promise<void> {
    const authority = this.authorityPath(stageId);
    ensureServerRecordControlRootSync(authority.context);
    writeAuthenticatedServerRecordSync(authority.path, authority.context, record);
  }

  async readRelocation(stageId: string): Promise<ChatYamlStageSessionRelocationBinding | null> {
    return readChatYamlStageSessionRelocation(this.workspace, stageId, true);
  }

  async prepareRelocation(input: {
    stageId: string;
    sessionId: string;
    relocationId: string;
  }): Promise<ChatYamlStageSessionRelocationBinding> {
    return prepareChatYamlStageSessionRelocation(this.workspace, input, true);
  }

  async advanceRelocation(input: {
    stageId: string;
    sessionId: string;
    relocationId: string;
    expectedPhase: 'prepared' | 'staged' | 'restoring';
    phase: 'prepared' | 'staged' | 'restoring';
  }): Promise<ChatYamlStageSessionRelocationBinding> {
    return advanceChatYamlStageSessionRelocation(this.workspace, input, true);
  }

  async clearRelocation(input: {
    stageId: string;
    sessionId: string;
    relocationId: string;
    expectedPhase: 'prepared' | 'restoring';
    verifiedHomeDirectory?: string;
    verifiedSessionMissing?: true;
  }): Promise<void> {
    clearChatYamlStageSessionRelocation(this.workspace, input as never, true);
  }

  async compileStage(
    stageId: string,
    targetRelativePath: string,
  ): Promise<ManagedChatOperationV2CompileResult> {
    return compileChatYamlStage(
      this.workspace,
      stageId,
      targetRelativePath,
      undefined,
      false,
      true,
    );
  }

  async runTrial(input: {
    stageId: string;
    targetRelativePath: string;
    trialId: string;
    signal: AbortSignal;
  }): Promise<ChatPipelineTrialRunResult> {
    const abort = () =>
      cancelChatPipelineTrial(this.workspace, { stageId: input.stageId, trialId: input.trialId });
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      return await trialRunChatYamlStage(this.workspace, {
        stageId: input.stageId,
        relativePath: input.targetRelativePath,
        trialId: input.trialId,
        trustedOperationV2: true,
      });
    } finally {
      input.signal.removeEventListener('abort', abort);
    }
  }
}

function sdkRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function unwrapSdk<T>(
  request: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const result = await request;
  if (result.error !== undefined || result.data === undefined || !result.response.ok) {
    throw Object.assign(new Error('OpenCode request failed.'), { detail: result.error });
  }
  return result.data;
}

class ProductionOpenCodeAdapter implements ManagedChatOperationV2AuthoringOpenCodeAdapter {
  private readonly nativeByDirectory = new Map<string, OpenCodeSdkAdapter>();
  private readonly activeInteractive = new Map<
    string,
    {
      readonly sessionId: string;
      readonly directory: string;
      readonly processGeneration: number;
      readonly pending: Map<string, 'permission' | 'question'>;
    }
  >();

  constructor(
    private readonly sourceDirectory: string,
    private readonly store: OpenCodeInvocationStore,
  ) {}

  private async client(directory: string): Promise<{ client: any; processGeneration: number }> {
    const handle = await ensureOpencode(this.sourceDirectory);
    return {
      client: createOpencodeV2Client({
        baseUrl: handle.baseUrl,
        directory,
        headers: { Authorization: handle.auth.authorization },
        throwOnError: false,
        fetch: createStreamingLoopbackFetch(handle.baseUrl),
      }) as any,
      processGeneration: handle.pid,
    };
  }

  private native(directory: string): OpenCodeSdkAdapter {
    let adapter = this.nativeByDirectory.get(directory);
    if (!adapter) {
      adapter = new OpenCodeSdkAdapter({
        workspaceDirectory: directory,
        resolveClient: async () =>
          (await this.client(directory)).client as OpenCodeAdapterSdkClient,
      });
      this.nativeByDirectory.set(directory, adapter);
    }
    return adapter;
  }

  async ensureSession(input: { sessionId: string; sourceDirectory: string }): Promise<void> {
    const result = await this.native(input.sourceDirectory).createSession({
      sessionId: input.sessionId,
    });
    if (result.kind === 'conflict') throw new Error('OpenCode session identity conflict.');
    const tree = await this.listSessionTree({ rootSessionId: input.sessionId });
    if (!tree.some(({ sessionId }) => sessionId === input.sessionId)) {
      throw new Error('OpenCode session identity was not created or recovered.');
    }
  }

  async listSessionTree(input: {
    rootSessionId: string;
  }): Promise<readonly ManagedChatOperationV2OpenCodeSessionTreeEntry[]> {
    const { client } = await this.client(this.sourceDirectory);
    let root: any;
    try {
      root = await unwrapSdk(client.session.get({ sessionID: input.rootSessionId }));
    } catch (error) {
      const detail = sdkRecord((error as { detail?: unknown }).detail);
      if (detail?.name === 'SessionNotFoundError' || detail?._tag === 'SessionNotFoundError')
        return [];
      throw error;
    }
    const sessions: any[] = [];
    const pending = [root];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const session = pending.pop();
      if (!session || typeof session.id !== 'string' || seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
      const children = await unwrapSdk<any[]>(client.session.children({ sessionID: session.id }));
      pending.push(...children);
    }
    return sessions.map((session) => ({
      sessionId: session.id,
      parentSessionId: typeof session.parentID === 'string' ? session.parentID : null,
      directory: session.directory,
      busy: false,
      workspaceBound: session.workspaceID !== undefined,
    }));
  }

  async moveSession(input: { sessionId: string; destinationDirectory: string }): Promise<void> {
    const { client } = await this.client(this.sourceDirectory);
    await unwrapSdk(
      client.experimental.controlPlane.moveSession({
        sessionID: input.sessionId,
        destination: { directory: input.destinationDirectory },
        moveChanges: false,
      }),
    );
  }

  private async admission(
    input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['admit']>[0],
  ): Promise<ManagedChatOperationV2AdmissionResult> {
    // Pinned 1.18.18 conformance proves the controller's delivery=queue/resume=false
    // digest marker is provider-free. `execute()` below is therefore the sole
    // provider execution for this invocation; never replace this with resume=true.
    const native = this.native(input.stageDirectory);
    const sourceNative = this.native(this.sourceDirectory);
    const controller = new OpenCodeInvocationController({
      store: this.store,
      client: {
        createSession: (request) => sourceNative.createSession(request),
        prompt: (request) => native.prompt(request),
        listHistory: (request) => native.listHistory(request),
      },
    });
    const outcome = await controller.invoke({
      operationId: input.operationId,
      invocationId: input.invocationId,
      purpose: input.purpose,
      sessionId: input.sessionId,
      inputId: input.inputId,
      canonicalRequestBytes: input.canonicalRequestBytes,
    });
    if (outcome.kind === 'conflict') return { kind: 'conflict', code: outcome.code };
    if (outcome.kind !== 'admitted') {
      return { kind: 'submitted_unknown', code: 'submitted_unknown' };
    }
    const source = await this.findAdmissionSource(native, outcome, input.canonicalRequestBytes);
    return { kind: 'admitted', admittedAggregateSeq: outcome.admittedAggregateSeq, source };
  }

  async admit(input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['admit']>[0]) {
    return this.admission(input);
  }

  async reconcileAdmission(
    input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['reconcileAdmission']>[0],
  ) {
    return this.admission(input);
  }

  private async findAdmissionSource(
    native: OpenCodeSdkAdapter,
    outcome: Extract<OpenCodeInvocationOutcome, { kind: 'admitted' }>,
    bytes: Uint8Array,
  ): Promise<{ aggregateSeq: number; eventId: string }> {
    const digest = sha256CanonicalOpenCodeRequest(bytes);
    let after = Math.max(0, outcome.admittedAggregateSeq - 1);
    for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
      const page = await native.listHistory({ sessionId: outcome.sessionId, after, limit: 100 });
      for (const record of page.records) {
        if (
          record.inputId === outcome.inputId &&
          record.requestDigest === digest &&
          record.aggregateSeq === outcome.admittedAggregateSeq
        ) {
          return { aggregateSeq: record.aggregateSeq, eventId: record.eventId };
        }
      }
      if (!page.hasMore || page.records.length === 0) break;
      after = page.records.at(-1)!.aggregateSeq;
    }
    throw new Error('OpenCode admission source event is unavailable.');
  }

  async execute(
    input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['execute']>[0],
  ): Promise<ManagedChatOperationV2AuthoringExecutionResult> {
    const { client, processGeneration } = await this.client(input.stageDirectory);
    this.activeInteractive.set(input.invocationId, {
      sessionId: input.sessionId,
      directory: input.stageDirectory,
      processGeneration,
      pending: new Map(),
    });
    let settled = false;
    const monitor = this.monitorInteractive(client, processGeneration, input, () => settled);
    try {
      const prompt = buildManagedChatOperationV2ExecutionPrompt(input);
      const sdkResult = await client.session.prompt(
        {
          sessionID: input.sessionId,
          messageID: input.executionMessageId,
          agent: prompt.agent,
          model: { providerID: input.admission.provider, modelID: input.admission.model },
          ...(input.admission.variant ? { variant: input.admission.variant } : {}),
          system: prompt.system,
          parts: [
            {
              type: 'text',
              text: prompt.text,
            },
          ],
        },
        { signal: input.signal },
      );
      if (
        sdkResult.error !== undefined ||
        sdkResult.data === undefined ||
        !sdkResult.response?.ok
      ) {
        return {
          kind: 'provider_unavailable',
          code: openCodeProviderFailureCode(
            sdkResult.error,
            Number.isInteger(sdkResult.response?.status) ? sdkResult.response.status : null,
          ),
        };
      }
      const result = sdkResult.data;
      const info = sdkRecord(result?.info);
      if (info?.error !== undefined && info.error !== null) {
        return {
          kind: 'provider_unavailable',
          code: openCodeProviderFailureCode(info.error),
        };
      }
      return {
        kind: 'completed',
        text: responseText(result),
        finishCode: safeCode(String(info?.finish ?? 'stop'), 'stop'),
        usage: parseAuthoringUsage(info),
      };
    } catch (error) {
      if (input.signal.aborted) return { kind: 'cancelled', code: 'cancelled_precommit' };
      const code = openCodeProviderFailureCode(error);
      return {
        kind: 'provider_unavailable',
        code,
        ...(code === 'provider_invocation_failed' || code === 'provider_unavailable'
          ? { submissionUnknown: true as const }
          : {}),
      };
    } finally {
      settled = true;
      void monitor.catch(() => undefined);
      this.activeInteractive.delete(input.invocationId);
    }
  }

  async reconcileExecution(input: {
    sessionId: string;
    executionMessageId: string;
    afterAggregateSeq: number;
    stageDirectory: string;
  }): Promise<ManagedChatOperationV2ExecutionSettlement> {
    const { client } = await this.client(input.stageDirectory);
    let after = input.afterAggregateSeq;
    let sawPrompt = false;
    let text = '';
    for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
      let envelope: any;
      try {
        envelope = await unwrapSdk<any>(
          client.v2.session.history({ sessionID: input.sessionId, after, limit: 100 }),
        );
      } catch {
        return { kind: 'unavailable', code: 'execution_history_unavailable' };
      }
      const events = Array.isArray(envelope?.data) ? envelope.data : [];
      let nextAfter = after;
      for (const event of events) {
        const eventRecord = sdkRecord(event);
        const data = sdkRecord(eventRecord?.data);
        const durable = sdkRecord(eventRecord?.durable);
        const seq = Number(durable?.seq ?? 0);
        if (!Number.isSafeInteger(seq) || seq <= nextAfter) {
          return { kind: 'unavailable', code: 'execution_history_conflict' };
        }
        nextAfter = seq;
        if (eventRecord?.type === 'session.next.prompted') {
          if (data?.messageID === input.executionMessageId) {
            sawPrompt = true;
            continue;
          }
          if (sawPrompt) return { kind: 'unavailable', code: 'execution_settlement_missing' };
        }
        if (!sawPrompt) continue;
        if (eventRecord?.type === 'session.next.text.ended' && typeof data?.text === 'string') {
          text += data.text;
          if (encoder.encode(text).byteLength > 1024 * 1024) text = '';
        }
        if (eventRecord?.type === 'session.next.step.failed') {
          return { kind: 'unavailable', code: 'execution_failed' };
        }
        if (eventRecord?.type === 'session.next.step.ended') {
          if (typeof eventRecord.id !== 'string') {
            return { kind: 'unavailable', code: 'execution_history_conflict' };
          }
          const finishCode = safeCode(String(data?.finish ?? 'stop'), 'stop');
          if (
            finishCode === 'tool_calls' ||
            finishCode === 'tool_call' ||
            finishCode === 'tool_use' ||
            finishCode === 'continue'
          ) {
            continue;
          }
          return {
            kind: 'settled',
            executionMessageId: input.executionMessageId,
            finishCode,
            text: text.trim() || null,
            usage: parseAuthoringUsage(data),
            source: { aggregateSeq: seq, eventId: eventRecord.id },
          };
        }
      }
      if (envelope?.hasMore !== true || nextAfter === after) {
        return sawPrompt
          ? { kind: 'in_progress' }
          : { kind: 'unavailable', code: 'execution_prompt_missing' };
      }
      after = nextAfter;
    }
    return { kind: 'unavailable', code: 'execution_history_limit' };
  }

  private async monitorInteractive(
    client: any,
    processGeneration: number,
    input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['execute']>[0],
    settled: () => boolean,
  ): Promise<void> {
    const seen = new Set<string>();
    while (!settled() && !input.signal.aborted) {
      const [permissions, questions] = await Promise.all([
        unwrapSdk<any[]>(client.permission.list({ directory: input.stageDirectory })).catch(
          () => [],
        ),
        unwrapSdk<any[]>(client.question.list({ directory: input.stageDirectory })).catch(() => []),
      ]);
      for (const permission of permissions) {
        if (
          permission?.sessionID !== input.sessionId ||
          typeof permission?.id !== 'string' ||
          seen.has(`permission:${permission.id}`)
        )
          continue;
        seen.add(`permission:${permission.id}`);
        this.activeInteractive.get(input.invocationId)?.pending.set(permission.id, 'permission');
        await input.requestInteractive({
          kind: 'permission',
          content: {
            actionCode: safeCode(String(permission.permission ?? 'tool'), 'tool'),
            resourceCode: 'workspace_resource',
          },
          openCodeRequestId: permission.id,
          openCodeProcessGeneration: processGeneration,
          requestedAt: Date.now(),
        });
      }
      for (const request of questions) {
        if (
          request?.sessionID !== input.sessionId ||
          typeof request?.id !== 'string' ||
          seen.has(`question:${request.id}`)
        )
          continue;
        seen.add(`question:${request.id}`);
        this.activeInteractive.get(input.invocationId)?.pending.set(request.id, 'question');
        const question = Array.isArray(request.questions) ? request.questions[0] : null;
        await input.requestInteractive({
          kind: 'question',
          content: {
            header: boundedInteractiveText(question?.header, 'Question', 30),
            question: boundedInteractiveText(
              question?.question,
              'OpenCode requires additional input.',
              2_000,
            ),
            options: Array.isArray(question?.options)
              ? question.options.slice(0, 32).map((option: any) => ({
                  label: boundedInteractiveText(option?.label, 'Option', 200),
                  description: boundedInteractiveText(option?.description, '', 1_000),
                }))
              : [],
            multiple: question?.multiple === true,
          },
          openCodeRequestId: request.id,
          openCodeProcessGeneration: processGeneration,
          requestedAt: Date.now(),
        });
      }
      if (!settled()) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async getSessionActivity(input: {
    rootSessionId: string;
    allowedDirectories: readonly string[];
  }): Promise<'busy' | 'idle' | 'missing'> {
    const tree = await this.listSessionTree(input);
    if (tree.length === 0) return 'missing';
    for (const entry of tree) {
      if (
        entry.workspaceBound ||
        !input.allowedDirectories.some((directory) =>
          sameFilesystemPathCoordinate(entry.directory, directory),
        )
      ) {
        throw new Error('OpenCode session activity escaped its authenticated directories.');
      }
    }
    const sessionIds = new Set(tree.map(({ sessionId }) => sessionId));
    for (const directory of [...new Set(tree.map((entry) => entry.directory))]) {
      const scoped = await this.client(directory);
      const [statuses, permissions, questions] = await Promise.all([
        unwrapSdk<Record<string, any>>(scoped.client.session.status({ directory })),
        unwrapSdk<any[]>(scoped.client.permission.list({ directory })),
        unwrapSdk<any[]>(scoped.client.question.list({ directory })),
      ]);
      if (
        [...sessionIds].some((sessionId) => isOpenCodeSessionStatusActive(statuses[sessionId])) ||
        [...permissions, ...questions].some((request) => sessionIds.has(request?.sessionID))
      ) {
        return 'busy';
      }
    }
    return 'idle';
  }

  async interruptInvocation(input: { operationId: string; invocationId: string }): Promise<void> {
    const active = this.activeInteractive.get(input.invocationId);
    const outbox = this.store.getInvocationOutbox(input.invocationId);
    const sessionId = active?.sessionId ?? outbox?.sessionId;
    if (!sessionId) return;
    await this.native(active?.directory ?? this.sourceDirectory).interruptSession(sessionId);
  }

  async forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand): Promise<void> {
    const active = this.activeInteractive.get(command.invocationId);
    if (!active) throw new Error('OpenCode interactive drain is no longer live.');
    const { client, processGeneration } = await this.client(active.directory);
    if (processGeneration !== command.openCodeProcessGeneration) {
      throw new Error('OpenCode process generation changed before interactive reply.');
    }
    const expectedKind = command.kind === 'forward_permission_reply' ? 'permission' : 'question';
    if (active.pending.get(command.openCodeRequestId) !== expectedKind) {
      throw new Error('OpenCode interactive request identity is not live for this invocation.');
    }
    if (command.kind === 'forward_permission_reply') {
      await unwrapSdk(
        client.permission.reply({
          requestID: command.openCodeRequestId,
          directory: active.directory,
          reply: command.reply,
        }),
      );
    } else if (command.kind === 'forward_question_reply') {
      await unwrapSdk(
        client.question.reply({
          requestID: command.openCodeRequestId,
          directory: active.directory,
          answers: command.answers,
        }),
      );
    } else {
      await unwrapSdk(
        client.question.reject({
          requestID: command.openCodeRequestId,
          directory: active.directory,
        }),
      );
    }
    active.pending.delete(command.openCodeRequestId);
  }
}

function boundedInteractiveText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const normalized = replaceControlCharacters(value)
    .replace(/\bBearer\s+\S+/giu, '[redacted]')
    .replace(/\b(?:token|secret|password|api[_ -]?key)\s*[:=]\s*\S+/giu, '[redacted]')
    .replace(/\bhttps?:\/\/\S+/giu, '[redacted-url]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[^\s/]+\/)+)\S*/gu, ' [path]')
    .trim()
    .slice(0, maxLength);
  return normalized || fallback;
}

export interface ManagedChatOperationV2ExecutionPrompt {
  readonly agent: typeof TAGMA_PIPELINE_AGENT | typeof TAGMA_TRIAL_PLANNER_AGENT;
  readonly system: string;
  readonly text: string;
}

export function buildManagedChatOperationV2ExecutionPrompt(
  input: Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['execute']>[0],
): ManagedChatOperationV2ExecutionPrompt {
  if (input.purpose === 'trial_plan') {
    if (
      input.trialPlanRequest === null ||
      input.trialPlanRequest.relativePlanPath !== pipelineTrialPlanPath(input.targetRelativePath)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Trial Plan invocation does not match the authenticated staged target.',
      );
    }
    return {
      agent: TAGMA_TRIAL_PLANNER_AGENT,
      system:
        'Operate only inside the authenticated staged Tagma workspace. Read only the exact staged target and relevant companions; mutate only through the dedicated Trial Plan tool for the Host-issued attempt.',
      text: [
        '<tagma-internal>',
        '<mode>targeted_trial_planning</mode>',
        `<agent-root>${escapeXml(input.stageDirectory)}</agent-root>`,
        `<target>${escapeXml(input.targetRelativePath)}</target>`,
        `<trial-plan-request>${escapeXml(canonicalJson(input.trialPlanRequest))}</trial-plan-request>`,
        `<host-evidence-digest>${sha256(input.canonicalRequestBytes)}</host-evidence-digest>`,
        '</tagma-internal>',
      ].join('\n'),
    };
  }
  if (input.trialPlanRequest !== null) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Pipeline authoring invocation unexpectedly carries Trial Plan authority.',
    );
  }
  const attachments = input.admission.request.attachments
    .map(
      (attachment) =>
        `<attachment label="${escapeXml(attachment.label)}">${escapeXml(attachment.content)}</attachment>`,
    )
    .join('\n');
  const opencodeChatModel =
    input.intent === 'create'
      ? `<opencode-chat-model provider-id="${escapeXml(input.admission.provider)}" model-id="${escapeXml(input.admission.model)}" />`
      : '';
  return {
    agent: TAGMA_PIPELINE_AGENT,
    system: [
      'Operate only inside the authenticated staged Tagma workspace. Author exactly the supplied relative pipeline target and finish with a concise status.',
      'Every target and companion path visible to you uses staging coordinates; the Host may remap publication to another target.',
      'The compile log is not a published artifact. Report its status only as staging evidence.',
      'Do not claim a published path or that a compile-log file remains after publication; the Host alone reports publication.',
    ].join(' '),
    text: [
      '<tagma-chat-operation-v2-authoring>',
      `<purpose>${input.purpose}</purpose>`,
      `<target>${escapeXml(input.targetRelativePath)}</target>`,
      opencodeChatModel,
      `<request>${escapeXml(input.admission.request.text)}</request>`,
      attachments,
      `<host-evidence-digest>${sha256(input.canonicalRequestBytes)}</host-evidence-digest>`,
      '</tagma-chat-operation-v2-authoring>',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseAuthoringUsage(
  info: Record<string, unknown> | null,
): ChatOperationV2AuthoringInvocationUsage | null {
  const tokens = sdkRecord(info?.tokens);
  if (!tokens) return null;
  const cache = sdkRecord(tokens.cache);
  const metrics = {
    inputTokens: Number(tokens.input ?? 0),
    outputTokens: Number(tokens.output ?? 0),
    reasoningTokens: Number(tokens.reasoning ?? 0),
    cacheReadTokens: Number(cache?.read ?? 0),
    cacheWriteTokens: Number(cache?.write ?? 0),
    costMicrounits: Math.max(0, Math.round(Number(info?.cost ?? 0) * 1_000_000)),
  };
  if (Object.values(metrics).some((value) => !Number.isSafeInteger(value) || value < 0))
    return null;
  return {
    ...metrics,
    outcome:
      metrics.inputTokens + metrics.outputTokens + metrics.reasoningTokens === 0
        ? 'zero_token'
        : 'completed',
  };
}

function responseText(result: unknown): string | null {
  const record = sdkRecord(result);
  if (!record || !Array.isArray(record.parts)) return null;
  const text = record.parts
    .map(sdkRecord)
    .filter(
      (part): part is Record<string, unknown> =>
        part?.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('')
    .trim();
  return text && encoder.encode(text).byteLength <= 1024 * 1024 ? text : null;
}

function executionMessageId(request: ChatOperationV2AuthoringInvocationRequest): string {
  return `msg_tagma_author_${sha256(
    canonicalJson({
      operationId: request.operationId,
      invocationId: request.invocationId,
      sessionId: request.sessionId,
      inputId: request.inputId,
      purpose: request.purpose,
    }),
  ).slice(0, 40)}`;
}

function trialId(input: {
  operationId: string;
  operationGeneration: number;
  stageId: string;
  repairAttempts: number;
}): string {
  return `trial-${sha256(canonicalJson(input)).slice(0, 40)}`;
}

function completedFromExecution(
  execution: Extract<ManagedChatOperationV2AuthoringExecutionResult, { kind: 'completed' }>,
  disposition: 'changed' | 'no_change',
  admission: Extract<ManagedChatOperationV2AdmissionResult, { kind: 'admitted' }>,
  executionMessageId: string,
): Extract<ChatOperationV2AuthoringInvocationResult, { kind: 'completed' }> {
  return {
    kind: 'completed',
    disposition,
    executionMessageId,
    text: execution.text,
    finishCode: safeCode(execution.finishCode, 'stop'),
    admittedAggregateSeq: admission.admittedAggregateSeq,
    source: admission.source,
    usage: execution.usage,
  };
}

class ManagedAuthoringRuntime implements ChatOperationV2AuthoringRuntime {
  constructor(
    private readonly workspaceScopeId: string,
    private readonly staging: ManagedChatOperationV2AuthoringStagingAdapter,
    private readonly openCode: ManagedChatOperationV2AuthoringOpenCodeAdapter,
    private readonly commitPreparer: CommitPreparer,
    private readonly now: () => number,
    private readonly resolveTarget: NonNullable<
      CreateManagedChatOperationV2AuthoringRuntimeOptions['resolveTarget']
    >,
  ) {}

  private assertScope(value: string): void {
    if (value !== this.workspaceScopeId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Authoring runtime workspace scope changed.',
      );
    }
  }

  private assertStageId(value: string): void {
    if (!UUID_RE.test(value)) throw new TypeError('Authoring stage id must be an exact UUID.');
  }

  private async authority(
    stageId: string,
  ): Promise<ManagedChatOperationV2AuthoringAuthorityRecord> {
    const authority = await this.staging.readAuthority(stageId);
    if (!authority) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Authenticated authoring stage authority is unavailable.',
      );
    }
    this.validateAuthorityRecord(authority, stageId);
    this.assertScope(authority.workspaceScopeId);
    return authority;
  }

  private validateAuthorityRecord(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    stageId: string,
  ): void {
    try {
      if (
        authority.version !== AUTHORING_AUTHORITY_VERSION ||
        authority.stage.stageId !== stageId ||
        !UUID_RE.test(stageId) ||
        authority.stage.status !== 'ready' ||
        authority.stage.target.coordinate !== authority.targetRelativePath ||
        exactPipelineRelativePath(authority.targetRelativePath) !== authority.targetRelativePath ||
        exactPipelineRelativePath(authority.workingRelativePath) !==
          authority.workingRelativePath ||
        authority.workingRelativePath !== authority.targetRelativePath ||
        !isAbsolute(authority.sourceDirectory) ||
        !isAbsolute(authority.stageDirectory) ||
        authority.sourceDirectory === authority.stageDirectory ||
        directoryIdentity(authority.sourceDirectory) !== authority.stage.sourceDirectoryIdentity ||
        directoryIdentity(authority.stageDirectory) !== authority.stage.stageDirectoryIdentity ||
        typeof authority.sessionId !== 'string' ||
        !authority.sessionId ||
        (authority.conversationId !== null &&
          (typeof authority.conversationId !== 'string' || !authority.conversationId)) ||
        (authority.intent !== 'create' && authority.intent !== 'edit') ||
        (authority.intent === 'create'
          ? authority.originHash !== null
          : typeof authority.originHash !== 'string' || !HASH_RE.test(authority.originHash)) ||
        !authority.invocations ||
        typeof authority.invocations !== 'object' ||
        Array.isArray(authority.invocations)
      ) {
        throw new Error('invalid authority');
      }
      if (authority.relocation) parseChatOperationV2SessionRelocation(authority.relocation);
      const invocations = Object.entries(authority.invocations);
      if (invocations.length > 16) throw new Error('invocation authority bound exceeded');
      for (const [invocationId, invocation] of invocations) {
        if (
          invocation.invocationId !== invocationId ||
          !['authoring', 'repair', 'trial_plan'].includes(invocation.purpose) ||
          typeof invocation.conversationId !== 'string' ||
          !invocation.conversationId ||
          authority.conversationId !== invocation.conversationId ||
          !HASH_RE.test(invocation.requestDigest) ||
          !HASH_RE.test(invocation.baselineSnapshotHash) ||
          typeof invocation.executionSubmitted !== 'boolean' ||
          (invocation.completed !== null &&
            (invocation.completed.kind !== 'completed' ||
              invocation.completed.executionMessageId !== invocation.executionMessageId))
        ) {
          throw new Error('invalid invocation authority');
        }
      }
    } catch (error) {
      if (error instanceof ChatOperationV2AuthoringProtocolError) throw error;
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Authenticated authoring runtime record is invalid.',
      );
    }
  }

  async ensureStage(input: Parameters<ChatOperationV2AuthoringRuntime['ensureStage']>[0]) {
    this.assertScope(input.workspaceScopeId);
    this.assertStageId(input.stageId);
    if (
      input.binding.workspaceScopeId !== input.workspaceScopeId ||
      input.binding.operationId !== input.operationId ||
      input.binding.status !== 'reserved'
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Reserved binding does not belong to this operation.',
      );
    }
    const expectedPlatform = process.platform === 'win32' ? 'win32' : 'posix';
    if (input.binding.target.platform !== expectedPlatform) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Binding target platform does not match the Host filesystem.',
      );
    }
    const targetRelativePath = exactPipelineRelativePath(input.binding.target.coordinate);
    const resolvedTarget = await this.resolveTarget({
      targetId: input.targetId,
      binding: input.binding,
      intent: input.intent,
      originHash: input.originHash,
    });
    const sourceRelativePath =
      resolvedTarget.sourceRelativePath === null
        ? null
        : exactPipelineRelativePath(resolvedTarget.sourceRelativePath);
    const workingRelativePath = targetRelativePath;
    if (
      (input.intent === 'create' && resolvedTarget.sourceRelativePath !== null) ||
      (input.intent === 'edit' && resolvedTarget.sourceRelativePath === null)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Host target resolver returned an invalid create/edit origin.',
      );
    }
    let snapshot = await this.staging.inspectStage(input.stageId);
    let authority = snapshot ? await this.staging.readAuthority(input.stageId) : null;
    if (snapshot && !authority) {
      await this.staging.discardStage(input.stageId);
      snapshot = null;
    }
    if (snapshot && authority) {
      this.validateAuthorityRecord(authority, input.stageId);
      this.assertAuthorityMatches(
        authority,
        input,
        snapshot,
        targetRelativePath,
        workingRelativePath,
      );
      return { kind: 'ready' as const, stage: authority.stage };
    }
    try {
      snapshot = await this.staging.createStage({
        stageId: input.stageId,
        intent: input.intent,
        targetRelativePath,
        sourceRelativePath,
        originHash: input.originHash,
      });
      const createdAt = this.now();
      const stage: ChatOperationV2AuthoringStage = Object.freeze({
        schemaVersion: 1,
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        bindingId: input.binding.bindingId,
        stageId: input.stageId,
        targetId: input.targetId,
        target: input.binding.target,
        sourceDirectoryIdentity: directoryIdentity(snapshot.sourceDirectory),
        stageDirectoryIdentity: directoryIdentity(snapshot.stageDirectory),
        snapshotHash: snapshot.snapshotHash,
        artifactCount: snapshot.artifactCount,
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      });
      authority = {
        version: AUTHORING_AUTHORITY_VERSION,
        workspaceScopeId: input.workspaceScopeId,
        conversationId: null,
        sessionId: input.sessionId,
        intent: input.intent,
        originHash: input.originHash,
        targetRelativePath,
        workingRelativePath,
        sourceDirectory: snapshot.sourceDirectory,
        stageDirectory: snapshot.stageDirectory,
        stage,
        relocation: null,
        invocations: {},
      };
      await this.staging.writeAuthority(input.stageId, authority);
      return { kind: 'ready' as const, stage };
    } catch {
      if (snapshot) await this.staging.discardStage(input.stageId).catch(() => undefined);
      return {
        kind: 'failed' as const,
        errorCode: 'stage_create_failed',
        diagnosticCodes: ['stage_create_failed'],
      };
    }
  }

  private assertAuthorityMatches(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    input: Parameters<ChatOperationV2AuthoringRuntime['ensureStage']>[0],
    snapshot: ManagedChatOperationV2AuthoringStageSnapshot,
    targetRelativePath: string,
    workingRelativePath: string,
  ): void {
    if (
      authority.stage.operationId !== input.operationId ||
      authority.stage.operationGeneration !== input.operationGeneration ||
      authority.stage.bindingId !== input.binding.bindingId ||
      authority.stage.stageId !== input.stageId ||
      authority.stage.targetId !== input.targetId ||
      authority.sessionId !== input.sessionId ||
      authority.intent !== input.intent ||
      authority.originHash !== input.originHash ||
      authority.targetRelativePath !== targetRelativePath ||
      authority.workingRelativePath !== workingRelativePath ||
      authority.sourceDirectory !== snapshot.sourceDirectory ||
      authority.stageDirectory !== snapshot.stageDirectory
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Authenticated stage authority conflicts with the durable operation.',
      );
    }
  }

  async inspectStage(input: Parameters<ChatOperationV2AuthoringRuntime['inspectStage']>[0]) {
    this.assertStageId(input.stageId);
    const snapshot = await this.staging.inspectStage(input.stageId);
    if (!snapshot) return { kind: 'missing' as const };
    const authority = await this.staging.readAuthority(input.stageId);
    if (!authority) return { kind: 'missing' as const };
    this.validateAuthorityRecord(authority, input.stageId);
    if (
      authority.stage.operationId !== input.operationId ||
      authority.stage.operationGeneration !== input.operationGeneration ||
      directoryIdentity(snapshot.sourceDirectory) !== authority.stage.sourceDirectoryIdentity ||
      directoryIdentity(snapshot.stageDirectory) !== authority.stage.stageDirectoryIdentity
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Recovered stage authority does not match its filesystem stage.',
      );
    }
    return {
      kind: 'present' as const,
      stage: authority.stage,
      sessionId: authority.relocation?.sessionId ?? authority.sessionId,
    };
  }

  private relocationRecord(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    input: {
      operationId: string;
      operationGeneration: number;
      bindingId: string;
      sessionId: string;
      relocationId: string;
      phase: 'prepared' | 'staged' | 'restoring' | 'restored';
    },
  ): ChatOperationV2SessionRelocation {
    return sealChatOperationV2SessionRelocation({
      schemaVersion: 1,
      relocationId: input.relocationId,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.bindingId,
      stageId: authority.stage.stageId,
      sessionId: input.sessionId,
      sourceDirectoryIdentity: authority.stage.sourceDirectoryIdentity,
      stageDirectoryIdentity: authority.stage.stageDirectoryIdentity,
      phase: input.phase,
      updatedAt: this.now(),
    });
  }

  async relocateSession(input: Parameters<ChatOperationV2AuthoringRuntime['relocateSession']>[0]) {
    const authority = await this.authority(input.stage.stageId);
    this.assertRelocationInput(authority, input);
    let journal = await this.staging.readRelocation(input.stage.stageId);
    await this.openCode.ensureSession({
      sessionId: input.sessionId,
      sourceDirectory: authority.sourceDirectory,
    });
    if (!journal) {
      const initialTree = sessionTreeChildrenFirst(
        await this.openCode.listSessionTree({ rootSessionId: input.sessionId }),
        input.sessionId,
      );
      if (
        initialTree.some(
          (entry) =>
            entry.workspaceBound ||
            entry.busy ||
            !sameFilesystemPathCoordinate(entry.directory, authority.sourceDirectory),
        )
      ) {
        throw new Error(
          'New OpenCode relocation did not start from one quiescent home directory tree.',
        );
      }
      journal = await this.staging.prepareRelocation({
        stageId: input.stage.stageId,
        sessionId: input.sessionId,
        relocationId: input.relocationId,
      });
    }
    if (
      journal.sessionId !== input.sessionId ||
      journal.relocationId !== input.relocationId ||
      journal.sourceDirectory !== authority.sourceDirectory ||
      journal.targetDirectory !== authority.stageDirectory
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Session relocation journal conflicts with Host authority.',
      );
    }
    let relocation = authority.relocation;
    if (!relocation || relocation.phase === 'prepared') {
      relocation = this.relocationRecord(authority, { ...input, phase: 'prepared' });
      await this.writeAuthority(authority, { relocation });
    }
    if (journal.phase === 'staged' && relocation.phase === 'staged') {
      await this.moveTree(
        input.sessionId,
        authority.sourceDirectory,
        authority.stageDirectory,
        false,
      );
      return relocation;
    }
    if (journal.phase !== 'prepared') {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Session relocation is not recoverable toward the stage.',
      );
    }
    await this.moveTree(input.sessionId, authority.sourceDirectory, authority.stageDirectory, true);
    await this.staging.advanceRelocation({
      stageId: input.stage.stageId,
      sessionId: input.sessionId,
      relocationId: input.relocationId,
      expectedPhase: 'prepared',
      phase: 'staged',
    });
    relocation = this.relocationRecord(authority, { ...input, phase: 'staged' });
    await this.writeAuthority(authority, { relocation });
    return relocation;
  }

  async recoverSessionAfterRestart(
    input: Parameters<ChatOperationV2AuthoringRuntime['recoverSessionAfterRestart']>[0],
  ) {
    if (
      input.previous.operationId !== input.operationId ||
      input.previous.operationGeneration !== input.operationGeneration ||
      input.previous.stageId !== input.stage.stageId ||
      input.nextSessionId === input.previous.sessionId ||
      input.nextRelocationId === input.previous.relocationId
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Restart recovery requires distinct Host session and relocation identities.',
      );
    }
    await this.restoreSession({
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      relocation: input.previous,
    });
    return this.relocateSession({
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.previous.bindingId,
      sessionId: input.nextSessionId,
      relocationId: input.nextRelocationId,
      stage: input.stage,
    });
  }

  private assertRelocationInput(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    input: Parameters<ChatOperationV2AuthoringRuntime['relocateSession']>[0],
  ): void {
    if (
      authority.stage.operationId !== input.operationId ||
      authority.stage.operationGeneration !== input.operationGeneration ||
      authority.stage.bindingId !== input.bindingId ||
      authority.stage.stageId !== input.stage.stageId ||
      authority.stage.snapshotHash !== input.stage.snapshotHash
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Relocation input does not match the authenticated stage.',
      );
    }
  }

  private async moveTree(
    rootSessionId: string,
    sourceDirectory: string,
    destinationDirectory: string,
    requireIdle: boolean,
  ): Promise<void> {
    const tree = await this.openCode.listSessionTree({ rootSessionId });
    const ordered = sessionTreeChildrenFirst(tree, rootSessionId);
    for (const entry of ordered) {
      if (entry.workspaceBound) {
        throw new Error('OpenCode workspace-bound sessions cannot enter a stage relocation.');
      }
      if (requireIdle && entry.busy) throw new Error('OpenCode session tree is not quiescent.');
      if (
        !sameFilesystemPathCoordinate(entry.directory, sourceDirectory) &&
        !sameFilesystemPathCoordinate(entry.directory, destinationDirectory)
      ) {
        throw new Error('OpenCode session tree contains a third-directory coordinate.');
      }
    }
    if (requireIdle) {
      const activity = await this.openCode.getSessionActivity({
        rootSessionId,
        allowedDirectories: [sourceDirectory, destinationDirectory],
      });
      if (activity !== 'idle') throw new Error('OpenCode session tree is not quiescent.');
    }
    for (const entry of ordered) {
      if (!sameFilesystemPathCoordinate(entry.directory, destinationDirectory)) {
        await this.openCode.moveSession({
          sessionId: entry.sessionId,
          destinationDirectory,
        });
      }
    }
    const verified = sessionTreeChildrenFirst(
      await this.openCode.listSessionTree({ rootSessionId }),
      rootSessionId,
    );
    const expectedById = new Map(ordered.map((entry) => [entry.sessionId, entry]));
    if (
      verified.length !== ordered.length ||
      verified.some(
        (entry) =>
          entry.workspaceBound ||
          expectedById.get(entry.sessionId)?.parentSessionId !== entry.parentSessionId ||
          !sameFilesystemPathCoordinate(entry.directory, destinationDirectory),
      )
    ) {
      throw new Error('OpenCode session relocation verification failed.');
    }
  }

  async inspectSessionRelocation(
    input: Parameters<ChatOperationV2AuthoringRuntime['inspectSessionRelocation']>[0],
  ) {
    const authority = await this.staging.readAuthority(input.stageId);
    if (!authority) return null;
    this.validateAuthorityRecord(authority, input.stageId);
    if (authority.stage.operationId !== input.operationId) return null;
    if (
      authority.stage.operationGeneration !== input.operationGeneration ||
      (authority.relocation && authority.relocation.sessionId !== input.sessionId)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Recovered relocation identity changed.',
      );
    }
    return authority.relocation;
  }

  async restoreSession(input: Parameters<ChatOperationV2AuthoringRuntime['restoreSession']>[0]) {
    const authority = await this.authority(input.relocation.stageId);
    if (
      !authority.relocation ||
      authority.relocation.recordHash !== input.relocation.recordHash ||
      authority.stage.operationId !== input.operationId ||
      authority.stage.operationGeneration !== input.operationGeneration
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Restore input does not match the authenticated relocation.',
      );
    }
    if (authority.relocation.phase === 'restored') return authority.relocation;
    let journal = await this.staging.readRelocation(authority.stage.stageId);
    if (!journal) throw new Error('Session relocation journal is missing before restore.');
    if (journal.phase === 'staged') {
      journal = await this.staging.advanceRelocation({
        stageId: authority.stage.stageId,
        sessionId: input.relocation.sessionId,
        relocationId: input.relocation.relocationId,
        expectedPhase: 'staged',
        phase: 'restoring',
      });
    }
    let relocation = this.relocationRecord(authority, {
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.relocation.bindingId,
      sessionId: input.relocation.sessionId,
      relocationId: input.relocation.relocationId,
      phase: 'restoring',
    });
    await this.writeAuthority(authority, { relocation });
    const activity = await this.openCode.getSessionActivity({
      rootSessionId: input.relocation.sessionId,
      allowedDirectories: [authority.sourceDirectory, authority.stageDirectory],
    });
    if (activity === 'busy') throw new Error('OpenCode session is still busy during restore.');
    if (activity !== 'missing') {
      await this.moveTree(
        input.relocation.sessionId,
        authority.stageDirectory,
        authority.sourceDirectory,
        true,
      );
    }
    await this.staging.clearRelocation({
      stageId: authority.stage.stageId,
      sessionId: input.relocation.sessionId,
      relocationId: input.relocation.relocationId,
      expectedPhase: 'restoring',
      ...(activity === 'missing'
        ? { verifiedSessionMissing: true as const }
        : { verifiedHomeDirectory: authority.sourceDirectory }),
    });
    relocation = this.relocationRecord(authority, {
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.relocation.bindingId,
      sessionId: input.relocation.sessionId,
      relocationId: input.relocation.relocationId,
      phase: 'restored',
    });
    await this.writeAuthority(authority, { relocation });
    return relocation;
  }

  async discardStage(input: Parameters<ChatOperationV2AuthoringRuntime['discardStage']>[0]) {
    const authority = await this.staging.readAuthority(input.stageId);
    if (authority) {
      this.validateAuthorityRecord(authority, input.stageId);
      if (
        authority.stage.operationId !== input.operationId ||
        authority.stage.operationGeneration !== input.operationGeneration
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Discard input does not match stage authority.',
        );
      }
      if (authority.relocation && authority.relocation.phase !== 'restored') {
        throw new Error('Stage cannot be discarded before session restoration.');
      }
    }
    const kind = await this.staging.discardStage(input.stageId);
    return { kind, stageId: input.stageId };
  }

  async runInvocation(
    request: ChatOperationV2AuthoringInvocationRequest,
  ): Promise<ChatOperationV2AuthoringInvocationResult> {
    let authority = await this.authority(request.stage.stageId);
    this.assertInvocationAuthority(authority, request);
    if (
      authority.conversationId !== null &&
      authority.conversationId !== request.admission.conversationId
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Renderer conversation correlation changed within one operation.',
      );
    }
    if (authority.conversationId === null) {
      authority = { ...authority, conversationId: request.admission.conversationId };
      await this.staging.writeAuthority(authority.stage.stageId, authority);
    }
    const digest = sha256(request.canonicalRequestBytes);
    let invocation = authority.invocations[request.invocationId];
    if (invocation) {
      if (
        invocation.sessionId !== request.sessionId ||
        invocation.inputId !== request.inputId ||
        invocation.purpose !== request.purpose ||
        invocation.conversationId !== request.admission.conversationId ||
        invocation.requestDigest !== digest
      ) {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      if (invocation.completed) return invocation.completed;
      if (invocation.executionSubmitted) {
        return { kind: 'provider_unavailable', code: 'submitted_unknown', submissionUnknown: true };
      }
    } else {
      const current = await this.requireCurrentSnapshot(authority);
      invocation = {
        invocationId: request.invocationId,
        sessionId: request.sessionId,
        inputId: request.inputId,
        purpose: request.purpose,
        conversationId: request.admission.conversationId,
        requestDigest: digest,
        executionMessageId: executionMessageId(request),
        baselineSnapshotHash: current.snapshotHash,
        executionSubmitted: false,
        completed: null,
      };
      await this.writeInvocation(authority, invocation);
    }
    const admitted = await this.openCode.admit({
      operationId: request.operationId,
      workspaceScopeId: request.workspaceScopeId,
      invocationId: request.invocationId,
      sessionId: request.sessionId,
      inputId: request.inputId,
      purpose: request.purpose,
      canonicalRequestBytes: Uint8Array.from(request.canonicalRequestBytes),
      stageDirectory: authority.stageDirectory,
    });
    if (admitted.kind !== 'admitted') {
      return admitted.kind === 'submitted_unknown'
        ? {
            kind: 'provider_unavailable',
            code: safeCode(admitted.code, 'submitted_unknown'),
            submissionUnknown: true,
          }
        : { kind: 'provider_unavailable', code: safeCode(admitted.code, 'request_conflict') };
    }
    invocation = { ...invocation, executionSubmitted: true };
    await this.writeInvocation(await this.authority(request.stage.stageId), invocation);
    const execution = await this.openCode.execute({
      invocationId: request.invocationId,
      sessionId: request.sessionId,
      executionMessageId: invocation.executionMessageId,
      purpose: request.purpose,
      intent: authority.intent,
      stageDirectory: authority.stageDirectory,
      targetRelativePath: authority.workingRelativePath,
      trialPlanRequest: request.trialPlanRequest,
      admission: request.admission,
      canonicalRequestBytes: Uint8Array.from(request.canonicalRequestBytes),
      signal: request.signal,
      requestInteractive: request.requestInteractive,
    });
    if (execution.kind !== 'completed') return execution;
    const current = await this.requireCurrentSnapshot(authority);
    const completed = completedFromExecution(
      execution,
      current.snapshotHash === invocation.baselineSnapshotHash ? 'no_change' : 'changed',
      admitted,
      invocation.executionMessageId,
    );
    invocation = { ...invocation, completed };
    await this.writeInvocation(await this.authority(request.stage.stageId), invocation);
    return completed;
  }

  async reconcileInvocation(
    request: Omit<ChatOperationV2AuthoringInvocationRequest, 'signal' | 'requestInteractive'>,
  ) {
    const authority = await this.authority(request.stage.stageId);
    this.assertInvocationAuthority(authority, request);
    const invocation = authority.invocations[request.invocationId];
    const digest = sha256(request.canonicalRequestBytes);
    if (
      !invocation ||
      authority.conversationId !== request.admission.conversationId ||
      invocation.sessionId !== request.sessionId ||
      invocation.inputId !== request.inputId ||
      invocation.purpose !== request.purpose ||
      invocation.conversationId !== request.admission.conversationId ||
      invocation.requestDigest !== digest
    ) {
      return { kind: 'provider_unavailable' as const, code: 'request_digest_conflict' };
    }
    if (invocation.completed) return invocation.completed;
    const admitted = await this.openCode.reconcileAdmission({
      operationId: request.operationId,
      workspaceScopeId: request.workspaceScopeId,
      invocationId: request.invocationId,
      sessionId: request.sessionId,
      inputId: request.inputId,
      purpose: request.purpose,
      canonicalRequestBytes: Uint8Array.from(request.canonicalRequestBytes),
      stageDirectory: authority.stageDirectory,
    });
    if (admitted.kind === 'submitted_unknown') return { kind: 'in_progress' as const };
    if (admitted.kind === 'conflict') {
      return {
        kind: 'provider_unavailable' as const,
        code: safeCode(admitted.code, 'request_conflict'),
      };
    }
    const settlement = await this.openCode.reconcileExecution({
      sessionId: request.sessionId,
      executionMessageId: invocation.executionMessageId,
      afterAggregateSeq: admitted.admittedAggregateSeq,
      stageDirectory: authority.stageDirectory,
    });
    if (settlement.kind !== 'settled') {
      if (settlement.kind === 'unavailable') {
        return {
          kind: 'provider_unavailable' as const,
          code: safeCode(settlement.code, 'execution_unavailable'),
        };
      }
      const activity = await this.openCode.getSessionActivity({
        rootSessionId: request.sessionId,
        allowedDirectories: [authority.stageDirectory],
      });
      if (activity === 'busy') return { kind: 'in_progress' as const };
      return {
        kind: 'provider_unavailable' as const,
        code: activity === 'missing' ? 'session_missing' : 'execution_settlement_missing',
      };
    }
    if (settlement.executionMessageId !== invocation.executionMessageId) {
      return { kind: 'provider_unavailable' as const, code: 'execution_identity_conflict' };
    }
    const current = await this.requireCurrentSnapshot(authority);
    const completed: Extract<ChatOperationV2AuthoringInvocationResult, { kind: 'completed' }> = {
      kind: 'completed',
      disposition:
        current.snapshotHash === invocation.baselineSnapshotHash ? 'no_change' : 'changed',
      executionMessageId: invocation.executionMessageId,
      text: settlement.text,
      finishCode: settlement.finishCode,
      admittedAggregateSeq: admitted.admittedAggregateSeq,
      source: settlement.source,
      usage: settlement.usage,
    };
    await this.writeInvocation(authority, { ...invocation, completed });
    return completed;
  }

  private assertInvocationAuthority(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    request: Omit<ChatOperationV2AuthoringInvocationRequest, 'signal' | 'requestInteractive'>,
  ): void {
    this.assertScope(request.workspaceScopeId);
    if (
      authority.stage.operationId !== request.operationId ||
      authority.stage.operationGeneration !== request.operationGeneration ||
      authority.stage.stageId !== request.stage.stageId ||
      !authority.relocation ||
      authority.relocation.recordHash !== request.relocation.recordHash ||
      authority.relocation.phase !== 'staged' ||
      (request.purpose === 'trial_plan') !== (request.trialPlanRequest !== null) ||
      (request.trialPlanRequest !== null &&
        request.trialPlanRequest.relativePlanPath !==
          pipelineTrialPlanPath(authority.workingRelativePath))
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Invocation does not own the authenticated staged session.',
      );
    }
  }

  private async requireCurrentSnapshot(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
  ): Promise<ManagedChatOperationV2AuthoringStageSnapshot> {
    const current = await this.staging.inspectStage(authority.stage.stageId);
    if (
      !current ||
      current.sourceDirectory !== authority.sourceDirectory ||
      current.stageDirectory !== authority.stageDirectory ||
      current.workingRelativePath !== authority.workingRelativePath ||
      !HASH_RE.test(current.snapshotHash)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Current staged snapshot does not match Host authority.',
      );
    }
    return current;
  }

  private async writeInvocation(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    invocation: ManagedChatOperationV2InvocationAuthority,
  ): Promise<void> {
    await this.staging.writeAuthority(authority.stage.stageId, {
      ...authority,
      invocations: { ...authority.invocations, [invocation.invocationId]: invocation },
    });
  }

  private async writeAuthority(
    authority: ManagedChatOperationV2AuthoringAuthorityRecord,
    patch: Partial<Pick<ManagedChatOperationV2AuthoringAuthorityRecord, 'relocation'>>,
  ): Promise<void> {
    await this.staging.writeAuthority(authority.stage.stageId, { ...authority, ...patch });
  }

  interruptInvocation(
    input: Parameters<ChatOperationV2AuthoringRuntime['interruptInvocation']>[0],
  ) {
    return this.openCode.interruptInvocation(input);
  }

  forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand): Promise<void> {
    return this.openCode.forwardInteractive(command);
  }

  async verifyStage(input: Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0]) {
    this.assertScope(input.workspaceScopeId);
    const authority = await this.authority(input.stage.stageId);
    if (
      authority.stage.operationId !== input.operationId ||
      authority.stage.operationGeneration !== input.operationGeneration ||
      authority.stage.bindingId !== input.bindingId ||
      authority.stage.targetId !== input.targetId
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Verification does not own this stage.',
      );
    }
    const id = trialId({
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      stageId: input.stage.stageId,
      repairAttempts: input.repairAttempts,
    });
    if (input.signal.aborted) return verificationDiscard(id, 'verification_cancelled', []);
    let compile: ManagedChatOperationV2CompileResult;
    try {
      compile = await this.staging.compileStage(input.stage.stageId, authority.workingRelativePath);
    } catch (error) {
      const scopeViolation =
        error instanceof Error &&
        (error.message.includes('cannot also mutate') ||
          error.message.includes('verify only its classified target'));
      const diagnostic = scopeViolation ? 'stage_scope_violation' : 'compile_unavailable';
      return verificationDiscard(id, diagnostic, [diagnostic]);
    }
    if (!compile.success) {
      const diagnostics = ['compile_failed', ...(!compile.parseOk ? ['compile_parse_failed'] : [])];
      return verificationRepair(id, diagnostics, {
        compileSuccess: false,
        parseOk: compile.parseOk,
        errorCount: compile.validation.errors.length,
        warningCount: compile.validation.warnings.length,
      });
    }
    let trial: ChatPipelineTrialRunResult;
    try {
      trial = await this.staging.runTrial({
        stageId: input.stage.stageId,
        targetRelativePath: authority.workingRelativePath,
        trialId: id,
        signal: input.signal,
      });
    } catch {
      return input.signal.aborted
        ? verificationDiscard(id, 'verification_cancelled', [])
        : verificationDiscard(id, 'trial_unavailable', ['trial_unavailable']);
    }
    const cases = Array.isArray(trial.cases) ? trial.cases : [];
    const caseCount = Number.isSafeInteger(trial.plannedCaseCount)
      ? Math.max(0, trial.plannedCaseCount ?? 0)
      : cases.length;
    const passedCount = Math.min(caseCount, cases.filter((item) => item.success).length);
    const failedCount = Math.min(
      caseCount - passedCount,
      cases.filter((item) => !item.success).length,
    );
    const warningCount = trial.kind === 'passed-with-warnings' ? Math.min(caseCount, 1) : 0;
    const planHash = trial.plan ? sha256(canonicalJson(trial.plan)) : null;
    if (input.signal.aborted || trial.kind === 'aborted') {
      return {
        ...verificationDiscard(id, 'verification_cancelled', [
          safeCode(`trial_${trial.kind}`, 'trial_failed'),
        ]),
        planHash,
        caseCount,
        passedCount,
        failedCount,
        warningCount,
      };
    }
    if (trial.success && (trial.kind === 'passed' || trial.kind === 'passed-with-warnings')) {
      const current = await this.requireCurrentSnapshot(authority);
      return {
        kind: 'passed' as const,
        trialId: id,
        planHash,
        caseCount,
        passedCount,
        failedCount,
        warningCount,
        stagedSnapshotHash: current.snapshotHash,
        artifactSetHash: current.artifactSetHash,
        artifactCount: current.artifactCount,
      };
    }
    const diagnostic = safeCode(`trial_${trial.kind.replace(/-/g, '_')}`, 'trial_failed');
    if (trial.kind === 'plan-required') {
      if (!trial.planRequest) {
        return {
          ...verificationDiscard(id, 'trial_plan_request_invalid', [diagnostic]),
          planHash,
          caseCount,
          passedCount,
          failedCount,
          warningCount,
        };
      }
      return {
        kind: 'trial_plan_required' as const,
        trialId: id,
        planHash,
        caseCount,
        passedCount,
        failedCount,
        warningCount,
        planRequest: trial.planRequest,
      };
    }
    if (trial.repairAuthorization !== 'pipeline-change-allowed') {
      const current = await this.requireCurrentSnapshot(authority);
      return {
        kind: 'unverified' as const,
        trialId: id,
        planHash,
        caseCount,
        passedCount,
        failedCount,
        warningCount,
        trialStatus:
          trial.kind === 'blocked' ||
          trial.kind === 'preflight-failed' ||
          trial.kind === 'setup-failed' ||
          trial.kind === 'busy'
            ? ('blocked' as const)
            : ('failed' as const),
        errorCode: diagnostic,
        diagnosticCodes: [diagnostic],
        redactedSummary: boundedInteractiveText(
          trial.summary,
          'Trial verification could not complete.',
          4_096,
        ),
        stagedSnapshotHash: current.snapshotHash,
        artifactSetHash: current.artifactSetHash,
        artifactCount: current.artifactCount,
      };
    }
    return {
      ...verificationRepair(id, [diagnostic], {
        kind: trial.kind,
        caseCount,
        passedCount,
        failedCount,
      }),
      planHash,
      caseCount,
      passedCount,
      failedCount,
      warningCount,
    };
  }

  async prepareCommit(input: Parameters<ChatOperationV2AuthoringRuntime['prepareCommit']>[0]) {
    const authority = await this.authority(input.stage.stageId);
    const current = await this.requireCurrentSnapshot(authority);
    if (
      input.operation.workspaceScopeId !== this.workspaceScopeId ||
      input.operation.operationId !== authority.stage.operationId ||
      input.operation.generation !== authority.stage.operationGeneration ||
      input.binding.bindingId !== authority.stage.bindingId ||
      input.binding.operationId !== authority.stage.operationId ||
      input.targetId !== authority.stage.targetId ||
      input.relocation.phase !== 'restored' ||
      authority.relocation?.recordHash !== input.relocation.recordHash ||
      input.verification.stagedSnapshotHash !== current.snapshotHash ||
      input.verification.artifactSetHash !== current.artifactSetHash ||
      input.verification.artifactCount !== current.artifactCount
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_commit_handoff',
        'Commit preparation input does not match verified runtime authority.',
      );
    }
    return this.commitPreparer(input);
  }
}

function verificationRepair(
  trialIdValue: string,
  diagnostics: readonly string[],
  evidence: unknown,
): Extract<ChatOperationV2AuthoringVerificationResult, { kind: 'repair_required' }> {
  const diagnosticCodes = [
    ...new Set(diagnostics.map((code) => safeCode(code, 'verification_failed'))),
  ].slice(0, MAX_DIAGNOSTIC_CODES);
  return {
    kind: 'repair_required',
    trialId: trialIdValue,
    planHash: null,
    caseCount: 0,
    passedCount: 0,
    failedCount: 0,
    warningCount: 0,
    diagnosticCodes,
    evidenceHash: sha256(canonicalJson({ diagnosticCodes, evidence })),
  };
}

function verificationDiscard(
  trialIdValue: string,
  errorCode: string,
  diagnostics: readonly string[],
): Extract<ChatOperationV2AuthoringVerificationResult, { kind: 'discard' }> {
  return {
    kind: 'discard',
    trialId: trialIdValue,
    planHash: null,
    caseCount: 0,
    passedCount: 0,
    failedCount: 0,
    warningCount: 0,
    errorCode: safeCode(errorCode, 'verification_failed'),
    diagnosticCodes: diagnostics.map((code) => safeCode(code, 'verification_failed')).slice(0, 16),
  };
}

function sessionTreeChildrenFirst(
  tree: readonly ManagedChatOperationV2OpenCodeSessionTreeEntry[],
  rootSessionId: string,
): ManagedChatOperationV2OpenCodeSessionTreeEntry[] {
  if (tree.length === 0 || tree.length > 256) {
    throw new Error('OpenCode session tree exceeds its finite runtime bound.');
  }
  const byId = new Map<string, ManagedChatOperationV2OpenCodeSessionTreeEntry>();
  for (const entry of tree) {
    if (byId.has(entry.sessionId))
      throw new Error('OpenCode session tree has duplicate identities.');
    byId.set(entry.sessionId, entry);
  }
  if (!byId.has(rootSessionId)) throw new Error('OpenCode session tree root is missing.');
  const depth = (entry: ManagedChatOperationV2OpenCodeSessionTreeEntry): number => {
    let current = entry;
    let value = 0;
    const seen = new Set([entry.sessionId]);
    while (current.parentSessionId !== null) {
      const parent = byId.get(current.parentSessionId);
      if (!parent || seen.has(parent.sessionId))
        throw new Error('OpenCode session tree is invalid.');
      seen.add(parent.sessionId);
      current = parent;
      value += 1;
    }
    if (current.sessionId !== rootSessionId)
      throw new Error('OpenCode session escaped the root tree.');
    return value;
  };
  return [...tree].sort((left, right) => depth(right) - depth(left));
}

export interface ManagedChatOperationV2CommitStageMaterial {
  readonly workspaceScopeId: string;
  readonly stage: ChatOperationV2AuthoringStage;
  readonly relocation: ChatOperationV2SessionRelocation | null;
  readonly sourceDirectory: string;
  readonly stageDirectory: string;
  readonly targetRelativePath: string;
  readonly workingRelativePath: string;
  readonly stagedSnapshotHash: string;
  readonly artifactSetHash: string;
  readonly artifacts: readonly ManagedChatOperationV2CommitArtifactProjection[];
}

/** Authenticated private bridge from the authoring stage to Phase-4 commit path authority. */
export async function readManagedChatOperationV2CommitStageMaterial(input: {
  readonly canonicalWorkspaceRoot: string;
  readonly workspaceScopeId: string;
  readonly stageId: string;
}): Promise<ManagedChatOperationV2CommitStageMaterial> {
  const workspace = new WorkspaceState(input.canonicalWorkspaceRoot);
  workspace.workDir = input.canonicalWorkspaceRoot;
  const staging = new ProductionStagingAdapter(workspace);
  const [snapshot, authority] = await Promise.all([
    staging.inspectStage(input.stageId),
    staging.readAuthority(input.stageId),
  ]);
  if (
    !snapshot ||
    !authority ||
    authority.version !== AUTHORING_AUTHORITY_VERSION ||
    authority.workspaceScopeId !== input.workspaceScopeId ||
    authority.stage.stageId !== input.stageId ||
    authority.sourceDirectory !== snapshot.sourceDirectory ||
    authority.stageDirectory !== snapshot.stageDirectory ||
    authority.workingRelativePath !== snapshot.workingRelativePath ||
    authority.stage.sourceDirectoryIdentity !== directoryIdentity(snapshot.sourceDirectory) ||
    authority.stage.stageDirectoryIdentity !== directoryIdentity(snapshot.stageDirectory)
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Commit stage material does not match authenticated authoring authority.',
    );
  }
  if (authority.relocation) parseChatOperationV2SessionRelocation(authority.relocation);
  const descriptor = listChatYamlStage(workspace, input.stageId, true);
  const artifactSet = deriveManagedChatOperationV2CommitArtifactSet(descriptor);
  if (
    artifactSet.artifactSetHash !== snapshot.artifactSetHash ||
    artifactSet.artifacts.length !== snapshot.artifactCount
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'authority_mismatch',
      'Commit artifact projection changed while reading the authenticated stage.',
    );
  }
  return Object.freeze({
    workspaceScopeId: input.workspaceScopeId,
    stage: authority.stage,
    relocation: authority.relocation,
    sourceDirectory: snapshot.sourceDirectory,
    stageDirectory: snapshot.stageDirectory,
    targetRelativePath: authority.targetRelativePath,
    workingRelativePath: authority.workingRelativePath,
    stagedSnapshotHash: snapshot.snapshotHash,
    artifactSetHash: artifactSet.artifactSetHash,
    artifacts: artifactSet.artifacts,
  });
}

export function createManagedChatOperationV2AuthoringRuntime(
  options: CreateManagedChatOperationV2AuthoringRuntimeOptions,
): ChatOperationV2AuthoringRuntime {
  const staging =
    options.staging ?? (options.workspace ? new ProductionStagingAdapter(options.workspace) : null);
  if (!staging)
    throw new TypeError('Managed authoring runtime requires a workspace staging adapter.');
  const sourceDirectory = options.workspace?.workDir
    ? ensureRealTagmaDirectory(options.workspace.workDir)
    : null;
  const openCode =
    options.openCode ??
    (sourceDirectory && options.invocationStore
      ? new ProductionOpenCodeAdapter(sourceDirectory, options.invocationStore)
      : null);
  if (!openCode) throw new TypeError('Managed authoring runtime requires an OpenCode adapter.');
  return new ManagedAuthoringRuntime(
    options.workspaceScopeId,
    staging,
    openCode,
    options.commitPreparer,
    options.now ?? Date.now,
    options.resolveTarget ??
      ((input) => ({
        sourceRelativePath: input.intent === 'edit' ? input.binding.target.coordinate : null,
      })),
  );
}
