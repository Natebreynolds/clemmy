/**
 * Lightweight message-intent classifier.
 *
 * The chat path used to call `isCasualCheckIn` to suppress memory and
 * vault context on greetings. That worked but only caught five
 * phrases. Everything else got the full firehose — vault search,
 * working memory, session brief, 70 tools — even when the message was
 * "what time is it" or "thanks."
 *
 * This module classifies the user's message into one of five intent
 * classes via regex + heuristics. No LLM call, no async, no
 * dependencies on the rest of the system. The result drives:
 *   - which memory subsystems get loaded (Gap 5)
 *   - which instructions/handoff guidance is foregrounded (Gap 1)
 *   - whether `analyzeExecutionIntent` even runs
 *
 * The classifier is intentionally conservative: when in doubt, it
 * falls back to `tool_intent` (the default behavior) rather than
 * suppress context the agent might need.
 */

export type MessageIntent =
  | 'casual'        // greetings, thanks, social check-ins
  | 'lookup'        // "what is X", "show me Y", "how did we do Z"
  | 'action'        // "build X", "deploy Y", "set up Z", multi-step work
  | 'meta_clarify'  // questions about the agent itself / how to use it
  | 'tool_intent';  // default — needs tools, but not necessarily multi-step

export interface IntentClassification {
  intent: MessageIntent;
  confidence: number; // 0..1
  reasons: string[];
}

const CASUAL_PATTERNS: RegExp[] = [
  /^(hey|hi|hello|yo|sup|howdy)\b/i,
  /^good\s+(morning|afternoon|evening|night)\b/i,
  /^(thanks|thank you|ty|cheers|appreciate it|nice)\b/i,
  /^(ok|okay|cool|got it|sounds good|nice|sweet|perfect)\b/i,
  /^(lol|haha|lmao|nice|awesome|amazing)\b/i,
  /^(bye|gn|goodnight|see ya|talk later|later)\b/i,
  /^(what'?s up|how'?s it going|how are you|you there|wyd)\b/i,
];

const META_PATTERNS: RegExp[] = [
  /^(what can you do|what are your|how do you work|who are you|tell me about yourself)\b/i,
  /\b(your (capabilities|tools|skills|memory|settings))\b/i,
  /^(help|how do i)\b/i,
  /\bhow does this work\b/i,
];

const LOOKUP_CUES = [
  'what is', 'what was', 'what are', 'what were',
  'show me', 'show my', 'show all',
  'list', 'find', 'search for', 'look up', 'look for',
  'how did', 'how was', 'when did', 'when was', 'where did', 'where is',
  'who is', 'who was', 'do i have', 'have i',
  'remind me', 'tell me about', 'recall',
  'status of', 'progress on',
];

/**
 * Lookup cues that, when they appear at the START of the message,
 * dominate over later action verbs. "when did we ship X" is a lookup
 * (the user wants to know history), not an action — even though
 * "ship" is an action verb.
 */
const QUESTION_STARTERS = [
  'what', 'when', 'where', 'who', 'why', 'how',
  'show', 'list', 'find', 'do i', 'have i', 'is there', 'are there',
  'remind me', 'tell me', 'recall',
];

const ACTION_CUES = [
  'build', 'create', 'make', 'set up', 'setup', 'wire up', 'wire',
  'implement', 'design', 'migrate', 'refactor', 'rewrite',
  'connect', 'integrate', 'deploy', 'install', 'configure',
  'launch', 'ship', 'release', 'publish',
  'fix', 'resolve', 'patch', 'debug',
  'finish', 'complete', 'continue', 'keep going', 'pick up', 'pick this up', 'resume',
  'improve', 'enhance', 'optimize',
  'send', 'email', 'message', 'notify', 'post', 'dm',
  'delete', 'remove', 'archive', 'clean up',
  "let's", 'lets do', 'go ahead', 'do it',
];

const MULTI_PART_CUES = [
  ' and ', ' then ', ' after that', ' once you', ' while ',
  'everything', 'all the', 'whole thing', 'entire',
  'end to end', 'from start to finish',
];

function matchCount(text: string, cues: string[]): { count: number; matched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const cue of cues) {
    if (lower.includes(cue)) matched.push(cue);
  }
  return { count: matched.length, matched };
}

function isShort(text: string): boolean {
  return text.trim().length <= 40;
}

