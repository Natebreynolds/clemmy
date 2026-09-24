/**
 * One cycle detector, for every graph in the execution layer.
 *
 * Two of them existed. `workflow-graph.ts` had a depth-first search that
 * answered yes/no over a compiled graph, and only ever ran at run time.
 * `workflow-authoring.ts` had none, so a dependency loop written by the canvas
 * or by the agent's own authoring tools reached storage and simply never became
 * ready to run. Rather than grow a second traversal beside the first, both call
 * this one.
 *
 * It is deliberately a leaf: it imports nothing from the execution layer, so
 * the authoring path can use it without taking on the compiled-graph module.
 * Callers adapt their own shape by supplying `edgesFrom`.
 */

/**
 * The first dependency loop reachable from `ids`, as the ids that close it, or
 * null when the graph is acyclic.
 *
 * The returned path is the loop ITSELF, not the walk that led into it: entering
 * `a → b → c → b` reports `[b, c]`, because naming `a` would point at a step
 * that is not part of what has to be broken. A step that depends on itself is a
 * loop of one, `[a]`.
 *
 * Edges to ids absent from `ids` are skipped rather than followed — an unknown
 * dependency is a different fault with a better message of its own, and
 * reporting it as a loop would bury it.
 */
export function findCycle(
  ids: Iterable<string>,
  edgesFrom: (id: string) => Iterable<string>,
): string[] | null {
  const known = new Set(ids);
  /** Ids on the current walk, in order, so a hit can be sliced into the loop. */
  const stack: string[] = [];
  const onStack = new Set<string>();
  const settled = new Set<string>();

  function visit(id: string): string[] | null {
    if (onStack.has(id)) return stack.slice(stack.indexOf(id));
    if (settled.has(id)) return null;

    stack.push(id);
    onStack.add(id);
    for (const next of edgesFrom(id)) {
      if (!known.has(next)) continue;
      const loop = visit(next);
      if (loop) return loop;
    }
    stack.pop();
    onStack.delete(id);
    settled.add(id);
    return null;
  }

  for (const id of known) {
    const loop = visit(id);
    if (loop) return loop;
  }
  return null;
}

/** A loop as a person should read it: `"a" → "b" → "a"`, closed back on itself. */
export function describeCycle(loop: string[]): string {
  return [...loop, loop[0]].map((id) => `"${id}"`).join(' → ');
}
