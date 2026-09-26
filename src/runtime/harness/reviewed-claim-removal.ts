/**
 * Remove the claims a completion review found wrong, and nothing else.
 *
 * An answer is never delivered still carrying the figures its reviewer
 * flagged. When a review's only findings are specific claims (the CORRECT
 * verdict) and the rounds are spent, the host deletes exactly the sentences
 * or list lines that carry the reviewer's own quotes, then names what it
 * removed. Deletion only, by construction: nothing is reworded, recomputed or
 * added. A quote that is not found verbatim means nothing is removed, and the
 * caller keeps the existing unverified delivery.
 */

export interface ReviewedClaimRemoval {
  /** The answer without the flagged claims, plus a closing line naming them. */
  text: string;
  /** The reviewer's quotes, in order. */
  removed: string[];
}

const MIN_QUOTE_CHARS = 4;
const MAX_QUOTE_CHARS = 300;
/** Removing most of an answer is not a correction; keep the review's verdict. */
const MIN_KEPT_SHARE = 0.3;

/** The words the reviewer quoted for each finding, in straight or curly quotes. */
export function reviewQuotes(reason: string): string[] {
  const quotes: string[] = [];
  for (const match of reason.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) {
    const quote = (match[1] ?? match[2] ?? '').trim();
    if (quote.length >= MIN_QUOTE_CHARS && quote.length <= MAX_QUOTE_CHARS && !quotes.includes(quote)) {
      quotes.push(quote);
    }
  }
  return quotes;
}

/** A line that is one unit on its own: a list item, a table row or a heading. */
function isStructuralLine(line: string): boolean {
  return /^\s*(?:[-*+]\s|\d+[.)]\s|\||#)/.test(line);
}

function withoutSentencesContaining(line: string, quote: string): string | null {
  const sentences = line.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !sentence.includes(quote));
  // The quote spans a sentence boundary: the whole line carries the claim.
  if (kept.length === sentences.length) return null;
  const text = kept.join(' ').trim();
  return text || null;
}

export function removeReviewedClaims(reply: string, reason: string): ReviewedClaimRemoval | null {
  const quotes = reviewQuotes(reason);
  if (quotes.length === 0) return null;
  const lines: Array<string | null> = reply.split('\n');
  for (const quote of quotes) {
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === null || line === undefined || !line.includes(quote)) continue;
      found = true;
      lines[index] = isStructuralLine(line) ? null : withoutSentencesContaining(line, quote);
    }
    if (!found) return null;
  }
  const kept = lines
    .filter((line): line is string => line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!kept || kept.length < reply.trim().length * MIN_KEPT_SHARE) return null;
  const named = quotes.map((quote) => `“${quote}”`).join('; ');
  const note = quotes.length === 1
    ? `_I took out one claim the review could not verify: ${named}._`
    : `_I took out ${quotes.length} claims the review could not verify: ${named}._`;
  return { text: `${kept}\n\n${note}`, removed: quotes };
}
