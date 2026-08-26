/**
 * Bounded, provider-neutral semantic segmentation for retrieval.
 *
 * A compound request names several load-bearing capabilities in one sentence:
 * a source read, a destination write, and a delivery effect. Ranking memory
 * against the whole sentence lets the dominant effect suppress the other two.
 * This splitter carries no tool/provider vocabulary and grants no authority;
 * it only gives advisory retrievers smaller pieces of the accepted text.
 */
const SEGMENT_BOUNDARY_RE =
  /(?:[.!?;\n]+|,\s*(?:and\s+|then\s+)?|\b(?:and\s+then|then)\b)/i;

/**
 * Dictation frequently drops punctuation between pipeline stages.  Split only
 * when the whole request begins as a direct read and the later verb consumes
 * the read result or creates/delivers a concrete result.  This stays
 * provider-neutral and advisory: it projects capability roles but grants no
 * dispatch authority.
 *
 * The dependency pronouns are load-bearing. They distinguish a downstream
 * mutation of the retrieved result from a coordinated noun phrase. Modal/to
 * leaders are excluded so an infinitive discussion remains one read request.
 */
const DIRECT_READ_PIPELINE_OPENING_RE =
  /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+(?:you|clem|clementine)\s+)*(?:read|review|summari[sz]e|search|research|find|list|inspect|analy[sz]e|check|look\s+up)\b(?!\s+(?:(?:me|us)\s+)?(?:how|why|whether|if|what|when|where|who)\b)/i;

const RESULT_REFERENCE_SOURCE =
  '(?:it|them|these|those|the\\s+(?:outputs?|results?|selection))';
const RESULT_MUTATION_SOURCE =
  `(?:add|append|copy|delete|edit|insert|modify|move|place|put|remove|replace|save|update|upload)\\s+${RESULT_REFERENCE_SOURCE}\\b`;
const ARTIFACT_CONSTRUCTION_SOURCE =
  '(?:assemble|author|build|create|draft|generate|make|prepare|produce|write)\\s+(?:me\\s+)?(?:a|an|another|new|the)\\b';
const RESULT_DELIVERY_SOURCE = [
  `send\\s+(?:(?:me|us|him|her|them)\\b|${RESULT_REFERENCE_SOURCE}\\b)`,
  '(?:dm|email|message|notify)\\s+(?:me|us|him|her|them)\\b',
].join('|');

const IMPLICIT_PIPELINE_BOUNDARY_RE = new RegExp(
  // Do not split an infinitive/modal discussion ("how to put them").
  `(?<!\\bto)(?<!\\bcan)(?<!\\bmay)(?<!\\bwill)(?<!\\bcould)(?<!\\bshould)(?<!\\bwould)`
  + `(?:\\s+(?=${RESULT_MUTATION_SOURCE})`
  + `|\\s+(?:and\\s+then|and|then)\\s+(?=(?:${RESULT_MUTATION_SOURCE}|${ARTIFACT_CONSTRUCTION_SOURCE}|${RESULT_DELIVERY_SOURCE})))`,
  'i',
);

const RESULT_ACTION_SEGMENT_RE = new RegExp(
  `^(?:${RESULT_MUTATION_SOURCE}|${ARTIFACT_CONSTRUCTION_SOURCE}|${RESULT_DELIVERY_SOURCE})`,
  'i',
);

const LEADING_COORDINATOR_RE =
  /^\s*(?:and|but|now|okay|ok|also|then)\b[,\s]*/i;

/** Keep accepted semantic work aligned with the executable plan topology.
 * `plan_task` and the frozen work graph both admit at most 32 operations; a
 * lower retrieval ceiling silently erased later operations before the agent
 * could assign their host-owned discovery roles. */
export const REQUEST_SEMANTIC_SEGMENT_LIMIT = 32;

/** Whether one already-segmented clause is a concrete downstream result
 * mutation/construction/delivery. Shared by the intent classifier so semantic
 * segmentation and route authority cannot disagree about the same boundary. */
export function isResultActionSemanticSegment(text: string): boolean {
  return RESULT_ACTION_SEGMENT_RE.test(
    (text ?? '').replace(LEADING_COORDINATOR_RE, '').trim(),
  );
}

function lexicalTokenCount(value: string): number {
  return value.split(/[^a-z0-9]+/i).filter((token) => token.length >= 2).length;
}

/**
 * Return meaningful request clauses in source order. One-word fragments from
 * field lists (for example "name, rating, and address") are discarded. When
 * no compound boundary exists, the original request is returned unchanged.
 */
export function requestSemanticSegments(
  text: string,
  options: { limit?: number; minTokens?: number } = {},
): string[] {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const limit = Math.max(
    1,
    Math.min(options.limit ?? REQUEST_SEMANTIC_SEGMENT_LIMIT, REQUEST_SEMANTIC_SEGMENT_LIMIT),
  );
  const minTokens = Math.max(1, Math.min(options.minTokens ?? 2, 8));
  const explicit = normalized.split(SEGMENT_BOUNDARY_RE);
  const raw = DIRECT_READ_PIPELINE_OPENING_RE.test(normalized)
    ? explicit.flatMap((segment) => segment.split(IMPLICIT_PIPELINE_BOUNDARY_RE))
    : explicit;
  if (raw.length <= 1) return [normalized];

  const seen = new Set<string>();
  const segments: string[] = [];
  for (const value of raw) {
    const segment = value.replace(LEADING_COORDINATOR_RE, '').trim();
    if (!segment || lexicalTokenCount(segment) < minTokens) continue;
    const key = segment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(segment);
    if (segments.length >= limit) break;
  }
  return segments.length > 0 ? segments : [normalized];
}
