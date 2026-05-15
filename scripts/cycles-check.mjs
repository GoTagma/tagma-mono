#!/usr/bin/env node
// ANGLE: circular dependencies in the workspace graph.
//
// A cycle among @tagma/* packages (A deps B deps A) has no single valid
// build/publish order; the sequential `build`/`publish:*` scripts in
// package.json assume a DAG. tsc/lint/test/build can all pass with a
// cycle present (bun resolves it locally) yet `publish:all` ships a
// broken set. This gate fails on any runtime-edge cycle.
import { reportGate, workspacePackages } from './lib/repo.mjs';

const packages = workspacePackages();
const names = new Set(packages.map((p) => p.name));

// Runtime/publish edges only: dependencies + peerDependencies +
// optionalDependencies. devDependencies cycles don't affect publish
// order and are common (a tool dev-depending on its own ecosystem).
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

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map([...names].map((n) => [n, WHITE]));
const stack = [];
const cycles = [];

function visit(node) {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of graph.get(node) ?? []) {
    if (color.get(next) === GRAY) {
      const from = stack.indexOf(next);
      cycles.push([...stack.slice(from), next].join(' -> '));
    } else if (color.get(next) === WHITE) {
      visit(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const node of names) {
  if (color.get(node) === WHITE) visit(node);
}

reportGate(
  'cycles-check',
  [...new Set(cycles)].map((c) => `dependency cycle: ${c}`),
  `clean (${packages.length} packages form a DAG)`,
);
