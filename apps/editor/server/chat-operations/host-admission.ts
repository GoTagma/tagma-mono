import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import type { ChatPipelineIntentCandidate } from '../../shared/chat-pipeline-intent-classifier.js';
import { isValidChatPipelineRepairAttempts } from '../../shared/chat-pipeline-repair-limit.js';
import type { ChatOperationV2CreateRequest } from './api-requests.js';
import type { CreateAndDispatchReadonlyInput } from './service.js';
import type { ChatInventorySnapshot } from './snapshots.js';

export const CHAT_OPERATION_V2_HOST_ADMISSION_SCHEMA_VERSION = 1 as const;

export type ChatOperationV2HostAdmissionErrorCode =
  'selected_model_unavailable' | 'invalid_host_authority' | 'host_inventory_conflict';

export class ChatOperationV2HostAdmissionError extends Error {
  constructor(
    readonly code: ChatOperationV2HostAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatOperationV2HostAdmissionError';
  }
}

export type ChatOperationV2HostAuthorityValue =
  | null
  | boolean
  | number
  | string
  | readonly ChatOperationV2HostAuthorityValue[]
  | { readonly [key: string]: ChatOperationV2HostAuthorityValue };

export interface ChatOperationV2HostAdmissionAuthority {
  /** Fresh Host enumeration. Renderer paths and hashes must never populate this value. */
  readonly inventory: ChatInventorySnapshot;
  /** Classifier projection derived from the same Host enumeration. */
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  /** Host-owned effective agent policy, with secrets omitted. */
  readonly agentPolicy: ChatOperationV2HostAuthorityValue;
  /** Host-owned effective settings, with credentials and authored text omitted. */
  readonly settings: ChatOperationV2HostAuthorityValue;
  /** Host-owned repair budget read from the effective workspace settings. */
  readonly repairMaxAttempts: number;
  /** Sidecar/runtime capabilities proved by the installed build. */
  readonly capabilities: ChatOperationV2HostAuthorityValue;
  /** Exact selected model state resolved by the Host for this request. */
  readonly selectedModel: {
    readonly providerID: string;
    readonly modelID: string;
    readonly configured: boolean;
  };
  /** Exact server-side feature/cutover state for this admission. */
  readonly features: ChatOperationV2HostAuthorityValue;
  readonly validateCanonicalYaml: (yaml: string) => void;
}

const encoder = new TextEncoder();
const MAX_AUTHORITY_DEPTH = 12;
const MAX_AUTHORITY_PROPERTIES = 16_384;
const MAX_AUTHORITY_BYTES = 1024 * 1024;

function invalidAuthority(message: string): never {
  throw new ChatOperationV2HostAdmissionError(
    'invalid_host_authority',
    `Invalid Chat Operation V2 Host admission authority: ${message}`,
  );
}

function canonicalAuthority(
  value: ChatOperationV2HostAuthorityValue,
  state: { properties: number },
  depth = 0,
): string {
  if (depth > MAX_AUTHORITY_DEPTH) invalidAuthority('maximum depth exceeded.');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        return invalidAuthority('numbers must be finite and must not be negative zero.');
      }
      return JSON.stringify(value);
    case 'string':
      if (value.includes('\0')) invalidAuthority('strings must not contain NUL bytes.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      return invalidAuthority('only canonical JSON data is accepted.');
  }
  if (utilTypes.isProxy(value)) invalidAuthority('Proxy values are forbidden.');
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    if (
      ownKeys.some((key) => typeof key === 'symbol') ||
      ownKeys.length !== expectedKeys.length + 1 ||
      !expectedKeys.every((key) => {
        const descriptor = descriptors[key];
        return (
          descriptor?.enumerable === true &&
          Object.prototype.hasOwnProperty.call(descriptor, 'value')
        );
      }) ||
      descriptors['length']?.enumerable !== false ||
      descriptors['length']?.value !== value.length
    ) {
      return invalidAuthority('arrays must be dense ordinary data arrays.');
    }
    state.properties += value.length;
    if (state.properties > MAX_AUTHORITY_PROPERTIES) {
      return invalidAuthority('property budget exceeded.');
    }
    return `[${value.map((item) => canonicalAuthority(item, state, depth + 1)).join(',')}]`;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return invalidAuthority('objects must have the ordinary object prototype.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) {
    return invalidAuthority('symbol keys are forbidden.');
  }
  const keys = Object.keys(descriptors).sort();
  state.properties += keys.length;
  if (state.properties > MAX_AUTHORITY_PROPERTIES) {
    return invalidAuthority('property budget exceeded.');
  }
  const fields = keys.map((key) => {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return invalidAuthority('accessors and hidden fields are forbidden.');
    }
    return `${JSON.stringify(key)}:${canonicalAuthority(
      descriptor.value as ChatOperationV2HostAuthorityValue,
      state,
      depth + 1,
    )}`;
  });
  return `{${fields.join(',')}}`;
}

