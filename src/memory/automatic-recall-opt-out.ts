/**
 * Request-local boundary for the optional query-driven memory primer.
 *
 * This intentionally does not cover memory writes. "Do not save this as
 * memory" is a capture boundary, not permission to make the current turn
 * forget useful context. It also does not alter the always-present policy and
 * identity context; pinned safety rules remain available/enforced elsewhere.
 */
export const EXPLICIT_MEMORY_RECALL_OPTOUT_REASON = 'explicit_request_opt_out' as const;

const MEMORY_NOUN = String.raw`(?:(?:all|any|the|your|my|our|clementine(?:'s)?|assistant(?:'s)?|saved|stored|prior|previous|durable|persistent|long[- ]term|working|conversation(?:al)?)\s+){0,4}memor(?:y|ies)(?:\s+(?:store|system|context))?`;
const RECALL_VERB = String.raw`(?:use|consult|search|check|read|access|recall|retrieve|load|query|look\s+(?:in|at|through)|rely\s+on|draw\s+on)`;
const NEGATION = String.raw`(?:do\s+not|don't|never)`;

const DIRECT_NEGATED_RECALL_RE = new RegExp(
  String.raw`\b${NEGATION}\s+(?:(?:please|ever|automatically|again|at\s+all|for\s+this\s+(?:request|turn|task)|on\s+this\s+turn|under\s+any\s+circumstances)\s*,?\s*){0,3}${RECALL_VERB}\b[^.!?;\n\u2014]{0,140}?\b${MEMORY_NOUN}\b`,
  'i',
);
const WITHOUT_RECALL_RE = new RegExp(
  String.raw`\bwithout\s+(?:(?:ever|automatically|also|any)\s+){0,3}(?:${RECALL_VERB}|using)\b[^.!?;\n\u2014]{0,100}?\b${MEMORY_NOUN}\b`,
  'i',
);
const WITHOUT_MEMORY_RE = new RegExp(
  String.raw`\bwithout\s+(?:using\s+)?${MEMORY_NOUN}\b`,
  'i',
);
const NO_MEMORY_SCOPE_RE = new RegExp(
  String.raw`(?:\bno[- ]memory\s+mode\b|\bno\s+${MEMORY_NOUN}\s+for\s+(?:this|the)\s+(?:request|turn|task|answer)\b|\b(?:answer|respond|proceed|continue|work)\b[^.!?;\n\u2014]{0,60}\bwith\s+no\s+${MEMORY_NOUN}\b)`,
  'i',
);
const IGNORE_MEMORY_RE = new RegExp(
  String.raw`\b(?:ignore|disregard|bypass)\s+${MEMORY_NOUN}\b`,
  'ig',
);
const COORDINATED_MEMORY_LIST_RE = new RegExp(
  String.raw`\b${NEGATION}\b(?<body>[^.!?;\n\u2014]{0,180}\b(?:or|nor)\s+${MEMORY_NOUN}\b)`,
  'i',
);
const NEGATED_COORDINATED_RECALL_VERB_RE = new RegExp(
  String.raw`\b${NEGATION}\b[^.!?;\n\u2014]{0,100}\b(?:or|nor)\s+${RECALL_VERB}\b[^.!?;\n\u2014]{0,80}\b${MEMORY_NOUN}\b`,
  'i',
);

