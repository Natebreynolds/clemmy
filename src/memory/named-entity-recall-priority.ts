import type { MemoryEvidenceHit } from './recall-memory.js';

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A complete multiword canonical name is a stronger scope signal than an
 * incidental single-word alias. This affects ranking, never graph identity. */
export function explicitlyNamesRecallEntity(query: string, name: string): boolean {
  const tokens = words(name);
  if (new Set(tokens.filter(token => /\p{L}/u.test(token))).size < 2) return false;
  return ` ${words(query).join(' ')} `.includes(` ${tokens.join(' ')} `);
}

/** Run after validity, correction, and account-scope filtering. Only existing
 * source-backed candidates with stored links can earn this bounded bonus. */
export function prioritizeNamedEntityFacts(
  hits: MemoryEvidenceHit[],
  namedEntityIds: ReadonlySet<number>,
  edges: ReadonlyArray<{ factId: number; entityId: number; truth: string }>,
): MemoryEvidenceHit[] {
  if (namedEntityIds.size === 0) return hits;
  const factIds = new Set(edges.filter(edge => edge.truth === 'stored'
    && namedEntityIds.has(edge.entityId)).map(edge => String(edge.factId)));
  return hits.map(hit => {
    if ((hit.ref.type !== 'fact' && hit.ref.type !== 'policy')
      || !factIds.has(String(hit.ref.id)) || hit.evidence.length === 0) return hit;
    return {
      ...hit,
      score: hit.score + 0.4 * (1 - hit.score),
      whyRecalled: [...new Set([...hit.whyRecalled, 'source-backed fact for explicitly named entity'])],
    };
  });
}
