import type { MemoryEvidenceHit } from './recall-memory.js';
import { FACT_QUERY_STOPWORDS } from './fact-query-stopwords.js';

const words = (text: string): Set<string> => new Set(
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length >= 3 && !FACT_QUERY_STOPWORDS.has(word)),
);

/** Canonical fact/policy projections count once in the candidate snapshot. */
export function distinctiveRecallFactKey(hit: MemoryEvidenceHit): string | null {
  return hit.ref.type === 'fact' || hit.ref.type === 'policy' ? `fact:${hit.ref.id}` : null;
}

/**
 * A literal query term found in few of the already-admitted, source-backed
 * facts is useful ranking evidence that raw overlap fractions lose. The
 * snapshot is local to this recall: it says nothing about global rarity,
 * semantic applicability or exhaustive coverage. Scope, validity, account and
 * correction admission must run first; this helper never fetches more memory.
 */
export function prioritizeDistinctiveRecallFacts(
  hits: MemoryEvidenceHit[],
  query: string,
  nonBoostableRefs: ReadonlySet<string> = new Set(),
): MemoryEvidenceHit[] {
  const queryWords = words(query);
  if (queryWords.size === 0) return hits;
  const excluded = new Set(nonBoostableRefs);
  const documents = new Map<string, Set<string>>();
  for (const hit of hits) {
    const key = distinctiveRecallFactKey(hit);
    if (!key || hit.evidence.length === 0) continue;
    // Do not cross recallMemory's existing .45 support floor solely through
    // this new ranking signal. Count weak documents, but leave them unchanged;
    // any weak alias likewise prevents upgrading that canonical fact.
    if (hit.score < 0.45) excluded.add(key);
    const document = documents.get(key) ?? new Set<string>();
    for (const word of words(hit.text)) document.add(word);
    documents.set(key, document);
  }
  if (documents.size < 2) return hits;
  const frequencies = new Map<string, number>();
  for (const document of documents.values()) {
    for (const word of queryWords) {
      if (document.has(word)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }
  const denominator = Math.log(documents.size + 1);
  return hits.map(hit => {
    const key = distinctiveRecallFactKey(hit);
    if (!key || hit.evidence.length === 0 || excluded.has(key)) return hit;
    const document = documents.get(key)!;
    let strength = 0;
    for (const word of queryWords) {
      if (!document.has(word)) continue;
      const frequency = frequencies.get(word)!;
      strength = Math.max(strength, Math.log((documents.size + 1) / (frequency + 1)) / denominator);
    }
    if (!(strength > 0)) return hit;
    return {
      ...hit,
      // Same bounded interpolation as explicit named-entity priority. A sparse
      // two-document match earns only a small bonus; all candidates stay, and
      // stronger semantic/contextual support still competes normally.
      score: hit.score + 0.4 * Math.max(0, 1 - hit.score) * strength,
      whyRecalled: [...new Set([...hit.whyRecalled,
        'literal query term distinctive among admitted source-backed facts; not applicability proof'])],
    };
  });
}
