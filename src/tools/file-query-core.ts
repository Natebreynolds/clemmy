/**
 * file_query core (2026-07-21) — deterministic chunk-and-retrieve
 * (capability audit missing-primitive #2, v1).
 *
 * Large inputs did not overflow context (byte-clip tiers saw to that) but
 * they were LOSSY: a 200-page PDF was clipped to its first 24-50k chars and
 * everything past that was simply invisible. This module makes a big text
 * QUERYABLE instead: heading-aware paragraph chunking + purely lexical
 * scoring (term-frequency × inverse-document-frequency + a phrase bonus).
 * No embeddings, no network, no model call — deterministic and instant,
 * which is exactly what a retrieval step inside an autonomous run should be.
 * (An embedding tier can layer on later; it changes ranking, not the shape.)
 */

export interface TextChunk {
  index: number;
  /** Nearest preceding markdown heading — the human-readable location. */
  heading: string | null;
  text: string;
}

export interface ScoredChunk extends TextChunk {
  score: number;
}

const DEFAULT_CHUNK_CHARS = 1400;
const CHUNK_OVERLAP_PARAGRAPHS = 1;

/** Heading-aware chunking: a new markdown heading STARTS a new chunk (each
 *  section carries its own human-readable location), and an over-long section
 *  splits at the size target with one-paragraph overlap for continuity. */
export function chunkText(text: string, opts: { chunkChars?: number } = {}): TextChunk[] {
  const target = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentHeading: string | null = null;
  let size = 0;

  const flush = (withOverlap: boolean): void => {
    if (current.length === 0) return;
    chunks.push({ index: chunks.length, heading: currentHeading, text: current.join('\n\n') });
    current = withOverlap ? current.slice(-CHUNK_OVERLAP_PARAGRAPHS) : [];
    size = current.reduce((n, p) => n + p.length, 0);
  };

  for (const paragraph of paragraphs) {
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(paragraph.split('\n')[0] ?? '');
    if (headingMatch) {
      flush(false); // section boundary — never bleed the previous section in
      currentHeading = headingMatch[1].trim();
    } else if (size + paragraph.length > target && current.length > 0) {
      flush(true); // size split inside a long section — keep continuity
    }
    current.push(paragraph);
    size += paragraph.length;
  }
  flush(false);
  return chunks;
}

/** Light deterministic stemmer: enough that "refund" matches "refunds" and
 *  "processing" matches "processed" — no dictionary, no surprises. */
function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'@._-]*/g) ?? [])
    .filter((t) => t.length > 1)
    .map(stem);
}

/** Lexical rank: sum over unique query terms of tf(capped) × idf, plus a
 *  whole-phrase bonus. Ties break toward the earlier chunk (document order). */
export function scoreChunks(chunks: TextChunk[], query: string, topK: number): ScoredChunk[] {
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0 || chunks.length === 0) return [];
  const chunkTokens = chunks.map((c) => tokenize(c.text));
  const docFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    docFrequency.set(term, chunkTokens.filter((tokens) => tokens.includes(term)).length);
  }
  const phrase = query.trim().toLowerCase();
  const scored: ScoredChunk[] = chunks.map((chunk, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const df = docFrequency.get(term) ?? 0;
      if (df === 0) continue;
      const tf = Math.min(5, chunkTokens[i].filter((t) => t === term).length);
      if (tf === 0) continue;
      score += tf * Math.log(1 + chunks.length / df);
    }
    if (phrase.length >= 8 && chunk.text.toLowerCase().includes(phrase)) score *= 1.5;
    return { ...chunk, score };
  });
  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK);
}
