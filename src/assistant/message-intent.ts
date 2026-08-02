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

import { classifyExternalEffectRequest } from './external-effect-taxonomy.js';

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
  /^help[.!?]*$/i,
  /^how do i\s+(?:use|work with|talk to|configure)\s+(?:you|clementine|this (?:agent|assistant))\b/i,
  /\bhow does this work\b/i,
];

const LOOKUP_CUES = [
  'what is', 'what was', 'what are', 'what were',
  'what did', 'what does', 'what do you recommend',
  'show me', 'show my', 'show all',
  'list', 'find', 'search for', 'look up', 'look for',
  'how did', 'how was', 'when did', 'when was', 'where did', 'where is',
  'who is', 'who was', 'do i have', 'have i',
  'remind me', 'tell me about', 'recall',
  'status of', 'progress on',
  'did i', 'did we', 'did you',
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
  'should i', 'can i', 'could i', 'would i', 'may i',
  'did i', 'did we', 'did you', 'has the', 'has my', 'has our',
  'remind me', 'tell me', 'recall',
];

/** Shared mutation vocabulary for intent routing and completion evidence. */
export const MUTATION_ACTION_CUES = [
  'accept', 'add', 'append', 'approve', 'archive', 'assign', 'block', 'book',
  'bookmark', 'build', 'call', 'cancel', 'change', 'charge', 'close', 'comment',
  'configure', 'copy', 'create', 'delete', 'deploy', 'draft', 'edit', 'email',
  'execute', 'follow', 'forward', 'generate', 'insert', 'install', 'invite',
  'label', 'launch', 'link', 'log', 'make', 'mark complete', 'merge', 'mark',
  'message', 'modify', 'move', 'mute', 'open', 'pay', 'pin', 'post', 'publish',
  'push', 'put', 'react', 'record', 'refund', 'reject', 'remove', 'rename',
  'reopen', 'replace', 'reply', 'reschedule', 'restore', 'run', 'save', 'schedule',
  'send', 'set', 'set up', 'setup', 'share', 'star', 'submit', 'subscribe', 'tag',
  'unarchive', 'unblock', 'unfollow', 'unlink', 'unmute', 'unsubscribe', 'update',
  'upload', 'write',
] as const;

const AMBIGUOUS_ACTION_NOUNS = new Set([
  'block',
  'book',
  'bookmark',
  'call',
  'charge',
  'draft',
  'email',
  'label',
  'link',
  'log',
  'mark',
  'message',
  'post',
  'record',
  'schedule',
  'tag',
]);

const ACTION_CUES = [
  ...MUTATION_ACTION_CUES.filter((cue) => !AMBIGUOUS_ACTION_NOUNS.has(cue)),
  'produce',
  'prepare', 'redesign', 'author', 'assemble', 'automate', 'monitor',
  'wire up', 'wire',
  'implement', 'design', 'migrate', 'refactor', 'rewrite',
  'connect', 'integrate', 'ship', 'release',
  'fix', 'resolve', 'patch', 'debug',
  'finish', 'complete', 'continue', 'get back to', 'keep going', 'pick up', 'pick this up', 'resume',
  'improve', 'enhance', 'optimize',
  'notify', 'dm', 'clean up',
  "let's", 'lets do', 'go ahead', 'do it',
];

const READ_ONLY_OPERATION_START_RE =
  /^(?:read|review|summarize|search|research|find|list|inspect|analyze|check|look\s+up)\b/i;
const ADVISORY_ACTION_START_RE =
  /^(?:(?:should|can|could|would|may)\s+(?:i|we)\b|(?:would|could|can)\s+you\s+(?:recommend|advise|explain)\b|i\s+(?:might|may|could|would)\b|i\s+(?:am\s+)?wonder(?:ing)?\s+(?:whether|if|how)\b|do\s+you\s+(?:think|recommend|believe)\b|is\s+it\s+(?:safe|wise|okay|ok|a\s+good\s+idea)\s+to\b|how\s+(?:to\b|(?:do|can|could|would|should)\s+(?:i|we|you)\b)|what\s+(?:(?:happens|would\s+happen)\s+if|(?:should|can|could|would|might|may)\s+(?:i|we|you)|do\s+you\s+(?:recommend|think|suggest))\b|(?:tell|show)\s+me\s+(?:whether|if|how)\b|(?:give\s+me|i\s+need)\s+(?:advice|guidance|recommendations?)\b|walk\s+me\s+through\s+(?:whether|if|how)\b|help\s+me\s+(?:decide|understand|choose|evaluate)\b|(?:discuss|explain|research|describe|compare|evaluate|assess|advise)\b)/i;
