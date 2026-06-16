/**
 * Scrub internal context/memory/focus bookkeeping out of the user-facing
 * `reply` of an OrchestratorDecision.
 *
 * The decision object separates internal reasoning (`summary`, `reason`) from
 * the user-visible `reply` (orchestrator.ts:448 — "reply ... Must contain the
 * actual answer/result/follow-up question. NOT a meta-description"). The model
 * sometimes violates that and narrates its own context-hygiene check INTO the
 * reply, e.g. on a fresh thread that triggers cross-session memory recall:
 *
 *   "I checked the active context. The Salesforce prospect request is a new
 *    topic, not the stale Revill audit thread, so I'm not using that focus.
 *
 *    To pull the right 25, should I use your usual ... lane, or ...?"
 *
 * The first paragraph is pure plumbing narration — the user opened a clean
 * conversation and reads it as Clem being confused about which thread it's in.
 * This strips that LEADING narration while preserving the real answer/question.
 *
 * Deterministic and conservative by design (per the "code-level over
 * prompt-level" + "don't build a fuzzy judge" directives):
 *   - Only LEADING sentences are considered — narration that appears as a
 *     preamble before the real content. We stop at the first sentence that is
 *     not narration, so a genuine answer is never truncated.
 *   - The markers are strong multiword phrases that a user-facing answer
 *     essentially never contains but internal narration does.
 *   - If scrubbing would empty the reply entirely (the rare all-narration
 *     case), the original is returned unchanged — we never blank a reply.
 */

/** Phrases that mark a sentence as internal context/memory/focus narration. */
const NARRATION_PATTERNS: readonly RegExp[] = [
  /\bactive context\b/i,
  /\bi(?:'ve| have)?\s+checked\b[^.?!]*\b(the\s+)?(active context|memory|focus|prior thread|prior session|history)\b/i,
  /\bstale\b[^.?!]*\b(thread|audit|context|session|conversation)\b/i,
  /\b(prior|previous|earlier|another|other|different|last)\s+(session|thread|conversation)\b/i,
  /\b(not|no longer)\s+(using|reusing|applying|carrying|pulling)\b[^.?!]*\b(that|this|the)\s+(focus|context|thread|memory)\b/i,
  /\b(that|this)\s+focus\b/i,
  /\bcarry(?:ing)?\s+over\b[^.?!]*\b(focus|context|memory|thread)\b/i,
  /\b(from|in)\s+my\s+memory\b/i,
];

function isNarrationSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;
  return NARRATION_PATTERNS.some((re) => re.test(s));
}

/** Split a paragraph into sentences, keeping terminal punctuation attached. */
function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
}

/**
 * Strip leading internal-narration sentences/paragraphs from a reply.
 * Returns the cleaned reply (trimmed). If the input has no narration the
 * original is returned (whitespace-normalized only on a real change).
 */
export function scrubInternalNarration(reply: string): string {
  if (!reply || !reply.trim()) return reply;

  const paragraphs = reply.split(/\n\s*\n/);
  const kept: string[] = [];
  let stillStripping = true;
  let changed = false;

  for (const paragraph of paragraphs) {
    if (!stillStripping) {
      kept.push(paragraph);
      continue;
    }

    const sentences = splitSentences(paragraph);
    let cut = 0;
    while (cut < sentences.length && isNarrationSentence(sentences[cut])) {
      cut += 1;
    }

    if (cut === 0) {
      // First sentence of this paragraph is real content — stop stripping.
      kept.push(paragraph);
      stillStripping = false;
      continue;
    }

    changed = true;
    const remainder = sentences.slice(cut).join(' ').trim();
    if (remainder) {
      // Mixed paragraph: dropped the leading narration, kept the real tail.
      kept.push(remainder);
      stillStripping = false;
    }
    // else: whole paragraph was narration — drop it, keep stripping the next.
  }

  if (!changed) return reply;

  const cleaned = kept.join('\n\n').trim();
  // Never blank a reply — if it was ALL narration, leave the original.
  return cleaned ? cleaned : reply;
}