// These are about wording or process RAM, not Clementine's durable recall.
const MEMORY_LITERAL_RE = /\b(?:use|using)\s+(?:the\s+)?(?:words?|terms?|phrases?|labels?|names?)\b[^.!?;\n\u2014]{0,80}\bmemor(?:y|ies)\b/i;
const COMPUTE_MEMORY_RE = /\b(?:(?:too\s+)?much|more|less|extra|additional|system|heap|ram|gpu|virtual|physical|shared|process)\s+memory\b|\bmemory[- ](?:heavy|intensive|efficient|safe)|\bmemory\s+(?:usage|footprint|limit|limits|pressure|allocation|leak|leaks)\b/i;
const POSITIVE_CONTRAST_RE = /\b(?:but|instead)\s*,?\s*(?:please\s+)?(?:use|consult|search|check|read|access|recall|retrieve|load|query|look\s+(?:in|at|through)|rely\s+on|draw\s+on)\b[^.!?;\n\u2014]{0,100}\bmemor(?:y|ies)\b/i;
const HEDGED_NEGATION_RE = /\b(?:maybe|perhaps|possibly|probably)\s+(?:please\s+)?(?:do\s+not|don't|never)\b/i;
const CAPTURE_ONLY_RE = /\b(?:do\s+not|don't|never)\s+(?:(?:please|ever|automatically)\s+){0,3}(?:save|store|remember|capture|persist|write|change|modify|update)\b[^.!?;\n\u2014]{0,120}\bmemor(?:y|ies)\b/i;
const COORDINATED_RECALL_SIGNAL_RE = /\b(?:use|consult|search|check|read|access|recall|retrieve|load|query|discover|browse|look|rely|draw)\b/i;
const COORDINATED_CAPABILITY_RE = /\b(?:code\s+mode|shell|workspace|browser|web|discovery|discover|tools?|connector|composio)\b/i;
const IGNORE_COMPUTE_SUFFIX_RE = /^\s+(?:warning|warnings|error|errors|limit|limits|usage|pressure|leak|leaks|allocation|footprint)\b/i;

function normalizedRequest(input: string | null | undefined): string {
  return (input ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function directNegatedRecall(text: string): boolean {
  const match = DIRECT_NEGATED_RECALL_RE.exec(text);
  if (!match) return false;
  // Include a small suffix: computational forms such as `memory-safe` and
  // literal-use qualifiers can begin immediately after the noun matched by the
  // recall grammar.
  const phrase = text.slice(match.index, Math.min(text.length, match.index + match[0].length + 40));
  if (MEMORY_LITERAL_RE.test(phrase) || COMPUTE_MEMORY_RE.test(phrase)) return false;
  if (POSITIVE_CONTRAST_RE.test(phrase)) return false;
  return true;
}

function explicitIgnoreMemory(text: string): boolean {
  IGNORE_MEMORY_RE.lastIndex = 0;
  for (const match of text.matchAll(IGNORE_MEMORY_RE)) {
    const start = match.index ?? 0;
    const prefix = text.slice(Math.max(0, start - 32), start);
    if (/\b(?:do\s+not|don't|never)\s*$/i.test(prefix)) continue;
    if (IGNORE_COMPUTE_SUFFIX_RE.test(text.slice(start + match[0].length))) continue;
    return true;
  }
  return false;
}

/**
 * True only when the current request explicitly tells Clementine not to
 * consult/use memory. Ambiguous mentions and capture-only boundaries fail open
 * to ordinary recall.
 */
export function explicitlyOptsOutOfAutomaticMemoryRecall(input: string | null | undefined): boolean {
  const text = normalizedRequest(input);
  if (!text) return false;

  // Evaluate sentence-sized clauses independently. A hedged "maybe don't use
  // memory" should remain conversationally ambiguous, but it must not cancel a
  // later unambiguous "Do not use memory for this request."
  const clauses = text.split(/[.!?;\u2014]+/).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (HEDGED_NEGATION_RE.test(clause)) continue;

    if (directNegatedRecall(clause)) return true;

    if (WITHOUT_RECALL_RE.test(clause) || WITHOUT_MEMORY_RE.test(clause) || NO_MEMORY_SCOPE_RE.test(clause)) {
      if (!COMPUTE_MEMORY_RE.test(clause)) return true;
    }

    if (explicitIgnoreMemory(clause)) return true;

    // Coordinated boundaries can carry one negation across a list, for example:
    // "Do not discover, use code mode, shell, workspace, or memory." Keep this
    // narrower than the direct form: an `or memory` tail plus both an operation
    // and another concrete capability are required.
    const coordinated = COORDINATED_MEMORY_LIST_RE.exec(clause);
    if (coordinated?.groups?.body
        && COORDINATED_RECALL_SIGNAL_RE.test(coordinated.groups.body)
        && COORDINATED_CAPABILITY_RE.test(coordinated.groups.body)
        && !MEMORY_LITERAL_RE.test(coordinated.groups.body)
        && !COMPUTE_MEMORY_RE.test(coordinated.groups.body)
        && !POSITIVE_CONTRAST_RE.test(coordinated.groups.body)) {
      return true;
    }

    if (NEGATED_COORDINATED_RECALL_VERB_RE.test(clause)
        && !MEMORY_LITERAL_RE.test(clause)
        && !COMPUTE_MEMORY_RE.test(clause)
        && !POSITIVE_CONTRAST_RE.test(clause)) {
      return true;
    }

    // Capture-only language is deliberately not treated as a recall boundary.
    // This branch is documentary as well as defensive for future regexes.
    if (CAPTURE_ONLY_RE.test(clause)) continue;
  }
  return false;
}
