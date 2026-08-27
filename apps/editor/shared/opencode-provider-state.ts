import type { Provider } from '@opencode-ai/sdk/client';
import type { ModelV2Info, ProviderAuthMethod, ProviderV2Info } from '@opencode-ai/sdk/v2/client';

export const TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION = 1 as const;

export interface TagmaOpenCodeProviderDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly env: readonly string[];
}

export interface TagmaOpenCodeProviderState {
  readonly schemaVersion: typeof TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION;
  readonly configured: {
    readonly providers: readonly Provider[];
    readonly default: Readonly<Record<string, string>>;
  };
  readonly catalog: {
    readonly all: readonly TagmaOpenCodeProviderDirectoryEntry[];
    readonly connected: readonly string[];
    readonly authMethods: Readonly<Record<string, readonly ProviderAuthMethod[]>>;
  };
  readonly modelCatalog: {
    readonly providers: readonly ProviderV2Info[];
    readonly models: readonly ModelV2Info[];
  } | null;
  readonly availability: {
    readonly providerList: boolean;
    readonly authMethods: boolean;
    readonly modelCatalog: boolean;
  };
}
