/**
 * Renderer-visible provider-state is a deliberately narrow, non-secret
 * presentation contract. It must never mirror OpenCode's provider/config
 * objects because those can contain API keys, headers, and provider-specific
 * request options.
 */
export const TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION = 2 as const;

export interface TagmaOpenCodeModelCapabilities {
  readonly reasoning: boolean;
  readonly toolcall: boolean;
}

export interface TagmaOpenCodeModelLimit {
  readonly context?: number;
  readonly output?: number;
}

/** Active variant ids only. Values intentionally carry no provider options. */
export type TagmaOpenCodeModelVariants = Readonly<Record<string, Readonly<Record<never, never>>>>;

export interface TagmaConfiguredOpenCodeModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly status: string;
  readonly capabilities: TagmaOpenCodeModelCapabilities;
  readonly limit: TagmaOpenCodeModelLimit;
  readonly variants: TagmaOpenCodeModelVariants;
}

export interface TagmaConfiguredOpenCodeProvider {
  readonly id: string;
  readonly name: string;
  readonly models: Readonly<Record<string, TagmaConfiguredOpenCodeModel>>;
}

export interface TagmaOpenCodeModelCatalogProvider {
  readonly id: string;
  readonly name: string;
}

export interface TagmaOpenCodeModelCatalogModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly status: string;
  readonly capabilities: TagmaOpenCodeModelCapabilities;
  readonly limit: TagmaOpenCodeModelLimit;
  /** OpenCode catalog order, with opaque variant options intentionally removed. */
  readonly variants: readonly string[];
}

export interface TagmaOpenCodeProviderDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly env: readonly string[];
}

/** A declarative condition used to reveal an authentication prompt. */
export interface TagmaOpenCodeProviderAuthPromptCondition {
  readonly key: string;
  readonly op: 'eq' | 'neq';
  readonly value: string;
}

export interface TagmaOpenCodeProviderAuthTextPrompt {
  readonly type: 'text';
  readonly key: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly when?: TagmaOpenCodeProviderAuthPromptCondition;
}

export interface TagmaOpenCodeProviderAuthSelectOption {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export interface TagmaOpenCodeProviderAuthSelectPrompt {
  readonly type: 'select';
  readonly key: string;
  readonly message: string;
  readonly options: readonly TagmaOpenCodeProviderAuthSelectOption[];
  readonly when?: TagmaOpenCodeProviderAuthPromptCondition;
}

/**
 * The sole authentication-method shape allowed across the Host → renderer
 * boundary. It deliberately contains only presentation metadata needed to
 * render the connection form; provider configuration and SDK extension data
 * stay Host-owned.
 */
export interface TagmaOpenCodeProviderAuthMethod {
  readonly type: 'oauth' | 'api';
  readonly label: string;
  readonly prompts?: readonly (
    TagmaOpenCodeProviderAuthTextPrompt | TagmaOpenCodeProviderAuthSelectPrompt
  )[];
}

export interface TagmaOpenCodeProviderState {
  readonly schemaVersion: typeof TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION;
  readonly configured: {
    readonly providers: readonly TagmaConfiguredOpenCodeProvider[];
    readonly default: Readonly<Record<string, string>>;
  };
  readonly catalog: {
    readonly all: readonly TagmaOpenCodeProviderDirectoryEntry[];
    readonly connected: readonly string[];
    readonly authMethods: Readonly<Record<string, readonly TagmaOpenCodeProviderAuthMethod[]>>;
  };
  readonly modelCatalog: {
    readonly providers: readonly TagmaOpenCodeModelCatalogProvider[];
    readonly models: readonly TagmaOpenCodeModelCatalogModel[];
  } | null;
  readonly availability: {
    readonly providerList: boolean;
    readonly authMethods: boolean;
    readonly modelCatalog: boolean;
  };
}
