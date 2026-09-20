/** Retrieval coverage is distinct from similarity. An unembedded fact has no
 * cosine score; a low score for other facts cannot establish its novelty. */
export function includeUnembeddedConflictCandidates<T extends { id: number; kind: string; active: boolean }>(
  semantic: Array<{ fact: T; sim: number | null }>,
  lexical: T[],
  embeddedIds: ReadonlySet<number>,
  kind: string,
  limit = 5,
): Array<{ fact: T; sim: number | null }> {
  const result = [...semantic];
  const seen = new Set(result.map(item => item.fact.id));
  let added = 0;
  for (const fact of lexical) {
    if (!fact.active || fact.kind !== kind || seen.has(fact.id) || embeddedIds.has(fact.id)) continue;
    if (added >= limit) break;
    result.push({ fact, sim: null });
    seen.add(fact.id);
    added += 1;
  }
  return result;
}

export function canSkipMemoryConflictReview(
  scored: ReadonlyArray<{ sim: number | null }>,
  threshold: number | undefined,
): boolean {
  return typeof threshold === 'number'
    && scored.length > 0
    && scored.every(item => item.sim !== null && Number.isFinite(item.sim) && item.sim < threshold);
}
