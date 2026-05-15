#!/usr/bin/env node
// ANGLE: circular dependencies in the workspace graph.
//
// A cycle among @tagma/* packages (A deps B deps A) has no single valid
// build/publish order; the sequential `build`/`publish:*` scripts in
// package.json assume a DAG. tsc/lint/test/build can all pass with a
// cycle present (bun resolves it locally) yet `publish:all` ships a
// broken set. Cycle detection + teeth: scripts/lib/graph-cycles.mjs.
import { findCycles } from './lib/graph-cycles.mjs';
import { reportGate, workspacePackages } from './lib/repo.mjs';

const packages = workspacePackages();
const names = new Set(packages.map((p) => p.name));

// Runtime/publish edges only: dependencies + peerDependencies +
// optionalDependencies. devDependencies cycles don't affect publish
// order and are common, so they are intentionally excluded.
const graph = new Map();
for (const { name, manifest } of packages) {
  const edges = new Set();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (names.has(dep) && dep !== name) edges.add(dep);
    }
  }
  graph.set(name, edges);
}

reportGate(
  'cycles-check',
  findCycles(graph).map((c) => `dependency cycle: ${c}`),
  `clean (${packages.length} packages form a DAG)`,
);
