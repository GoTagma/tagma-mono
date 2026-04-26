# @tagma/runtime-bun

Bun runtime implementation for Tagma pipeline execution.

Exports:

- `bunRuntime()`
- `runSpawn(spec, driver, options?)`
- `runCommand(command, cwd, options?)`
- `@tagma/runtime-bun/adapters/stdin-approval`
- `@tagma/runtime-bun/adapters/websocket-approval`

```ts
import { bunRuntime } from '@tagma/runtime-bun';

const runtime = bunRuntime();
```

The runtime implements process spawning, shell command execution, file watching, file existence checks, filesystem-backed log storage, and Bun-based approval adapters.
