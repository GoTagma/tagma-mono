# SDK Plugin Authoring

Date: 2026-04-26

Tagma plugins default-export a `TagmaPlugin` object with one or more capability maps. Do not export legacy `pluginCategory` or `pluginType` runtime markers.

## Package Shape

```ts
import type { TagmaPlugin } from '@tagma/types';
import { myDriver } from './driver';

export default {
  name: '@tagma/driver-mytool',
  capabilities: {
    drivers: {
      mytool: myDriver,
    },
  },
} satisfies TagmaPlugin;
```

`package.json` should also include a discovery manifest:

```json
{
  "tagmaPlugin": {
    "category": "drivers",
    "type": "mytool"
  }
}
```

## Capabilities

Supported capability maps:

- `drivers`
- `triggers`
- `completions`
- `middlewares`
- reserved future maps such as `policies`, `storage`, and `telemetry`

One package can register multiple related capabilities.

## Trigger Runtime Access

Trigger plugins receive `ctx.runtime`. Use it for file watching, existence checks, directory creation, timing, and sleep instead of calling Bun or Node globals directly.

```ts
import type { TriggerPlugin } from '@tagma/types';

export const FileLikeTrigger: TriggerPlugin = {
  name: 'file-like',
  async watch(config, ctx) {
    const path = String(config.path);
    await ctx.runtime.ensureDir(ctx.workDir);

    for await (const event of ctx.runtime.watch(ctx.workDir, { signal: ctx.signal })) {
      if (event.type === 'ready' && await ctx.runtime.fileExists(path)) {
        return { path };
      }
    }

    throw new Error('watch ended before trigger fired');
  },
};
```

This keeps triggers testable with fake runtimes and portable to future non-Bun runtime packages.

## Schemas

Drivers, triggers, completions, and middlewares can expose `schema: PluginSchema` so editors can render typed forms. Schemas are descriptive only; plugins still validate their runtime config.
