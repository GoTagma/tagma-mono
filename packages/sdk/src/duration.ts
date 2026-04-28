// Single source of truth lives in @tagma/types so external plugins
// (trigger-webhook, etc.) and SDK-bundled plugins go through the same
// wrapper without the externals needing to depend on @tagma/sdk.
export { parseOptionalPluginTimeout } from '@tagma/types';
