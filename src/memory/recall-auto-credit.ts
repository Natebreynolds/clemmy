/**
 * Auto-credit — closes the memory-credit loop in code.
 *
 * The old loop asked the model to voluntarily call memory_mark_used after
 * composing its answer; it never did (zero lifetime invocations), so every
 * memory looked idle and nothing resisted decay. Instead, after a turn
 * completes we deterministically match the recall runs' candidates against
 * what the turn actually produced and credit demonstrable use through the
 * existing recordRecallUse sink.
 *
 * Two evidence tiers, both conservative:
 *  - 'cited':   the output contains an exact candidate ref token (fact:123) —
 *               the primer and recall tools print refs in exactly that form.
 *  - 'content': the output reproduces distinctive content from the candidate's
 *               snippet that is NOT present in the user's query (echoing the
 *               question never credits).
 *
 * Absence of evidence is NOT negative evidence: we never auto-record
 * 'not_useful'; unused runs expire and are reaped as before.
 */
import { readRecallRun, recordRecallUse, serializeRecallRef, type RecallCandidateRef } from './recall-usage.js';

export type AutoCreditEvidence = 'cited' | 'content';

export interface DetectedUse {
  ref: RecallCandidateRef;
  evidence: AutoCreditEvidence;
}

const MAX_REFS_PER_RUN = 8;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'was', 'were', 'are', 'is',
  'not', 'but', 'all', 'any', 'can', 'her', 'his', 'their', 'they', 'them', 'then', 'than', 'there',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'how', 'will', 'would', 'could',
  'should', 'shall', 'may', 'might', 'must', 'been', 'being', 'into', 'onto', 'over', 'under', 'about',
  'after', 'before', 'between', 'because', 'does', 'doing', 'done', 'each', 'every', 'more', 'most',
  'other', 'some', 'such', 'only', 'own', 'same', 'still', 'also', 'just', 'very', 'you', 'your',
  'yours', 'our', 'ours', 'its', 'these', 'those', 'here', 'out', 'off', 'too', 'now', 'use', 'used',
  'using', 'get', 'got', 'like', 'make', 'made', 'need', 'needs', 'want', 'wants', 'one', 'two',
]);

export function autoCreditEnabled(): boolean {
  return (process.env.CLEMMY_AUTO_RECALL_CREDIT ?? 'on').toLowerCase() !== 'off';
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9@._/:-]*[a-z0-9]|[a-z0-9]{2,}/g) ?? [];
}

/** A token that plausibly identifies something specific: contains a digit or
 *  an email/URL/domain/path shape. Interior dots count (the tokenizer never
 *  captures sentence-ending punctuation). */
function isIdentifierToken(token: string): boolean {
  return /\d/.test(token) || token.includes('@') || token.includes('/') || token.includes(':') || token.includes('.');
}

function isDistinctiveWord(token: string): boolean {
  return token.length >= 5 && !STOPWORDS.has(token);
}

/** True when `corpus` contains `needle` bounded by non-token characters, so
 *  fact:12 never matches inside fact:123. */
function containsToken(corpus: string, needle: string): boolean {
  let from = 0;
  const bound = /[a-z0-9@._/:-]/;
  while (true) {
    const at = corpus.indexOf(needle, from);
    if (at < 0) return false;
    const before = at > 0 ? corpus[at - 1] : '';
    const after = at + needle.length < corpus.length ? corpus[at + needle.length] : '';
    if (!(before && bound.test(before)) && !(after && bound.test(after))) return true;
    from = at + 1;
  }
}

/** Pure, deterministic matcher — the unit-test surface. Returns the candidates
 *  the turn's output demonstrably used, strongest evidence first, capped. */
