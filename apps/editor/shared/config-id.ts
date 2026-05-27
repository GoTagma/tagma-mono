const ID_HEAD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const ID_TAIL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/**
 * Generate a track/task id that satisfies the SDK's config-id validation:
 * /^[A-Za-z_][A-Za-z0-9_-]*$/
 */
export function generateConfigId(length = 8): string {
  const size = Math.max(1, Math.floor(length));
  let id = ID_HEAD[Math.floor(Math.random() * ID_HEAD.length)] ?? 'a';
  for (let i = 1; i < size; i++) {
    id += ID_TAIL[Math.floor(Math.random() * ID_TAIL.length)] ?? 'a';
  }
  return id;
}