const POLITE_ADVISORY_ACTION_START_RE =
  /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+)(?:(?:tell|show)\s+me\s+(?:whether|if|how)\b|walk\s+me\s+through\s+(?:whether|if|how)\b|help\s+me\s+(?:decide|understand|choose|evaluate)\b|give\s+me\s+(?:advice|guidance|recommendations?)\b|(?:explain|research|describe|compare|evaluate|assess|advise|recommend)\b)/i;
const DIRECT_AMBIGUOUS_ACTION_RE =
  /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|(?:i(?:'d| would)\s+like|i\s+want)\s+(?:you|clementine)\s+to\s+|(?:go\s+ahead\s+and|make\s+sure\s+to|let'?s)\s+)*(?:block|book|bookmark|call|charge|draft|email|label|link|log|mark|message|post|record|schedule|tag)\b/i;
const NEGATED_ACTION_ONLY_START_RE =
  /^(?:no[,.]?\s+)?(?:please\s+)?(?:do\s+not|don't|dont|never)\b/i;
const NON_REQUEST_ACTION_MENTION_START_RE =
  /^(?:the\s+(?:idea|plan|proposal|strategy)\s+is\s+to\b|we(?:'re|\s+are)\s+(?:considering|discussing|thinking\s+about)\b)/i;

const MULTI_PART_CUES = [
  ' and ', ' then ', ' after that', ' once you', ' while ',
  'everything', 'all the', 'whole thing', 'entire',
  'end to end', 'from start to finish',
];

const CUE_PATTERN_CACHE = new Map<string, RegExp>();

function escapedCue(cue: string): string {
  return cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

function cuePattern(cue: string): RegExp {
  const cached = CUE_PATTERN_CACHE.get(cue);
  if (cached) return cached;
  const pattern = new RegExp(`(?:^|[^a-z0-9_])${escapedCue(cue)}(?=$|[^a-z0-9_])`, 'i');
  CUE_PATTERN_CACHE.set(cue, pattern);
  return pattern;
}

const ACTION_CONTINUATION_CUE_SOURCE = [...ACTION_CUES, ...AMBIGUOUS_ACTION_NOUNS]
  .map(escapedCue)
  .join('|');
const ACKNOWLEDGEMENT_PREFIX_RE =
  /^(?:ok|okay|cool|got it|sounds good|thanks|thank you|cheers|nice|sweet|perfect|awesome|amazing)\b[\s,;:.!?—–-]+/i;
const DIRECT_ACTION_AFTER_ACK_RE = new RegExp(
  `^(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+|(?:go\\s+ahead\\s+and|make\\s+sure\\s+to|let'?s)\\s+)*(?:${ACTION_CONTINUATION_CUE_SOURCE})\\b`,
  'i',
);

function actionContinuationPattern(includePlainAnd: boolean): RegExp {
  const transition = includePlainAnd
    ? '(?:and\\s+then|then|but|and)'
    : '(?:and\\s+then|then|but)';
  return new RegExp(
    `(?:(?:[,;:.!?\\n]|[—–])\\s*(?:please\\s+)?(?:${ACTION_CONTINUATION_CUE_SOURCE})\\b|(?:[,;:.!?\\n]|[—–]|\\b)\\s*${transition}\\s+(?:please\\s+)?(?:${ACTION_CONTINUATION_CUE_SOURCE})\\b)`,
    'i',
  );
}

const ACTION_CONTINUATION_RE = actionContinuationPattern(false);
const ACTION_CONTINUATION_WITH_AND_RE = actionContinuationPattern(true);

function matchCount(text: string, cues: readonly string[]): { count: number; matched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const cue of cues) {
    if (cuePattern(cue).test(lower)) matched.push(cue);
  }
  return { count: matched.length, matched };
}

function hasExplicitActionContinuation(text: string, includePlainAnd: boolean): boolean {
  return (
    includePlainAnd
      ? ACTION_CONTINUATION_WITH_AND_RE
      : ACTION_CONTINUATION_RE
  ).test(text);
}

function hasActionAfterAcknowledgement(text: string): boolean {
  const remainder = text.replace(ACKNOWLEDGEMENT_PREFIX_RE, '');
  return remainder !== text && DIRECT_ACTION_AFTER_ACK_RE.test(remainder);
}

function isShort(text: string): boolean {
  return text.trim().length <= 40;
}

export function classifyMessageIntent(message: string): IntentClassification {
  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: 'casual', confidence: 0.9, reasons: ['empty message'] };
  }
  const externalEffect = classifyExternalEffectRequest(trimmed);

  // CASUAL — anchored at start, must be a short message to avoid false
  // positives like "thanks for considering building this huge system".
  for (const pat of CASUAL_PATTERNS) {
    if (
      pat.test(trimmed)
      && isShort(trimmed)
      && !hasExplicitActionContinuation(trimmed, true)
      && !hasActionAfterAcknowledgement(trimmed)
      && !externalEffect.requested
    ) {
      return { intent: 'casual', confidence: 0.9, reasons: ['matches casual greeting/acknowledgement pattern'] };
    }
  }

  // META — questions about the agent itself.
  for (const pat of META_PATTERNS) {
    if (
      pat.test(trimmed)
      && !hasExplicitActionContinuation(trimmed, true)
      && !externalEffect.requested
    ) {
      return { intent: 'meta_clarify', confidence: 0.8, reasons: ['asks about agent capabilities or usage'] };
    }
  }

  // Advice and read-only requests can mention consequential verbs as the
  // subject of discussion ("Should I publish?", "explain how to deploy") or
  // contain action-shaped nouns ("read the email"). Keep those turns light
  // unless the user adds a separate direct action clause.
  const readOnlyOpening = READ_ONLY_OPERATION_START_RE.test(trimmed);
  const advisoryOpening = ADVISORY_ACTION_START_RE.test(trimmed)
    || POLITE_ADVISORY_ACTION_START_RE.test(trimmed);
  if (
    (readOnlyOpening || advisoryOpening)
    && !hasExplicitActionContinuation(trimmed, readOnlyOpening)
    && !externalEffect.requested
  ) {
    return {
      intent: 'lookup',
      confidence: 0.82,
      reasons: ['read-only or advisory opening without a direct follow-up action'],
    };
  }
  if (
    NEGATED_ACTION_ONLY_START_RE.test(trimmed)
    && !hasExplicitActionContinuation(trimmed, false)
    && !externalEffect.requested
  ) {
    return {
      intent: 'tool_intent',
      confidence: 0.75,
      reasons: ['prohibition without a requested action'],
    };
  }
  if (
    NON_REQUEST_ACTION_MENTION_START_RE.test(trimmed)
    && !hasExplicitActionContinuation(trimmed, false)
    && !externalEffect.requested
  ) {
    return {
      intent: 'tool_intent',
      confidence: 0.75,
      reasons: ['mentions a possible action without requesting it'],
    };
  }
  if (externalEffect.requested) {
    return {
      intent: 'action',
      confidence: 0.9,
      reasons: [`direct external effect: ${externalEffect.kinds.join(', ')}`],
    };
  }

  const lookup = matchCount(trimmed, LOOKUP_CUES);
  const action = matchCount(trimmed, ACTION_CUES);
  if (DIRECT_AMBIGUOUS_ACTION_RE.test(trimmed) && action.count === 0) {
    action.count = 1;
    action.matched.push('direct communication action');
  }
  const multi = matchCount(trimmed, MULTI_PART_CUES);
  const reasons: string[] = [];

  // Question-shaped messages are lookups even when they happen to
  // contain action verbs ("when did we ship X" mentions 'ship' but is
  // asking a question, not requesting work).
  const lower = trimmed.toLowerCase();
  const questionStart = QUESTION_STARTERS.some((q) => lower.startsWith(q));
  if (
    questionStart
    && lookup.count > 0
    // A plain "and <verb>" can remain inside the subject of a question
    // ("what is the build and deploy status?"). Only a real clause boundary
    // such as "then" or punctuation can hand a question off to an action.
    && !hasExplicitActionContinuation(trimmed, false)
  ) {
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
): MemoryBudget {
  switch (intent) {
    case 'casual':
      return { loadWorkingMemory: false, loadSessionBrief: false, vaultSearchTopK: 0, vaultFormatBytes: 0 };
    case 'meta_clarify':
      // Agent-self questions don't need vault recall; instructions
      // already describe capabilities.
      return { loadWorkingMemory: false, loadSessionBrief: true, vaultSearchTopK: 0, vaultFormatBytes: 0 };
    case 'lookup':
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 6, vaultFormatBytes: 1800 };
    case 'action':
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 6, vaultFormatBytes: 1800 };
    case 'tool_intent':
    default:
      return { loadWorkingMemory: true, loadSessionBrief: true, vaultSearchTopK: 4, vaultFormatBytes: 1800 };
  }
}
