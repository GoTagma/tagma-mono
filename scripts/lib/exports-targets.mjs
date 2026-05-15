// Pure: flatten every concrete file target out of a package.json
// `exports` subtree (strings at any condition/subpath depth). Used by
// the publish gate; tested so nested-condition handling can't regress.
export function collectExportTargets(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, out);
  }
  return out;
}
