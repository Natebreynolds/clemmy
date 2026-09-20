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