export function hashChatOperationV2HostAuthority(
  purpose: 'agent-policy' | 'settings' | 'capabilities' | 'features',
  value: ChatOperationV2HostAuthorityValue,
): string {
  const canonical = canonicalAuthority(value, { properties: 0 });
  const bytes = encoder.encode(canonical);
  if (bytes.byteLength > MAX_AUTHORITY_BYTES) invalidAuthority('byte budget exceeded.');
  return createHash('sha256')
    .update(
      `tagma-chat-operation-v2-host-authority\0${CHAT_OPERATION_V2_HOST_ADMISSION_SCHEMA_VERSION}\0${purpose}\0`,
    )
    .update(bytes)
    .digest('hex');
}

function assertInventoryParity(
  inventory: ChatInventorySnapshot,
  candidates: readonly ChatPipelineIntentCandidate[],
): void {
  const inventoryIds = new Set(inventory.candidates.map(({ id }) => id));
  const inventoryById = new Map(inventory.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateIds = new Set(candidates.map(({ id }) => id));
  if (
    inventoryIds.size !== inventory.candidates.length ||
    candidateIds.size !== candidates.length ||
    inventoryIds.size !== candidateIds.size ||
    [...inventoryIds].some((id) => !candidateIds.has(id)) ||
    candidates.some((candidate) => {
      const inventoryCandidate = inventoryById.get(candidate.id);
      return (
        !inventoryCandidate ||
        candidate.path.replace(/\\/g, '/') !== inventoryCandidate.relativePath
      );
    })
  ) {
    invalidAuthority(
      'inventory and classifier candidates do not have identical Host ids and coordinates.',
    );
  }
}

/**
 * Converts one already-strict renderer request into the service input while
 * deriving every authority hash from a fresh Host snapshot. No renderer field
 * can supply a path, digest, policy, capability, feature, or write grant.
 */
export function resolveChatOperationV2CreateAdmission(
  request: ChatOperationV2CreateRequest,
  authority: ChatOperationV2HostAdmissionAuthority,
): CreateAndDispatchReadonlyInput {
  assertInventoryParity(authority.inventory, authority.candidates);
  if (!isValidChatPipelineRepairAttempts(authority.repairMaxAttempts)) {
    invalidAuthority('repairMaxAttempts is outside the supported Host settings range.');
  }
  const payload = request.payload;
  if (
    authority.selectedModel.providerID !== payload.provider ||
    authority.selectedModel.modelID !== payload.model
  ) {
    invalidAuthority('selected model authority does not match the requested model.');
  }
  if (!authority.selectedModel.configured) {
    throw new ChatOperationV2HostAdmissionError(
      'selected_model_unavailable',
      'The selected model is not configured in the managed OpenCode runtime.',
    );
  }
  const dirtySnapshot = payload.dirtySnapshot;
  if (
    payload.candidateId !== null &&
    !authority.inventory.candidates.some(({ id }) => id === payload.candidateId)
  ) {
    throw new ChatOperationV2HostAdmissionError(
      'host_inventory_conflict',
      'The Chat Operation V2 request selected an unknown Host candidate.',
    );
  }
  if (dirtySnapshot !== null) {
    if (payload.candidateId === null || payload.localRevision === null) {
      throw new ChatOperationV2HostAdmissionError(
        'invalid_host_authority',
        'A dirty Chat Operation V2 snapshot lost its Host candidate identity.',
      );
    }
  }
  return Object.freeze({
    clientRequestId: request.clientRequestId,
    request: Object.freeze({
      schemaVersion: 1 as const,
      text: payload.request.text,
      attachments: Object.freeze(
        payload.request.attachments.map((attachment) => Object.freeze({ ...attachment })),
      ),
    }),
    provider: payload.provider,
    model: payload.model,
    variant: payload.variant,
    agentPolicyHash: hashChatOperationV2HostAuthority('agent-policy', authority.agentPolicy),
    settingsHash: hashChatOperationV2HostAuthority('settings', {
      effective: authority.settings,
      repairMaxAttempts: authority.repairMaxAttempts,
    }),
    capabilityHash: hashChatOperationV2HostAuthority('capabilities', {
      runtime: authority.capabilities,
    }),
    featureHash: hashChatOperationV2HostAuthority('features', authority.features),
    rendererInstanceId: payload.rendererInstanceId,
    conversationId: payload.conversationId,
    repairMaxAttempts: authority.repairMaxAttempts,
    inventory: authority.inventory,
    candidates: Object.freeze(
      authority.candidates.map((candidate) => Object.freeze({ ...candidate })),
    ),
    dirtySnapshot:
      dirtySnapshot === null
        ? null
        : Object.freeze({
            candidateId: payload.candidateId!,
            localRevision: payload.localRevision!,
            canonicalYaml: dirtySnapshot.canonicalYaml,
            layoutJson: dirtySnapshot.layoutJson,
            requirementsMarkdown: dirtySnapshot.requirementsMarkdown,
            compileDiagnostics: Object.freeze(
              dirtySnapshot.compileDiagnostics.map((diagnostic) =>
                Object.freeze({ ...diagnostic }),
              ),
            ),
            validateCanonicalYaml: authority.validateCanonicalYaml,
          }),
  });
}
