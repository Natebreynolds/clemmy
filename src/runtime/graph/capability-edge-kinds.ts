/**
 * Host-owned DAG type compatibility. Predecessor produced kinds must satisfy
 * successor accepted kinds. Role labels never authorize an edge.
 */
export function kindsSatisfy(
  produced: readonly string[] | undefined,
  accepted: readonly string[] | undefined,
): boolean {
  const outputs = (produced ?? []).filter((kind) => kind.trim().length > 0);
  const inputs = (accepted ?? []).filter((kind) => kind.trim().length > 0);
  if (outputs.length === 0 || inputs.length === 0) return false;
  return outputs.some((kind) => inputs.includes(kind));
}

export function capabilityEdgeKindError(input: {
  edgeId: string;
  sourceId: string;
  targetId: string;
  produced: readonly string[] | undefined;
  accepted: readonly string[] | undefined;
}): string | null {
  if (kindsSatisfy(input.produced, input.accepted)) return null;
  return (
    `edge ${input.edgeId} type mismatch: ${input.sourceId} produced `
    + `[${(input.produced ?? []).join(',')}] does not satisfy ${input.targetId} accepted `
    + `[${(input.accepted ?? []).join(',')}]`
  );
}

export function validateBoundCapabilityEdges(input: {
  edges: ReadonlyArray<{ id: string; source: string; target: string }>;
  producedByNode: ReadonlyMap<string, readonly string[]>;
  acceptedByNode: ReadonlyMap<string, readonly string[]>;
  executableNodeIds?: ReadonlySet<string>;
}): string[] {
  const errors: string[] = [];
  for (const edge of input.edges) {
    const sourceExec = input.executableNodeIds?.has(edge.source) ?? input.producedByNode.has(edge.source);
    const targetExec = input.executableNodeIds?.has(edge.target) ?? input.acceptedByNode.has(edge.target);
    if (!sourceExec || !targetExec) continue;
    if (!input.producedByNode.has(edge.source) || !input.acceptedByNode.has(edge.target)) {
      errors.push(`edge ${edge.id} missing capability kind metadata`);
      continue;
    }
    const error = capabilityEdgeKindError({
      edgeId: edge.id,
      sourceId: edge.source,
      targetId: edge.target,
      produced: input.producedByNode.get(edge.source),
      accepted: input.acceptedByNode.get(edge.target),
    });
    if (error) errors.push(error);
  }
  return errors;
}
