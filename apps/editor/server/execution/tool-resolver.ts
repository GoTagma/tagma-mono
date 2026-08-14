import type { DriverPlugin, SpawnSpec } from '@tagma/types';
import { resolveOpencodeBinary } from '../opencode-lifecycle.js';

export function isManagedOpencodeSpawn(spec: SpawnSpec, driver: DriverPlugin | null): boolean {
  return driver?.name === 'opencode' && spec.args[0] === 'opencode';
}

export function resolveEditorDriverSpawnSpec(
  spec: SpawnSpec,
  driver: DriverPlugin | null,
): SpawnSpec {
  if (!isManagedOpencodeSpawn(spec, driver)) return spec;
  const binary = resolveOpencodeBinary();
  if (binary === spec.args[0]) return spec;
  return { ...spec, args: [binary, ...spec.args.slice(1)] };
}
