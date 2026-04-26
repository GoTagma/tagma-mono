// ═══ Engine-facing type surface ═══
//
// All type definitions live in the shared `@tagma/types` workspace package
// so that plugins under plugins/* can depend on the same types without
// reaching into the engine's internals. This file re-exports everything
// and adds runtime-only values (constants) that plugins don't need.

export * from '@tagma/types';

import type { Permissions } from '@tagma/types';

// ═══ Runtime Constants ═══

export const DEFAULT_PERMISSIONS: Permissions = {
  read: true,
  write: false,
  execute: false,
};
