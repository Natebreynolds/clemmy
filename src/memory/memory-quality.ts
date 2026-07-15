const DURABLE_CAPTURE_PREFIXES = [
  'user explicitly asked clementine to remember:',
  'user preference:',
  'standing preference:',
  'standing instruction:',
  'clementine requirement:',
  'connected-app context:',
];

const STANDING_MARKER_RE = /\b(?:always|never|from now on|going forward|by default|as a rule|whenever|every (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const TASK_ACTION_RE = /(?:analy[sz]e|check|pull|draft|write|create|build|run|call|use|find|list|research|send|email|open|fix|review|implement)/i;
const ONE_OFF_TIME_RE = /\b(?:today|tomorrow|tonight|this (?:morning|afternoon|evening|week|month)|next (?:hour|day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

function normalized(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strict intake guard used for new writes and accepted-claim counts. It only
 * matches unmistakable request grammar; ambiguous legacy prose belongs in the
 * broader human-review detector below and must not be automatically downgraded.
 */
export function looksLikeHighConfidenceTransientRequest(content: string): boolean {
  const text = normalized(content);
  if (!text || DURABLE_CAPTURE_PREFIXES.some((prefix) => text.startsWith(prefix))) return false;
  if (/^(?:quick|small|one[- ]off)\s+(?:task|request)\s*:/i.test(text)) return true;
  if (new RegExp(`^(?:task|request)\\s*:\\s*(?:please\\s+)?${TASK_ACTION_RE.source}\\b`, 'i').test(text)) return true;
  if (new RegExp(`^(?:go ahead and|please go ahead and)\\s+${TASK_ACTION_RE.source}\\b`, 'i').test(text)) return true;
  if (STANDING_MARKER_RE.test(text)) return false;
  if (/^(?:can|could|would|will|should)\s+(?:you|we)\b/i.test(text)) return true;
  if (/^(?:do|did|does|have|has|is|are|am)\s+(?:i|you|we|he|she|they|it|this|that|there|the|my|our|these|those)\b/i.test(text)) return true;
  if (/^(?:what|when|where|who|why|how)\s+(?:is|are|was|were|do|did|does|can|could|would|should|will|have|has)\b/i.test(text)) return true;
  if (new RegExp(`^please\\s+${TASK_ACTION_RE.source}\\b`, 'i').test(text)) return true;
  if (new RegExp(`^let(?:'|’)s\\s+${TASK_ACTION_RE.source}\\b`, 'i').test(text)) return true;
  if (/^i\s+(?:need|want|would like)\s+(?:you|clementine)\b/i.test(text)) return true;
  // Bare imperatives are kept deliberately narrow. Noun phrases such as
  // “Email outreach execution fails …” must remain valid declarative facts.
  return /^(?:send|create|run|fix|open|pull|draft|write|research|analy[sz]e)\s+(?:me|us|the|this|that|my|our|a|an)\b/i.test(text);
}

/**
 * High-precision detector for conversational actions that do not belong in
 * durable fact memory. This is deliberately mechanical: it can block a raw
 * task-shaped memory write and flag a legacy claim for review, but it never
 * deletes anything by itself.
 */
export function looksLikeTransientRequest(content: string): boolean {
  const text = normalized(content);
  if (!text) return false;
  // Check explicit task wrappers before standing-language exemptions:
  // “Quick task: set up a weekly …” is still an action request, not a fact.
  if (/^(?:quick|small|one[- ]off)\s+(?:task|request)\s*:/i.test(text)) return true;
  if (/^(?:task|request)\s*:\s*(?:please\s+)?(?:analy[sz]e|check|pull|draft|write|create|build|run|call|use|find|list|research|send|email|open|fix|review|implement)\b/i.test(text)) return true;
  if (/^(?:go ahead and|please go ahead and)\s+(?:analy[sz]e|check|pull|draft|write|create|build|run|call|use|find|list|research|send|email|open|fix|review|implement)\b/i.test(text)) return true;
  if (DURABLE_CAPTURE_PREFIXES.some((prefix) => text.startsWith(prefix))) return false;
  // A standing rule may legitimately begin with an action verb.
  if (STANDING_MARKER_RE.test(text)) return false;
  if (/^when\b.*\b(?:always|only|must|should|need(?:s)? to)\b/i.test(text)) return false;
  if (/^when\b.*\b(?:refers? to|means|maps? to|is shorthand for)\b/i.test(text)) return false;
  // Contextual preferences are often written as “When doing X, lead/use/avoid
  // Y.” They are durable operating guidance, not the user's current task. Keep
  // explicit one-off time language in the review queue (for example, “When
  // meeting Sarah tomorrow, send the draft”).
  if (!ONE_OFF_TIME_RE.test(text)
    && /^when\s+[a-z][a-z-]*ing\b[^?]{0,140},\s*(?!(?:can|could|would|should|will|do|did|does|have|has|is|are|what|when|where|who|why|how)\b)(?:please\s+)?[a-z]/i.test(text)) {
    return false;
  }
  if (/^[a-z][\w-]*(?: [a-z][\w-]*){1,8}\s+(?:is|are|was|were|has|have|uses|requires|fails|succeeds|remains|includes|contains|depends|runs)\b/i.test(text)) return false;
  if (/^(?:can|could|would|should|do|did|does|have|has|is|are|am)\s+(?:i|you|we|he|she|they|it|this|that|there|the|my|our|these|those)\b/.test(text)) return true;
  if (/^(?:what|when|where|who|why|how)\b/.test(text)) return true;
  if (/^(?:please\s+)?(?:tell|show|help|find|search|look|check|fix|make|create|send|open|run|build|add|remove|update|change|explain|review|implement|analy[sz]e|pull|draft|write|research|email|call|use|list)\b/.test(text)) return true;
  if (/^let(?:'|’)s\b/.test(text)) return true;
  return /^i\s+(?:need|want|would like)\s+(?:you|clementine)\b/.test(text);
}

/**
 * High-precision rejection reasons for claims proposed by tool reflection.
 *
 * The extractor is intentionally conservative, but model output can still
 * turn the current request, a connector acknowledgement, or a runtime id into
 * declarative-looking prose. Those observations are useful in the event log,
 * not as durable semantic memory. Keep this narrower than
 * `looksLikeTransientRequest`: a false negative creates reviewable noise,
 * while a false positive can discard real knowledge.
 */
export function derivedFactRejectionReason(content: string): string | null {
  const text = normalized(content);
  if (!text) return 'empty_candidate';
  if (looksLikeHighConfidenceTransientRequest(content)) return 'transient_request';

  if (/^(?:clementine|the assistant|the tool|the agent)\s+(?:called|ran|searched|looked up|queried|returned|found|opened|listed|retrieved|fetched)\b/.test(text)) {
    return 'assistant_action_history';
  }
  if (/^(?:the\s+)?(?:tool|workflow|job|request|operation|sync|import|export|query|search)\s+(?:completed|returned|produced|found|succeeded|finished|ran successfully)\b/.test(text)) {
    return 'ephemeral_tool_status';
  }
  if (/^(?:the\s+)?(?:request|call|run|job|trace|session|operation)\s*(?:id|identifier)\s*(?:is|was|:)\s*[a-z0-9_-]{6,}\b/.test(text)
    || /^(?:request|call|run|job|trace|session|operation)[_-]id\s*:\s*[a-z0-9_-]{6,}\b/.test(text)) {
    return 'runtime_identifier';
  }
  if (/^(?:the\s+)?(?:current\s+)?(?:weather|temperature|forecast)\s+(?:in|for|at)\b/.test(text)
    || /^(?:it is|it's)\s+-?\d+(?:\.\d+)?\s*(?:°|degrees?)\b/.test(text)) {
    return 'ephemeral_snapshot';
  }
  return null;
}
