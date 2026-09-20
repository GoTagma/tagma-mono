import { createHash } from 'node:crypto';

import { isValidPipelineStem } from '../pipeline-paths.js';
import { normalizeChatOperationV2TargetCoordinate } from './binding.js';
import type { ChatOperationV2HostInventory } from './inventory.js';
import type {
  ChatOperationV2AuthoringTargetResolution,
  ChatOperationV2AuthoringTargetResolver,
  ResolveChatOperationV2AuthoringTargetInput,
} from './service.js';

export interface CreateChatOperationV2AuthoringTargetResolverOptions {
  readonly getCurrentInventory: () => ChatOperationV2HostInventory;
  readonly platform?: 'win32' | 'posix';
}

function digest(...values: readonly string[]): string {
  const hash = createHash('sha256');
  for (const value of values) hash.update(value).update('\0');
  return hash.digest('hex');
}

function isolatedTargetCoordinate(
  inventory: ChatOperationV2HostInventory,
  platform: 'win32' | 'posix',
  ...authority: readonly string[]
): { readonly suffix: string; readonly relativePath: string } {
  const suffix = digest(...authority).slice(0, 24);
  const stem = `chat-${suffix}`;
  const relativePath = `${stem}/${stem}.yaml`;
  if (inventoryHasTargetCoordinate(inventory, relativePath, platform)) {
    throw Object.assign(new Error('Authoring branch target is already present.'), {
      code: 'host_inventory_conflict',
    });
  }
  return { suffix, relativePath };
}

function inventoryHasTargetCoordinate(
  inventory: ChatOperationV2HostInventory,
  relativePath: string,
  platform: 'win32' | 'posix',
): boolean {
  const target = normalizeChatOperationV2TargetCoordinate(relativePath, platform);
  return inventory.inventory.candidates.some((candidate) => {
    const existing = normalizeChatOperationV2TargetCoordinate(candidate.relativePath, platform);
    return existing.platform === target.platform && existing.identity === target.identity;
  });
}

function requestedTargetCoordinate(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.length !== 2) return null;
  const [folder, filename] = segments;
  const match = /^(.+)\.yaml$/iu.exec(filename ?? '');
  return folder && match?.[1] === folder && isValidPipelineStem(folder) ? normalized : null;
}

class HostInventoryAuthoringTargetResolver implements ChatOperationV2AuthoringTargetResolver {
  readonly #getCurrentInventory: () => ChatOperationV2HostInventory;
  readonly #platform: 'win32' | 'posix';

  constructor(options: CreateChatOperationV2AuthoringTargetResolverOptions) {
    this.#getCurrentInventory = options.getCurrentInventory;
    this.#platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  }

  resolveTarget(
    input: ResolveChatOperationV2AuthoringTargetInput,
  ): ChatOperationV2AuthoringTargetResolution {
    const inventory = this.#getCurrentInventory();
    if (inventory.inventory.digest !== input.evidence.inventoryDigest) {
      throw Object.assign(new Error('Authoring inventory changed before target reservation.'), {
        code: 'host_inventory_conflict',
      });
    }
    if (input.evidence.kind === 'edit') {
      const candidate = inventory.resolveCandidate(input.evidence.candidateId);
      if (candidate.contentHash !== input.evidence.candidateContentHash) {
        throw Object.assign(new Error('Authoring origin changed before target reservation.'), {
          code: 'host_inventory_conflict',
        });
      }
      const candidateTarget = normalizeChatOperationV2TargetCoordinate(
        candidate.relativePath,
        this.#platform,
      );
      const owned = input.ownedTargets?.find(
        ({ target }) =>
          target.platform === candidateTarget.platform &&
          target.identity === candidateTarget.identity,
      );
      if (owned?.busy)
        throw Object.assign(new Error('The owned pipeline is being edited by another operation.'), {
          code: 'authoring_target_conflict',
        });
      if (owned)
        return Object.freeze({
          targetId: candidate.id,
          target: candidateTarget,
          originHash: candidate.contentHash,
          ...(owned.activeLease === null ? {} : { supersedePublished: owned.activeLease }),
        });
      const { relativePath } = isolatedTargetCoordinate(
        inventory,
        this.#platform,
        'tagma-chat-operation-v2-edit-target',
        input.operation.operationId,
        candidate.id,
        candidate.contentHash,
      );
      return Object.freeze({
        targetId: candidate.id,
        target: normalizeChatOperationV2TargetCoordinate(relativePath, this.#platform),
        originHash: candidate.contentHash,
      });
    }

    const isolated = isolatedTargetCoordinate(
      inventory,
      this.#platform,
      'tagma-chat-operation-v2-create-target',
      input.operation.operationId,
      input.evidence.requestId,
      input.evidence.requestHash,
    );
    const requested = requestedTargetCoordinate(input.evidence.requestedTargetRelativePath);
    const relativePath =
      requested && !inventoryHasTargetCoordinate(inventory, requested, this.#platform)
        ? requested
        : isolated.relativePath;
    return Object.freeze({
      targetId: `target_${isolated.suffix}`,
      target: normalizeChatOperationV2TargetCoordinate(relativePath, this.#platform),
      originHash: null,
    });
  }
}

export function createChatOperationV2AuthoringTargetResolver(
  options: CreateChatOperationV2AuthoringTargetResolverOptions,
): ChatOperationV2AuthoringTargetResolver {
  return new HostInventoryAuthoringTargetResolver(options);
}
