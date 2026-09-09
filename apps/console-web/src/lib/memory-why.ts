/**
 * Plain words for the recall engine's reasons and kinds. The engine returns
 * `whyRecalled` strings like "semantic similarity 0.74" and `ref.type` like
 * "procedure"; the tab used to print them raw. This is the ONE mapper both the
 * Memory tab and the chat's "remembered" strip read, so a reason reads the
 * same everywhere. Unknown strings pass through untouched — never invented.
 */
import type { MemoryHit } from './memory';

export type MemoryKind = 'fact' | 'person' | 'note' | 'preference' | 'howto' | 'source' | 'moment' | 'rule' | 'file';

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'Fact', person: 'Person', note: 'Note', preference: 'Preference', howto: 'How-to', source: 'Source', moment: 'Moment', rule: 'Rule', file: 'File',
};

/** A hit's ref.type (+ a fact's kind when known) → the kind a person recognizes. */
export function memoryKind(refType: string, factKind?: string): MemoryKind {
  if (refType === 'fact') {
    if (factKind === 'feedback') return 'preference';
    if (factKind === 'constraint') return 'rule';
    return 'fact';
  }
  if (refType === 'entity') return 'person';
  if (refType === 'note') return 'note';
  if (refType === 'procedure') return 'howto';
  if (refType === 'policy') return 'rule';
  if (refType === 'episode') return 'moment';
  if (refType === 'deliverable') return 'file';
  if (refType === 'resource') return 'source';
  return 'fact';
}

export interface WhyChip { label: string; strong?: boolean }

/** One engine reason → one chip. Scores become words; strong matches are marked. */
export function whyChip(reason: string): WhyChip | null {
  const r = reason.trim();
  if (!r) return null;
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^semantic similarity ([\d.]+)$/))) return { label: 'similar meaning', strong: Number(m[1]) >= 0.8 };
  if ((m = r.match(/^lexical relevance ([\d.]+)$/))) return { label: Number(m[1]) >= 0.8 ? 'exact words' : 'word match', strong: Number(m[1]) >= 0.8 };
  if ((m = r.match(/^resource overlap ([\d.]+)$/))) return { label: 'same source', strong: Number(m[1]) >= 0.8 };
  if (r === 'source-backed') return { label: 'has a source' };
  if (r === 'entity name or alias matched') return { label: 'exact name', strong: true };
  if (r.startsWith('stored fact-to-entity')) return { label: 'linked to a person' };
  if (r.startsWith('stored entity relationship')) return { label: 'linked to another' };
  if (r.startsWith('stored fact-to-evidence')) return { label: 'backs a fact' };
  if (r.startsWith('stored fact-to-resource')) return { label: 'linked to a source' };
  if (r.startsWith('supports fact:')) return null; // an id, not a reason
  if (r === 'procedural intent match') return { label: 'learned by doing' };
  if (r === 'stored graph traversal') return { label: 'linked in memory' };
  if (r === 'durable episode evidence') return { label: 'a saved moment' };
  if (/^exact temporal/i.test(r)) return { label: 'same day', strong: true };
  if (r.startsWith('deliverable index')) return { label: r.includes('file missing') ? 'file missing' : 'a file she made' };
  if (/temporal|same day|date match/i.test(r)) return { label: 'same day', strong: true };
  if (/pinned/i.test(r)) return { label: 'pinned' };
  return { label: r };
}

/** Chips for a hit, deduped, strong first, capped. */
export function whyChips(hit: Pick<MemoryHit, 'whyRecalled'>, cap = 4): WhyChip[] {
  const out: WhyChip[] = [];
  const seen = new Set<string>();
  for (const reason of hit.whyRecalled ?? []) {
    const chip = whyChip(reason);
    if (!chip || seen.has(chip.label)) continue;
    seen.add(chip.label);
    out.push(chip);
  }
  return out.sort((a, b) => Number(Boolean(b.strong)) - Number(Boolean(a.strong))).slice(0, cap);
}

/** "Salesforce · Aug 25" from a hit's evidence and validity, for the meta column. */
export function hitSourceLine(hit: Pick<MemoryHit, 'evidence' | 'validFrom'>): { source: string; when: string } {
  const uri = hit.evidence?.find((e) => e.sourceUri)?.sourceUri ?? '';
  let source = '';
  // Internal carriers (her own sessions, the console) are not a "source" a person names.
  if (/^(clementine|console|session|episode|desktop|memory):/i.test(uri)) return { source: '', when: whenOf(hit) };
  if (/salesforce/i.test(uri)) source = 'Salesforce';
  else if (/meeting|recall|transcript/i.test(uri)) source = 'Meeting';
  else if (/slack/i.test(uri)) source = 'Slack';
  else if (/outlook|mail/i.test(uri)) source = 'Mail';
  else if (/vault\/|\.md$/i.test(uri)) source = 'Note';
  else if (uri) source = uri.split(/[/:]/).filter(Boolean)[0] ?? 'Source';
  return { source, when: whenOf(hit) };
}
function whenOf(hit: Pick<MemoryHit, 'validFrom'>): string {
  const t = hit.validFrom ? Date.parse(hit.validFrom) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}
/** Engine titles that are labels, not names — never shown as a heading. */
export function displayTitle(hit: Pick<MemoryHit, 'title' | 'ref'>): string {
  const t = (hit.title ?? '').trim();
  if (!t || hit.ref.type === 'fact' || /^supporting memory episode$/i.test(t) || /^episode:/i.test(t)) return '';
  return t;
}
