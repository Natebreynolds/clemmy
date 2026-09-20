import type { ConsolidatedFact } from './facts.js';

/** One-hop provenance for explicit reads; never search or recursively expand. */
export function formatFactRead(
  fact: ConsolidatedFact,
  lookup: (id: number) => ConsolidatedFact | null,
): string {
  const status = (row: ConsolidatedFact) => `${row.active ? 'active' : 'inactive'}${row.supersededByFactId ? `; superseded by fact:${row.supersededByFactId}` : ''}`;
  const inferred = (fact.derivationDepth ?? 0) > 0 || fact.derivedFrom?.tool === 'recursive_reflection';
  const lines = [
    `[fact:${fact.id}] ${fact.kind}: ${fact.content}`,
    `Status: ${status(fact)}.`,
    ...(inferred ? ['Provenance: inferred pattern, not an explicit user rule; verify source scope before applying.'] : []),
  ];
  const ids = [...new Set(fact.derivedFromFactIds ?? [])];
  if (!ids.length) {
    if (inferred) lines.push('Recorded source fact references: unavailable; do not reconstruct lineage from similar search hits.');
    return lines.join('\n');
  }
  lines.push(`Recorded source fact references: ${ids.map(id => `fact:${id}`).join(', ')}.`,
    'These are stored lineage, not an independent judgment that each source supports the claim. Source previews (one hop):');
  for (const id of ids.slice(0, 6)) {
    const source = lookup(id);
    if (!source) { lines.push(`[fact:${id}] unavailable.`); continue; }
    // An explicit root read may open a retired fact, but automatic expansion
    // must not resurface its content or silently substitute its successor.
    if (!source.active || source.supersededByFactId) {
      lines.push(`[fact:${id}] ${status(source)}; content omitted.`);
      continue;
    }
    const preview = source.content.slice(0, 600);
    lines.push(`[fact:${id}] ${source.kind}: ${preview}${preview.length < source.content.length ? ' [truncated; reopen this fact reference for full text]' : ''}`);
  }
  if (ids.length > 6) lines.push(`${ids.length - 6} source previews omitted; reopen the listed fact references if needed.`);
  return lines.join('\n');
}
