import { createHash } from 'node:crypto';

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
      return Object.freeze({
        targetId: candidate.id,
        target: normalizeChatOperationV2TargetCoordinate(candidate.relativePath, this.#platform),
        originHash: candidate.contentHash,
      });
    }

    const suffix = digest(
      'tagma-chat-operation-v2-create-target',
      input.operation.operationId,
      input.evidence.requestId,
      input.evidence.requestHash,
    ).slice(0, 24);
    const stem = `chat-${suffix}`;
    const relativePath = `${stem}/${stem}.yaml`;
    if (
      inventory.inventory.candidates.some((candidate) => candidate.relativePath === relativePath)
    ) {
      throw Object.assign(new Error('Authoring create target is already present.'), {
        code: 'host_inventory_conflict',
      });
    }
    return Object.freeze({
      targetId: `target_${suffix}`,
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
