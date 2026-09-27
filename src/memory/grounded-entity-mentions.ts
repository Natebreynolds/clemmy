export interface NamedEntityMentions { id: number; names: readonly string[]; canonicalName?: string }

/** Select distinct, unambiguous mentions before applying a result limit.
 * A substring alias inside a longer name is not another identity assertion.
 * Recall may still use ambiguous aliases as candidates; durable links may not.
 */
export function groundedEntityMentionIds(text: string, entities: readonly NamedEntityMentions[], canonicalOnly = false): number[] {
  const source = text.toLowerCase();
  const mentions: Array<{ id: number; start: number; end: number; canonical: boolean }> = [];
  for (const entity of entities) for (const raw of new Set(entity.names)) {
    const name = raw.trim().toLowerCase();
    if (name.length < 4) continue;
    let from = 0;
    while (from < source.length) {
      const start = source.indexOf(name, from);
      if (start < 0) break;
      const end = start + name.length;
      from = start + 1;
      if ((start > 0 && /[a-z0-9]/.test(source[start - 1]!))
        || (end < source.length && /[a-z0-9]/.test(source[end]!))) continue;
      mentions.push({ id: entity.id, start, end, canonical: name === entity.canonicalName?.trim().toLowerCase() });
    }
  }
  const maximal = mentions.filter(m => !mentions.some(other =>
    other.start <= m.start && other.end >= m.end
    && (other.start < m.start || other.end > m.end)));
  // Apply canonical-only admission AFTER overlap resolution: an old longer
  // alias must still suppress incidental short names inside an unknown name.
  return [...new Set(maximal.filter(m => (!canonicalOnly || m.canonical) && !maximal.some(other =>
    other.id !== m.id && other.start < m.end && other.end > m.start)).map(m => m.id))];
}

const ALNUM_RUN = /[a-z0-9]{2,}/g;

function longestRun(runs: readonly string[]): string {
  return [...runs].sort((a, b) => b.length - a.length || a.localeCompare(b))[0]!;
}

/**
 * An exact prefilter for {@link groundedEntityMentionIds}: given the same
 * text, it returns the only entities that can produce a mention, in their
 * original order, so the mention ids (and their order) are unchanged.
 *
 * Why it is exact: a name is accepted only with a non-alphanumeric character
 * (or the text edge) on both sides, so every alphanumeric run of the name is a
 * maximal run of the lowercased text. The name's longest run of two or more
 * characters (its anchor) is therefore one of the text's `[a-z0-9]{2,}`
 * tokens. A name of four or more characters with no such run cannot be
 * anchored and keeps its entity a candidate for every text; names under four
 * characters never produce a mention and are ignored, as the matcher ignores
 * them.
 */
export function groundedMentionPrefilter<T extends NamedEntityMentions>(entities: readonly T[]): (text: string) => T[] {
  const byAnchor = new Map<string, number[]>();
  const unanchored: number[] = [];
  entities.forEach((entity, position) => {
    const anchors = new Set<string>();
    let alwaysCandidate = false;
    for (const raw of new Set(entity.names)) {
      const name = raw.trim().toLowerCase();
      if (name.length < 4) continue;
      const runs = name.match(ALNUM_RUN);
      if (!runs) { alwaysCandidate = true; break; }
      anchors.add(longestRun(runs));
    }
    if (alwaysCandidate) { unanchored.push(position); return; }
    for (const anchor of anchors) {
      const positions = byAnchor.get(anchor);
      if (positions) positions.push(position);
      else byAnchor.set(anchor, [position]);
    }
  });
  return (text: string): T[] => {
    const positions = new Set<number>(unanchored);
    for (const token of new Set(text.toLowerCase().match(ALNUM_RUN) ?? [])) {
      for (const position of byAnchor.get(token) ?? []) positions.add(position);
    }
    return [...positions].sort((a, b) => a - b).map((position) => entities[position]!);
  };
}