export function classifyMessageIntent(message: string): IntentClassification {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: 'casual', confidence: 0.9, reasons: ['empty message'] };
  }

  // CASUAL — anchored at start, must be a short message to avoid false
  // positives like "thanks for considering building this huge system".
  for (const pat of CASUAL_PATTERNS) {
    if (pat.test(trimmed) && isShort(trimmed)) {
      return { intent: 'casual', confidence: 0.9, reasons: ['matches casual greeting/acknowledgement pattern'] };
    }
  }

  // META — questions about the agent itself.
  for (const pat of META_PATTERNS) {
    if (pat.test(trimmed)) {
      return { intent: 'meta_clarify', confidence: 0.8, reasons: ['asks about agent capabilities or usage'] };
    }
  }

  const lookup = matchCount(trimmed, LOOKUP_CUES);
  const action = matchCount(trimmed, ACTION_CUES);
  const multi = matchCount(trimmed, MULTI_PART_CUES);
  const reasons: string[] = [];

  // Question-shaped messages are lookups even when they happen to
  // contain action verbs ("when did we ship X" mentions 'ship' but is
  // asking a question, not requesting work).
  const lower = trimmed.toLowerCase();
  const questionStart = QUESTION_STARTERS.some((q) => lower.startsWith(q));
  if (questionStart && lookup.count > 0) {
    return {
      intent: 'lookup',
      confidence: 0.7 + Math.min(0.2, lookup.count * 0.05),
      reasons: ['question-shaped opening + lookup cues present', `lookup cues: ${lookup.matched.slice(0, 3).join(', ')}`],
    };
  }

  // ACTION — strong signal beats lookup. Multi-part cues also count.
  if (action.count > 0 && action.count >= lookup.count) {
    let confidence = 0.55 + Math.min(0.35, action.count * 0.1);
    if (multi.count > 0) {
      confidence = Math.min(0.95, confidence + 0.1);
      reasons.push(`multi-part signal: ${multi.matched.slice(0, 2).join(', ')}`);
    }
    reasons.push(`action verbs present: ${action.matched.slice(0, 3).join(', ')}`);
    return { intent: 'action', confidence, reasons };
  }

  // LOOKUP — read-only intent.
  if (lookup.count > 0) {
    const confidence = 0.55 + Math.min(0.3, lookup.count * 0.1);
    reasons.push(`lookup verbs present: ${lookup.matched.slice(0, 3).join(', ')}`);
    return { intent: 'lookup', confidence, reasons };
  }

  // Fallback — needs tools probably, but not classified.
  return { intent: 'tool_intent', confidence: 0.45, reasons: ['no clear intent signal — default behavior'] };
}

/**
 * Back-compat shim. Existing callers use `isCasualCheckIn` as a quick
 * "skip the heavy context loading" check. Keeps the behavior identical
 * but routes through the classifier so we have a single source of
 * truth for what counts as casual.
 */
export function isCasualCheckIn(message: string): boolean {
  return classifyMessageIntent(message).intent === 'casual';
}

/**
 * Memory budget profile per intent class. Drives which subsystems
 * `context.ts` should load and how deep the vault search goes. Lower
 * numbers mean lighter context.
 */
export interface MemoryBudget {
  loadWorkingMemory: boolean;
  loadSessionBrief: boolean;
  vaultSearchTopK: number;       // 0 disables vault search entirely
  vaultFormatBytes: number;      // formatSearchHits maxBytes
}

export function memoryBudgetFor(
  intent: MessageIntent,
  ctx?: { hasActiveTaskSpec?: boolean },
): MemoryBudget {
  // A binding task spec exists for this session — never drop working memory on
  // a bare acknowledgement / approval turn ("ok", "perfect"), or the model acts
  // blind to the list it was just told to use. Load working memory only; vault
  // search + session brief stay off so this is NOT the firehose. Gated on
  // spec-existence so the common casual/meta turn stays byte-identical.
  if (ctx?.hasActiveTaskSpec && (intent === 'casual' || intent === 'meta_clarify')) {
    return { loadWorkingMemory: true, loadSessionBrief: false, vaultSearchTopK: 0, vaultFormatBytes: 0 };
  }
  switch (intent) {
    case 'casual':
      return { loadWorkingMemory: false, loadSessionBrief: false, vaultSearchTopK: 0, vaultFormatBytes: 0 };
    case 'meta_clarify':
      // Agent-self questions don't need vault recall; instructions
      // already describe capabilities.
      return { loadWorkingMemory: false, loadSessionBrief: true, vaultSearchTopK: 0, vaultFormatBytes: 0 };
    case 'lookup':
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 6, vaultFormatBytes: 2400 };
    case 'action':
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 6, vaultFormatBytes: 2400 };
    case 'tool_intent':
    default:
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 4, vaultFormatBytes: 1800 };
  }
}