export function detectUsedRefs(input: {
  candidates: RecallCandidateRef[];
  replyText: string;
  toolArgTexts?: string[];
  queryText?: string;
}): DetectedUse[] {
  const corpusRaw = [input.replyText, ...(input.toolArgTexts ?? [])].filter(Boolean).join('\n');
  if (!corpusRaw.trim() || input.candidates.length === 0) return [];
  const corpus = corpusRaw.toLowerCase();
  const queryTokens = new Set(tokenize(input.queryText ?? ''));

  const cited: DetectedUse[] = [];
  const content: Array<DetectedUse & { strength: number }> = [];

  for (const ref of input.candidates) {
    // Tier 1 — cited: the exact ref token appears in the output.
    if (containsToken(corpus, serializeRecallRef(ref).toLowerCase())) {
      cited.push({ ref, evidence: 'cited' });
      continue;
    }

    // Tier 2 — content: distinctive snippet material reproduced in the output,
    // excluding anything the user's own query already contained.
    const snippet = ref.snippet ?? '';
    if (!snippet) continue;
    const tokens = tokenize(snippet).filter((t) => !queryTokens.has(t) && !STOPWORDS.has(t));
    if (tokens.length === 0) continue;

    const identifierHits = tokens.filter((t) => isIdentifierToken(t) && containsToken(corpus, t));
    const wordHits = new Set(tokens.filter((t) => isDistinctiveWord(t) && containsToken(corpus, t)));

    // Contiguous 4-word phrase from the snippet appearing verbatim.
    const words = snippet.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    let phraseHit = false;
    for (let i = 0; i + 4 <= words.length && !phraseHit; i++) {
      const phrase = words.slice(i, i + 4).join(' ');
      // The phrase must add signal beyond the query itself.
      if (input.queryText && input.queryText.toLowerCase().includes(phrase)) continue;
      if (corpus.includes(phrase)) phraseHit = true;
    }

    if (identifierHits.length > 0 || wordHits.size >= 3 || phraseHit) {
      content.push({
        ref,
        evidence: 'content',
        strength: identifierHits.length * 3 + wordHits.size + (phraseHit ? 2 : 0),
      });
    }
  }

  content.sort((a, b) => b.strength - a.strength);
  return [...cited, ...content.map(({ ref, evidence }) => ({ ref, evidence }))].slice(0, MAX_REFS_PER_RUN);
}

export interface AutoCreditOutcome {
  recallId: string;
  credited: DetectedUse[];
}

/** Post-turn entry point: best-effort, never throws, never fails a turn.
 *  Loads each run, matches its candidates against the turn's output, and
 *  credits demonstrable use through the existing recordRecallUse sink. */
export function autoCreditRecallRuns(input: {
  recallIds: Array<string | null | undefined>;
  replyText: string;
  toolArgTexts?: string[];
  queryText?: string;
  nowIso?: string;
}): AutoCreditOutcome[] {
  if (!autoCreditEnabled()) return [];
  const outcomes: AutoCreditOutcome[] = [];
  const seen = new Set<string>();
  for (const recallId of input.recallIds) {
    const id = recallId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      const run = readRecallRun(id, input.nowIso);
      if (!run || run.candidateRefs.length === 0) continue;
      const detected = detectUsedRefs({
        candidates: run.candidateRefs,
        replyText: input.replyText,
        toolArgTexts: input.toolArgTexts,
        // The run's own objective is the query whose echo must not credit.
        queryText: input.queryText ?? run.objective,
      });
      if (detected.length === 0) continue;
      const credited: DetectedUse[] = [];
      for (const evidence of ['cited', 'content'] as const) {
        const refs = detected.filter((d) => d.evidence === evidence);
        if (refs.length === 0) continue;
        const result = recordRecallUse({
          recallId: id,
          refs: refs.map((d) => serializeRecallRef(d.ref)),
          outcome: 'used',
          detail: `auto:${evidence}`,
          nowIso: input.nowIso,
        });
        if (result.ok) {
          const recordedKeys = new Set([...result.recorded, ...result.duplicates].map(serializeRecallRef));
          credited.push(...refs.filter((d) => recordedKeys.has(serializeRecallRef(d.ref))));
        }
      }
      if (credited.length > 0) outcomes.push({ recallId: id, credited });
    } catch {
      // Crediting is bookkeeping; it must never break the turn.
    }
  }
  return outcomes;
}
