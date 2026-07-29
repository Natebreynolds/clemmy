/**
 * Pure, dependency-free multi-item intent detection.
 *
 * This lives outside context-packet so execution-boundary guards can reuse the
 * exact same conservative signal without loading memory, MCP, health, or
 * embedding subsystems into a worker process.
 */

export const READ_RE = /\b(?:find|pull|query|search|scrape|crawl|research|audit|summarize|analyze|gather|inspect)\b/i;
export const WRITE_RE =
  /\b(?:create|draft|send|write|produce|generate|compile|assemble|update|append|post|publish|host|deploy|file|sheet|email|proposal|report|edit)\b/i;
export const BATCH_RE = /\b(?:\d+|top\s+\d+|several|many|multiple|batch|bulk|list of|all of them|for each|each one)\b/i;
export const SEQUENCE_RE = /\b(?:then|after that|afterward|before .* then|once .* then|first .* then)\b/i;

// Explicit count immediately governing a plural noun: "10 prospects",
// "44 law firms" (skips up to 3 modifier words, anchors on the plural noun).
const COUNT_PLURAL_RE = /\b(\d{1,3}(?:,\d{3})+|\d+)\s+(?:[a-z][\w'-]+\s+){0,3}?((?:people|men|women|children)|[a-z][a-z'-]*s)\b/i;
// A user-owned count can precede numeric/name modifiers inside the target noun
// phrase: "these 12 Fortune 500 companies", "these 15 ISO 27001 controls".
// Prefer that marked count over incidental numbers embedded in the modifier.
const MARKED_COUNT_PLURAL_RE =
  /\b(?:these|those|each\s+of|every\s+one\s+of(?:\s+(?:the|these|those|my))?|all(?:\s+of)?(?:\s+(?:the|these|those|my))?|the\s+following|top|first|last|leading)\s+(\d{1,3}(?:,\d{3})+|\d+)\s+(?:[a-z0-9&/][\w&/'-]*\s+){0,3}?((?:people|men|women|children)|[a-z][a-z'-]*s)\b/i;
