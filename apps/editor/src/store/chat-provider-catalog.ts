/**
 * Provider catalog fetching and model reconciliation helpers.
 *
 * The Connect dialog merges two opencode endpoints:
 *   - `GET /provider` → full models.dev universe + connected IDs
 *   - `GET /provider/auth` → per-provider auth method list
 *
 * `fetchProviderCatalog()` returns the merged catalog; `reconcileModelPick()`
 * validates a persisted model against the current provider list and falls
 * back to opencode's own default when the pick is stale.
 */
import {
  getOpencodeClient,
  getOpencodeWorkspaceKey,
  unwrap,
  type ProviderAuthMethod,
} from '../api/opencode-chat';
import type { Provider } from '../api/opencode-chat';
import { savePersisted, type ModelPick } from './chat-persist';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
}

export async function fetchProviderCatalog(): Promise<ProviderCatalogEntry[]> {
  const client = await getOpencodeClient();
  const [listRes, authRes] = await Promise.all([
    unwrap(client.provider.list()).catch((err) => {
      console.error('[chat] provider.list failed:', err);
      return {
        all: [] as Array<{ id: string; name: string; env: string[] }>,
        default: {} as Record<string, string>,
        connected: [] as string[],
      };
    }),
    unwrap(client.provider.auth()).catch((err) => {
      console.error('[chat] provider.auth failed:', err);
      return {} as Record<string, ProviderAuthMethod[]>;
    }),
  ]);
  const connectedSet = new Set(listRes.connected);
  return listRes.all.map((p) => {
    const registered = authRes[p.id];
    const methods: ProviderAuthMethod[] =
      registered && registered.length > 0 ? registered : [{ type: 'api', label: 'API Key' }];
    return {
      id: p.id,
      name: p.name,
      env: p.env ?? [],
      connected: connectedSet.has(p.id),
      methods,
    };
  });
}

/**
 * Reconcile a persisted model pick against the current provider list.
 * Returns it unchanged if still valid; otherwise falls back to opencode's
 * own `default` map (first entry), then to the first model of the first
 * provider, then null.
 */
export function reconcileModelPick(
  providers: Provider[],
  defaults: Record<string, string>,
  current: ModelPick | null,
): ModelPick | null {
  const stillValid =
    current &&
    providers.some(
      (p) => p.id === current.providerID && Object.keys(p.models).includes(current.modelID),
    );
  if (stillValid) return current;
  const defaultProviderID = Object.keys(defaults)[0];
  if (defaultProviderID) {
    return { providerID: defaultProviderID, modelID: defaults[defaultProviderID] };
  }
  const firstProvider = providers[0];
  const firstModelID = firstProvider ? Object.keys(firstProvider.models)[0] : undefined;
  if (firstProvider && firstModelID) {
    return { providerID: firstProvider.id, modelID: firstModelID };
  }
  return null;
}

/**
 * Re-fetch `config.providers()` + the provider catalog after a successful
 * write (setAuth / oauth callback). Updating both in lockstep keeps the
 * ModelPicker and the Connect dialog mutually consistent.
 *
 * Also re-runs `reconcileModelPick` so a user with no valid pick (fresh
 * install) auto-lands on a real model the instant they finish connecting.
 */
export async function refreshProvidersAndAuth(
  get: () => { model: ModelPick | null },
  set: (patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
  }) => void,
): Promise<void> {
  const client = await getOpencodeClient();
  const [providersRes, providerCatalog] = await Promise.all([
    unwrap(client.config.providers()).catch((err) => {
      console.error('[chat] providers refresh failed:', err);
      return { providers: [] as Provider[], default: {} as Record<string, string> };
    }),
    fetchProviderCatalog(),
  ]);
  const providers = providersRes.providers;
  const nextModel = reconcileModelPick(providers, providersRes.default ?? {}, get().model);
  const patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
  } = { providers, providerCatalog };
  if (
    nextModel?.providerID !== get().model?.providerID ||
    nextModel?.modelID !== get().model?.modelID
  ) {
    patch.model = nextModel;
    if (nextModel) savePersisted(getOpencodeWorkspaceKey(), { model: nextModel });
  }
  set(patch);
}
