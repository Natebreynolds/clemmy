/**
 * Deterministic recall-query enrichment (COMPOUNDING wave, 2026-08-19).
 *
 * The turn primer retrieved against the raw last message — "and the second
 * one?" carries zero retrievable tokens, so turn 6 of a thread recalled
 * nothing about the thread. No model call and no HyDE: the anchors are the
 * distinctive tokens of the session's own last assistant reply, which is the
 * thing a follow-up phrase refers to. Shared by BOTH brain lanes (parity is
 * a hard requirement — one memory system).
 */
import { listEvents } from './eventlog.js';

const ANCHOR_STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'was', 'were',
  'will', 'would', 'should', 'could', 'here', 'there', 'their', 'they', 'them',
  'your', 'yours', 'about', 'into', 'over', 'under', 'been', 'being', 'more',
  'most', 'some', 'also', 'just', 'than', 'then', 'when', 'what', 'which',
  'while', 'where', 'these', 'those', 'each', 'other', 'because', 'before',
  'after', 'against', 'between', 'during', 'through', 'still', 'very', 'much',
  'want', 'need', 'like', 'looks', 'look', 'note', 'notes', 'source', 'sources',
]);

const MAX_ANCHORS = 10;
const MAX_ANCHOR_SUFFIX_CHARS = 180;

/** Distinctive tokens (len ≥ 4, non-stopword, deduped, reply order). */
export function distinctiveAnchorTokens(text: string, excludeFrom = ''): string[] {
  const exclude = new Set(
    excludeFrom.toLowerCase().split(/[^a-z0-9@.]+/).filter(Boolean),
  );
  const seen = new Set<string>();
  const anchors: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9@.]+/)) {
    const token = raw.replace(/^[.]+|[.]+$/g, '');
    if (token.length < 4) continue;
    if (ANCHOR_STOPWORDS.has(token)) continue;
    if (exclude.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    anchors.push(token);
    if (anchors.length >= MAX_ANCHORS) break;
  }
  return anchors;
}

/**
 * Append the last assistant reply's distinctive tokens to a recall query.
 * Pure read of the session ledger; failure returns the query unchanged.
 */
export function enrichRecallQuery(sessionId: string | undefined, query: string): string {
  const base = query.trim();
  if (!base || !sessionId) return base;
  try {
    const lastReply = listEvents(sessionId, { types: ['conversation_completed'] })
      .map((event) => (typeof event.data.reply === 'string' ? event.data.reply : ''))
      .filter(Boolean)
      .at(-1);
    if (!lastReply) return base;
    const anchors = distinctiveAnchorTokens(lastReply, base);
    if (anchors.length === 0) return base;
    const suffix = anchors.join(' ').slice(0, MAX_ANCHOR_SUFFIX_CHARS);
    return `${base}\n[thread context] ${suffix}`;
  } catch {
    return base;
  }
}