// Enumerated list lines (numbered / bulleted), e.g. a pasted firm list.
const LIST_ITEM_RE = /^[ \t]*(?:\d+[.)]|[-*•–])\s+([^\r\n]+)$/gim;
// Aggregate / single-collection retrieval, not N independent jobs.
const AGGREGATE_RETRIEVAL_RE = /\b(?:show|list|display|view|print|read out|pull up|give me|show me|tell me)\b/i;
// Genuine per-item work. An incidental aggregate verb must not suppress it.
const DEEP_WORK_RE = /\b(?:research|audit|scrape|crawl|analy[sz]e|enrich|profile|investigate|draft|compose|create|build|generate|write|redesign|compile|produce|assemble|summari[sz]e|deploy|publish|update|edit|validate|process|transform|classify|review)\b/i;
// Internal cardinality: N items belong to one parent ("this firm's 10 competitors").
const INTERNAL_OWNER_RE = /\b(?:this|that|the|a|an|each|every|its|his|her|their|our|my|one|same)\s+[a-z][\w-]*['’]s\s+(?:top\s+|first\s+)?(?:\d{1,3}(?:,\d{3})+|\d+)\b/i;
const DISTINCT_MARKER_RE = /\b(?:these|those|each|every|all (?:of )?(?:the|these|those|my|them)|the following|following|below|listed|respectively)\b/i;
const EXPLICIT_PARALLEL_RE = /\b(?:parallel(?:ize|ise|ized|ised)?|concurrent(?:ly)?|fan[- ]?out|same[- ]shape|same shape|per[- ]item|one per)\b/i;
const NON_ITEM_NOUNS = new Set([
  'days', 'weeks', 'months', 'years', 'hours', 'minutes', 'mins', 'seconds', 'secs', 'times',
  'results',
  'words', 'characters', 'chars', 'bytes', 'pages', 'dollars', 'cents', 'miles', 'points', 'percent',
  'options', 'ideas', 'examples', 'reasons', 'tips', 'ways', 'jokes', 'suggestions', 'names',
  'questions', 'thoughts', 'steps', 'versions', 'things', 'ones', 'others',
  // Validation/result cardinality belongs to one parent task, not N workers.
  'checks', 'assertions', 'criteria', 'requirements', 'statuses', 'hashes', 'codes', 'equals', 'matches',
]);
// These nouns can describe either one paginated collection ("pull 200 rows")
// or N independent jobs ("research each of these 120 rows"). They are accepted
// only when the user's own wording supplies an explicit per-item/distinct
// marker plus deep work (or directly asks for parallel work).
const COLLECTION_ITEM_NOUNS = new Set([
  'rows', 'records', 'entries', 'items', 'fields', 'columns', 'cells', 'lines',
]);
const COUNT_CONNECTOR_WORDS = new Set(['a', 'an', 'and', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const SINGLE_PARENT_RE =
  /\b(?:create|build|draft|write|produce|generate|compile|assemble|export|make(?:\s+me)?)\s+(?:one|a|an|the(?!\s+following\b)|my|our|your|this|that|single)\s+[a-z][\w-]*/i;
const LIST_SINGLE_CONTAINER_RE =
  /\b(?:sections|slides|chapters|parts|components|elements)\b[^.!?\n]{0,80}\b(?:in|inside|within|for|of)\s+(?:one|a|an|the|my|our|your|this|that|single)\s+(?:report|document|deck|presentation|file|workspace|page|website|spreadsheet|sheet|brief|proposal)\s*:?\s*$/i;
const EXPLICIT_LIST_TARGET_RE =
  /\b(?:for\s+(?:each|every)|each\s+of|per[- ](?:item|target|row|record|prospect|account|firm)|parallel(?:ize|ise|ized|ised)?|following\s+(?:targets|prospects|accounts|firms|rows|records|items))\b/i;
const SINGLE_PARENT_SOURCE_RE =
  /\b(?:using|from|with|for|about|across|covering|combining|summarizing|summarising|(?:that|which)\s+(?:summari[sz]es|covers)|based on|drawing on)(?:\s+(?:each of|these|those|the))?\s*$/i;
const SOURCE_TO_SINGLE_OUTPUT_RE =
  /\b(?:combine|merge|consolidate|synthesi[sz]e|summari[sz]e|turn|convert|transform|write\s+up|distill)\b[^.!?\n]{0,240}\b(?:\d{1,3}(?:,\d{3})+|\d+)\s+(?:[a-z][\w'-]+\s+){0,3}(?:people|men|women|children|[a-z][a-z'-]*s)\b[^.!?\n]{0,240}\b(?:into|as|to|in|within)\s+(?:one|a|an|the|single)\s+[a-z][\w-]*/i;
const COUNTED_PARTS_SINGLE_CONTAINER_RE =
  /\b(?:\d{1,3}(?:,\d{3})+|\d+)\s+(?:[a-z][\w'-]+\s+){0,2}(?:sections|slides|chapters|parts|components|elements)\b[^.!?\n]{0,160}\b(?:in|inside|within|for|of)\s+(?:one|a|an|the|single)\s+[a-z][\w-]*/i;
const ANAPHORIC_SINGLE_OUTPUT_PROPOSAL_RE =
  /\b(?:(?:combine|merge|consolidate|synthesi[sz]e|turn|convert|transform|write\s+up|distill)\s+(?:all\s+of\s+)?(?:them|those|these)\b[^.!?\n]{0,160}\b(?:into|as|to)\s+(?:one|a|an|single)\s+[a-z][\w-]*|(?:create|build|draft|write|produce|generate|compile|assemble|make)\s+(?:one|a|an|single)\s+[a-z][\w-]*[^.!?\n]{0,120}\b(?:from|using|with)\s+(?:them|those|these)\b)/i;
const TRAILING_EACH_OUTPUT_RE =
  /\b(?:one|a|an|single)\s+(?:[a-z][\w-]*\s+){0,3}[a-z][\w-]*\s+each\b/i;
const STRUCTURAL_PER_ITEM_WORK_RE =
  /\b(?:for\s+each|each\s+(?:one|of\s+(?:them|these|those))|every\s+one\s+of|one\s+per|per[- ]item)\b/i;
const PRIOR_BATCH_PROPOSAL_RE =
  /\b(?:want me to|should i|shall i|would you like me to|do you want me to|ready for me to|may i|can i)\b/i;
const DURABLE_BACKGROUND_ENVELOPE_RE =
  /^(?:You are running a durable Clementine background task\.|Continue background task\b|The user answered your question:)/i;
const ORIGINAL_REQUEST_MARKER_RE = /(?:^|\n)[ \t]*Original request:[ \t]*\r?\n/gi;

/**
 * Background workers receive a model-visible machine envelope containing
 * bounded origin history and, at the end, one authoritative Original request
 * block. The origin history can contain the same numbered user list, so
 * structural detection over the whole envelope doubles one five-item universe
 * into ten. Keep the rich envelope for the model, but classify fan-out against
 * its canonical task objective exactly once.
 *
 * The prefix check is intentionally narrow: ordinary user prompts with two
 * genuinely distinct numbered lists retain both universes.
 */
function canonicalMultiItemObjective(input: string): string {
  if (!DURABLE_BACKGROUND_ENVELOPE_RE.test(input)) return input;
  const markers = [...input.matchAll(new RegExp(
    ORIGINAL_REQUEST_MARKER_RE.source,
    ORIGINAL_REQUEST_MARKER_RE.flags,
  ))];
  const marker = markers.at(-1);
  if (marker?.index === undefined) return input;
  const objective = input.slice(marker.index + marker[0].length).trim();
  return objective || input;
}

/** Boundaries such as "do not write memory" are not positive work signals. */
export function positiveActionSignalText(text: string): string {
  return text
    .replace(/\b(?:do\s+not|don'?t|never|without)\b[^.!?\n]*/gi, ' ')
    .replace(/\bno\s+(?:emails?|external\s+(?:connector|connectors|tool|tools|mcp|service|services)|writes?|changes?)\b/gi, ' ');
}

/**
 * `isMultiItem` is true only when the user's words name N>=3 independent,
 * same-shape items that warrant per-item tool work. Ambiguity resolves false.
 */
export interface MultiItemIntent {
  isMultiItem: boolean;
  itemCount: number;
  itemKind: string | null;
  sameShapeWork: boolean;
  explicitParallelRequest: boolean;
  carriedFromPrior?: boolean;
}

const NO_MULTI_ITEM: MultiItemIntent = Object.freeze({
  isMultiItem: false,
  itemCount: 0,
  itemKind: null,
  sameShapeWork: false,
  explicitParallelRequest: false,
});

function singularItemKinds(kind: string | null): string[] {
  if (!kind) return [];
  const irregular: Record<string, string> = {
    children: 'child',
    men: 'man',
    people: 'person',
    women: 'woman',
  };
  if (irregular[kind]) return [irregular[kind]];
  const candidates = new Set<string>([kind]);
  if (kind.endsWith('ies') && kind.length > 3) candidates.add(`${kind.slice(0, -3)}y`);
  // English "-es" is ambiguous without a dictionary: boxes → box, while
  // cases → case. Test both safe stems instead of committing to one.
  if (kind.endsWith('es') && kind.length > 2) candidates.add(kind.slice(0, -2));
  if (kind.endsWith('s') && kind.length > 1) candidates.add(kind.slice(0, -1));
  return [...candidates];
}

function explicitPerTargetForKind(text: string, kind: string | null): boolean {
  return singularItemKinds(kind).some((singular) => {
    const escaped = singular.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\bper[-\\s]+(?:each\\s+)?${escaped}(?:s)?\\b`, 'i').test(text);
  });
}

function referencesCountedKind(text: string, kind: string | null): boolean {
  if (!kind) return false;
  const escaped = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:the|these|those|each|every)?\\s*${escaped}\\b`, 'i').test(text);
}

export function detectMultiItemIntent(input: string): MultiItemIntent {
  try {
    const rawText = (typeof input === 'string' ? input : '').trim();
    const text = canonicalMultiItemObjective(rawText);
    if (text.length < 4) return NO_MULTI_ITEM;
    const actionText = positiveActionSignalText(text);

    const listMatches = [...text.matchAll(new RegExp(LIST_ITEM_RE.source, LIST_ITEM_RE.flags))];
    const listedBodies = listMatches.map((match) =>
      (match[1] ?? match[0].replace(/^[ \t]*(?:\d+[.)]|[-*•–])\s+/, '')).trim(),
    );
    const listPreamble = listMatches[0]?.index === undefined
      ? text
      : text.slice(0, listMatches[0].index);
    // Once the user commits to one artifact, the following bullets describe
    // that artifact unless the preamble explicitly says they are per-target
    // jobs. This is a semantic parent/children boundary, not a verb allowlist.
    const singleParentRequirements = listedBodies.length >= 3
      && (SINGLE_PARENT_RE.test(listPreamble) || LIST_SINGLE_CONTAINER_RE.test(listPreamble))
      && !EXPLICIT_LIST_TARGET_RE.test(listPreamble);
    const enumerated = listedBodies.length >= 3 && !singleParentRequirements;
    let count = 0;
    let kind: string | null = null;
    let countIndex = -1;
    let countEndIndex = -1;
    if (enumerated) {
      count = listedBodies.length;
    } else {
      const globalCountRe = new RegExp(COUNT_PLURAL_RE.source, 'gi');
      const markedPrefixRe = /\b(?:these|those|each of|all(?: of)?(?: the)?|the following)\s*$/i;
      let firstValid: { n: number; noun: string; index: number; end: number } | null = null;
      let lastMarked: { n: number; noun: string; index: number; end: number } | null = null;
      const markedCountRe = new RegExp(MARKED_COUNT_PLURAL_RE.source, 'gi');
      let markedMatch: RegExpExecArray | null;
      while ((markedMatch = markedCountRe.exec(text)) !== null) {
        const itemCount = Number.parseInt(markedMatch[1].replace(/,/g, ''), 10);
        const noun = markedMatch[2].toLowerCase();
        if (
          !Number.isSafeInteger(itemCount)
          || itemCount < 3
          || NON_ITEM_NOUNS.has(noun)
        ) continue;
        const countOffset = markedMatch[0].indexOf(markedMatch[1]);
        lastMarked = {
          n: itemCount,
          noun,
          index: markedMatch.index + Math.max(0, countOffset),
          end: markedMatch.index + markedMatch[0].length,
        };
      }
      let match: RegExpExecArray | null;
      while ((match = globalCountRe.exec(text)) !== null) {
        const itemCount = Number.parseInt(match[1].replace(/,/g, ''), 10);
        const noun = match[2].toLowerCase();
        if (
          !Number.isFinite(itemCount)
          || itemCount < 3
          || !Number.isSafeInteger(itemCount)
          || NON_ITEM_NOUNS.has(noun)
        ) continue;
        const priorChar = match.index > 0 ? text[match.index - 1] : '';
        if (/[-./:#]/.test(priorChar)) continue;
        const modifiers = match[0]
          .trim()
          .split(/\s+/)
          .slice(1, -1)
          .map((word) => word.toLowerCase());
        if (modifiers.some((word) => COUNT_CONNECTOR_WORDS.has(word))) continue;
        if (!firstValid) {
          firstValid = {
            n: itemCount,
            noun,
            index: match.index,
            end: match.index + match[0].length,
          };
        }
        if (
          markedPrefixRe.test(text.slice(Math.max(0, match.index - 16), match.index))
          && (!lastMarked || match.index >= lastMarked.index)
        ) {
          lastMarked = {
            n: itemCount,
            noun,
            index: match.index,
            end: match.index + match[0].length,
          };
        }
      }
      const picked = lastMarked ?? firstValid;
      if (picked) {
        count = picked.n;
        kind = picked.noun;
        countIndex = picked.index;
        countEndIndex = picked.end;
      }
    }
    if (count < 3) return NO_MULTI_ITEM;
    const explicitPerTarget = EXPLICIT_LIST_TARGET_RE.test(text)
      || explicitPerTargetForKind(text, kind)
      || TRAILING_EACH_OUTPUT_RE.test(text);
    if (
      (SOURCE_TO_SINGLE_OUTPUT_RE.test(text) || COUNTED_PARTS_SINGLE_CONTAINER_RE.test(text))
      && !explicitPerTarget
    ) {
      return NO_MULTI_ITEM;
    }
    const singleParent = SINGLE_PARENT_RE.exec(text);
    const parentToCount = singleParent && countIndex > singleParent.index
      ? text.slice(singleParent.index + singleParent[0].length, countIndex)
      : '';
    const afterCount = countEndIndex > 0 ? text.slice(countEndIndex) : '';
    const laterIndependentAction = (
      /\b(?:then|next|after(?:ward|wards)?|after\s+that)\b/i.test(parentToCount)
      && DEEP_WORK_RE.test(parentToCount)
    ) || (
      countEndIndex > 0
      && DEEP_WORK_RE.test(afterCount)
      && /\b(?:each|them|all|every|these|those)\b/i.test(afterCount)
    ) || (
      countEndIndex > 0
      && SEQUENCE_RE.test(afterCount)
      && DEEP_WORK_RE.test(afterCount)
      && referencesCountedKind(afterCount, kind)
    );
    if (
      singleParent
      && !explicitPerTarget
      && (
        singleParentRequirements
        || countIndex < singleParent.index
        || (
          !laterIndependentAction
          && SINGLE_PARENT_SOURCE_RE.test(text.slice(Math.max(0, countIndex - 48), countIndex))
        )
      )
    ) {
      return NO_MULTI_ITEM;
    }

    const explicitParallelRequest = EXPLICIT_PARALLEL_RE.test(actionText);
    const sameShapeWork = READ_RE.test(actionText)
      || WRITE_RE.test(actionText)
      || DEEP_WORK_RE.test(actionText)
      || explicitParallelRequest
      || explicitPerTarget
      // Do not make arbitrary user verbs wait for a harness vocabulary update.
      // An exact count plus explicit per-item grammar already supplies the
      // structural fact the worker boundary needs.
      || STRUCTURAL_PER_ITEM_WORK_RE.test(actionText);
    if (!sameShapeWork) return NO_MULTI_ITEM;
    if (
      kind
      && COLLECTION_ITEM_NOUNS.has(kind)
      && !(
        (DISTINCT_MARKER_RE.test(text) && DEEP_WORK_RE.test(actionText))
        || explicitParallelRequest
        || explicitPerTarget
        || STRUCTURAL_PER_ITEM_WORK_RE.test(actionText)
      )
    ) {
      return NO_MULTI_ITEM;
    }
    if (AGGREGATE_RETRIEVAL_RE.test(actionText) && !DEEP_WORK_RE.test(actionText)) {
      return NO_MULTI_ITEM;
    }
    if (INTERNAL_OWNER_RE.test(text)) return NO_MULTI_ITEM;
    const hasDistinct = enumerated || DISTINCT_MARKER_RE.test(text);
    if (SEQUENCE_RE.test(text) && !hasDistinct) return NO_MULTI_ITEM;

    return {
      isMultiItem: true,
      itemCount: count,
      itemKind: kind,
      sameShapeWork: true,
      explicitParallelRequest,
    };
  } catch {
    return NO_MULTI_ITEM;
  }
}

const SHORT_CONTINUATION_RE =
  /^(?:yes|yea|yeah|yep|sure|ok(?:ay)?|go ahead|do it|do that|proceed|let'?s do it|start|run it|run them)(?:\s+please)?[.!]*$/i;
const ANAPHORIC_CONTINUATION_RE =
  /\b(?:them|those|these|all of (?:them|those|these)|each of them|each one)\b/i;

export function detectMultiItemIntentFromConversation(
  input: string,
  recentConversationTexts: readonly string[] | undefined,
  _maxPriorTexts = 1,
): MultiItemIntent {
  const direct = detectMultiItemIntent(input);
  if (direct.isMultiItem) return direct;
  try {
    const text = (typeof input === 'string' ? input : '').trim();
    if (
      !text
      || (!SHORT_CONTINUATION_RE.test(text) && !ANAPHORIC_CONTINUATION_RE.test(text))
    ) return direct;
    if (SINGLE_PARENT_RE.test(text) && !EXPLICIT_LIST_TARGET_RE.test(text)) {
      return direct;
    }
    // Carry only the immediately preceding assistant proposal supplied by the
    // caller. Scanning arbitrary older user/assistant text made polite new work
    // ("Please rewrite this headline") inherit a stale batch contract.
    const prior = recentConversationTexts?.[0];
    if (!prior) return direct;
    const proposalCue = PRIOR_BATCH_PROPOSAL_RE.exec(prior);
    if (!proposalCue) return direct;
    // A report-back may mention the completed 12-item batch and then propose
    // one synthesis artifact. Detect only the proposal clause, never the stale
    // completion prefix.
    const proposal = prior.slice(proposalCue.index);
    const carried = detectMultiItemIntent(proposal);
    if (carried.isMultiItem) return { ...carried, carriedFromPrior: true };
    if (ANAPHORIC_CONTINUATION_RE.test(proposal)) {
      if (ANAPHORIC_SINGLE_OUTPUT_PROPOSAL_RE.test(proposal)) return direct;
      const anaphoricCarry = detectMultiItemIntent(prior);
      if (anaphoricCarry.isMultiItem) {
        return { ...anaphoricCarry, carriedFromPrior: true };
      }
    }
  } catch {
    // Fail open to the direct result.
  }
  return direct;
}
