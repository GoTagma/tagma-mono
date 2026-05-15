// Pure cycle detection over an adjacency map (Map<string, Iterable>).
// Three-colour DFS; returns each back-edge cycle as "a -> b -> a".
export function findCycles(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...graph.keys()].map((n) => [n, WHITE]));
  const stack = [];
  const cycles = new Set();

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        const from = stack.indexOf(next);
        cycles.add([...stack.slice(from), next].join(' -> '));
      } else if (c === WHITE || c === undefined) {
        if (graph.has(next)) visit(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) visit(node);
  }
  return [...cycles];
}
