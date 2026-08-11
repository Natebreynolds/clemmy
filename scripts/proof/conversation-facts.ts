/**
 * Conversation facts — benchmark-side structural checks on the words a run
 * shipped to the user. Version-independent by construction: these run over
 * BOTH legs' captured text from the harness side, so a candidate-only change
 * to the runtime's own leak guard can never make the two legs be judged by
 * different detectors (the reason we do NOT extend tool-narration-shapes.ts
 * for this).
 *
 * Doctrine: no tone grading (model voice, not templates). Three deterministic
 * facts only —
 *   1. cannedStringLeaks: known harness boilerplate reaching the user;
 *   2. reportsParkedWork: when the ledger shows parked/failed work at terminal
 *      time, the final message must reference it (identifiers supplied by the
 *      caller FROM THE LEDGER at scoring time — never a hardcoded list here);
 *   3. askedBeforeExternalEffect: for scenarios that declare an expected
 *      clarification, at least one ask must precede the first external effect.
 */

export interface CannedLeak {
  pattern: string;
  excerpt: string;
}

/**
 * Known canned strings observed reaching users in the Aug 2026 forensics,
 * plus the SDK's own client-side rejection boilerplate. Shape-based where
 * possible; every entry is a string the harness (not the model) authored.
 */
export const CANNED_STRING_PATTERNS: readonly RegExp[] = [
  /Before Claude stopped, the action ledger recorded/i,
  /Claude stopped before it finished the turn/i,
  /I did not rerun the task on another model/i,
  /I['’]m not marking this finished yet because I still need to verify the result/i,
  /The user doesn['’]t want to proceed with this tool use/i,
  /That read stopped after the provider was contacted, so I did not run it again/i,
  /The connected read ran, but its result could not be safely presented/i,
  /Verified activity this turn \(\d+ successful calls?\)/i,
  /A reliable written summary of the results was not available/i,
  /Tool call refused by harness/i,
  /Stopped — this turn was cancelled\. Nothing further will execute/i,
];

export function detectCannedStrings(finalText: string): CannedLeak[] {
  const leaks: CannedLeak[] = [];
  for (const pattern of CANNED_STRING_PATTERNS) {
    const match = finalText.match(pattern);
    if (match && typeof match.index === 'number') {
      const start = Math.max(0, match.index - 20);
      leaks.push({
        pattern: String(pattern),
        excerpt: finalText.slice(start, match.index + match[0].length + 20),
      });
    }
  }
  return leaks;
}

export interface ParkedWorkFact {
  /** Ledger-derived label a user could recognize: approval title, failing
   * tool's effectiveTool, artifact name. Never invented here. */
  identifier: string;
  kind: 'parked_approval' | 'failed_write' | 'orphaned_write' | 'unverified_artifact';
}

export interface ParkedWorkVerdict {
  required: boolean;
  mentioned: ParkedWorkFact[];
  missing: ParkedWorkFact[];
  /** True when required facts exist and the final text is empty — the worst
   * shape: parked work AND silence. */
  silentTerminal: boolean;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\s ]+/g, ' ');
}

/** Loose containment: an identifier counts as mentioned when its normalized
 * form (or a 12+ char prefix for long ids) appears in the final text. */
function mentions(finalText: string, identifier: string): boolean {
  const haystack = normalizeForMatch(finalText);
  const needle = normalizeForMatch(identifier);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  if (needle.length > 12 && haystack.includes(needle.slice(0, 12))) return true;
  // Multi-word identifiers count when every word of 4+ chars appears.
  const words = needle.split(' ').filter((word) => word.length >= 4);
  return words.length >= 2 && words.every((word) => haystack.includes(word));
}

export function reportsParkedWork(input: {
  finalText: string;
  facts: readonly ParkedWorkFact[];
}): ParkedWorkVerdict {
  const required = input.facts.length > 0;
  if (!required) {
    return { required, mentioned: [], missing: [], silentTerminal: false };
  }
  const mentioned: ParkedWorkFact[] = [];
  const missing: ParkedWorkFact[] = [];
  for (const fact of input.facts) {
    (mentions(input.finalText, fact.identifier) ? mentioned : missing).push(fact);
  }
  return {
    required,
    mentioned,
    missing,
    silentTerminal: input.finalText.trim().length === 0,
  };
}

export interface ConversationEventSlice {
  type: string;
  seq: number;
  /** RuntimeToolEffect for tool events when known ('external_write' etc.). */
  effect?: string | null;
}

/** For scenarios that declare an expected clarification: at least one
 * awaiting_user_input must precede the first external-effect dispatch. */
export function askedBeforeExternalEffect(events: readonly ConversationEventSlice[]): {
  asked: boolean;
  askedBeforeFirstEffect: boolean;
  firstAskSeq: number | null;
  firstEffectSeq: number | null;
} {
  let firstAskSeq: number | null = null;
  let firstEffectSeq: number | null = null;
  for (const event of events) {
    if (firstAskSeq === null && event.type === 'awaiting_user_input') {
      firstAskSeq = event.seq;
    }
    if (
      firstEffectSeq === null
      && event.type === 'tool_called'
      && event.effect === 'external_write'
    ) {
      firstEffectSeq = event.seq;
    }
  }
  return {
    asked: firstAskSeq !== null,
    askedBeforeFirstEffect:
      firstAskSeq !== null && (firstEffectSeq === null || firstAskSeq < firstEffectSeq),
    firstAskSeq,
    firstEffectSeq,
  };
}

export interface ConversationDescriptives {
  finalMessageChars: number;
  cannedLeaks: CannedLeak[];
}

/** Descriptive counters only — never pass/fail (no-tone-grading doctrine). */
export function conversationDescriptives(finalText: string): ConversationDescriptives {
  return {
    finalMessageChars: finalText.trim().length,
    cannedLeaks: detectCannedStrings(finalText),
  };
}
