/**
 * A deliberately narrow taxonomy for direct real-world effects that may be
 * requested without naming a provider.
 *
 * Provider-aware writes ("update Airtable", "create a Notion page") still use
 * the destination-aware evidence logic in the harness. This classifier covers
 * the natural commands where the object itself carries the external semantics:
 * "RSVP yes", "buy the tickets", "approve the PR", and similar requests.
 *
 * Keep this module pure and dependency-free. Intent routing, turn stakes, and
 * completion evidence all consume the same result so adding a consequential
 * verb cannot silently update only one safety layer.
 */

export type ExternalEffectKind =
  | 'communication'
  | 'meeting_change'
  | 'financial_transaction'
  | 'subscription_change'
  | 'external_comment'
  | 'invitation_response'
  | 'social_reaction'
  | 'social_repost'
  | 'social_follow'
  | 'commerce'
  | 'reservation'
  | 'document_signature'
  | 'code_host_change'
  | 'work_item_change'
  | 'poll_vote'
  | 'flight_check_in'
  | 'calendar_change';

export interface ExternalEffectClassification {
  requested: boolean;
  kinds: ExternalEffectKind[];
}

interface ExternalEffectRule {
  kind: ExternalEffectKind;
  pattern: RegExp;
}

const TECHNICAL_COMMUNICATION_OBJECT_SOURCE =
  'address|api|body|column|command|endpoint|field|function|helper|method|property|schema|script|subject|template|tool|type|variable';

const EXTERNAL_EFFECT_RULES: readonly ExternalEffectRule[] = [
  {
    kind: 'communication',
    pattern: new RegExp(
      `^(?:email|message|dm|notify)\\s+(?!(?:(?:my|our|the|this|that|your)\\s+)?(?:${TECHNICAL_COMMUNICATION_OBJECT_SOURCE})\\b)(?:(?:my|our|the|this|that|your)\\s+)?\\S+`,
      'i',
    ),
  },
  {
    kind: 'communication',
    pattern: /^(?:reply\s+to\s+\S+|forward\b[^.!?\n;]{0,100}\bto\b)/i,
  },
  {
    kind: 'communication',
    pattern: new RegExp(
      `^call\\s+(?!(?:(?:my|our|the|this|that|your)\\s+)?(?:${TECHNICAL_COMMUNICATION_OBJECT_SOURCE})\\b)(?:(?:my|our|the|this|that|your)\\s+)?\\S+`,
      'i',
    ),
  },
  {
    kind: 'meeting_change',
    pattern: /^(?:book|cancel)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:appointment|event|meeting|reservation)\b/i,
  },
  {
    kind: 'financial_transaction',
    pattern: /^(?:charge|pay|refund)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:account|bill|card|charge|client|customer|invoice|order|payment|subscription|transaction|\$?\d)\b/i,
  },
  {
    kind: 'subscription_change',
    pattern: /^(?:subscribe|unsubscribe)\b[^.!?\n;]{0,100}\b(?:from|to)\b/i,
  },
  {
    kind: 'external_comment',
    pattern: /^comment\s+on\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:issue|post|pull\s+request|pr|thread|ticket)\b/i,
  },
  {
    kind: 'invitation_response',
    pattern: /^(?:rsvp\b(?!\s+(?:guide|instructions?|policy|process)\b)|(?:accept|decline|reject)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:calendar\s+)?(?:invitation|invite)\b)/i,
  },
  {
    kind: 'social_reaction',
    pattern: /^(?:like|unlike|react\s+to)\s+(?:(?:a|my|our|the|this|that|your)\s+)?(?:(?:@[\w.-]+|[\w.-]+'s|facebook|instagram|linkedin|slack|tiktok|twitter|x)\s+){0,3}(?:it|message|photo|post|story|thread|tweet|update|video|this|that)\b/i,
  },
  {
    kind: 'social_repost',
    pattern: /^(?:quote\s+tweet|repost|retweet)\b(?:\s+\S+)?/i,
  },
  {
    kind: 'social_follow',
    pattern: /^(?:follow|unfollow)\s+(?!up\b)(?![^.!?\n;]{0,60}\b(?:directions?|guide|instructions?|path|plan|procedure|process|steps?)\b)\S+/i,
  },
  {
    kind: 'commerce',
    pattern: /^(?:buy|purchase)\s+(?!(?:time|the\s+(?:argument|idea|premise|story))\b)\S+/i,
  },
  {
    kind: 'commerce',
    pattern: /^(?:order|place\s+(?:an?|the)\s+order(?:\s+for)?)\s+(?!(?:(?:a|an|the|this|that)\s+)?(?:array|collection|data|items?|list|records?|results?|rows?|set)\b)(?!by\b)\S+/i,
  },
  {
    kind: 'reservation',
    pattern: /^reserve\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:appointment|booking|car|flight|hotel|rental|reservation|room|seat|table|tickets?|it|this|that)\b/i,
  },
  {
    kind: 'reservation',
    pattern: /^(?:(?:book|cancel)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:booking|flight|hotel|reservation|room|table)\b|make\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?reservation\b(?!\s+(?:component|fixture|mock|object|schema|test|type|widget)\b))/i,
  },
  {
    kind: 'document_signature',
    pattern: /^(?:e-?sign|sign)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:docusign(?:\s+(?:agreement|document|envelope|form))?|agreement|contract|docusign\s+envelope|e-?signature\s+document|waiver)\b/i,
  },
  {
    kind: 'code_host_change',
    pattern: /^(?:approve|merge)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:pull\s+request|pr)\b/i,
  },
  {
    kind: 'code_host_change',
    pattern: /^(?:star|unstar)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:repository|repo)\b/i,
  },
  {
    kind: 'work_item_change',
    pattern: /^(?:close|reopen)\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:issue|ticket)\b/i,
  },
  {
    kind: 'work_item_change',
    pattern: /^assign\s+(?:(?:a|an|my|our|the|this|that|your)\s+)?(?:issue|ticket)\b/i,
  },
  {
    kind: 'poll_vote',
    pattern: /^(?:cast\s+(?:(?:my|our|the|this|that|your)\s+)?vote|vote)\b[^.!?\n;]{0,120}\bpoll\b/i,
  },
  {
    kind: 'flight_check_in',
    pattern: /^check\s+(?:(?:me|us)\s+)?in\b[^.!?\n;]{0,120}\bflight\b/i,
  },
  {
    kind: 'calendar_change',
    pattern: /^(?:add|create|put|save|schedule)\b[^.!?\n;]{0,120}\b(?:in|into|on|to)\s+(?:(?:my|our|the|your)\s+)?calendar\b/i,
  },
];

const CLAUSE_BOUNDARY_RE =
  /(?:[.!?\n;]+|,\s*(?:but|however|instead|then)\s+|\b(?:and\s+then|but|then)\s+)/i;

const ACKNOWLEDGEMENT_PREFIX_RE =
  /^(?:ok|okay|cool|got\s+it|sounds\s+good|thanks|thank\s+you|nice|perfect|sweet|awesome)\b[\s,:—–-]*/i;
const POLITE_PREFIX_RE = /^(?:please|kindly)\b[\s,:—–-]*/i;
const DIRECT_ASSISTANT_PREFIX_RE =
  /^(?:can|could|would|will)\s+(?:you|clem|clementine)\s+/i;
const DESIRE_PREFIX_RE =
  /^(?:(?:i(?:'d| would)\s+like|i\s+want|i\s+need)\s+(?:you|clem|clementine)\s+to)\s+/i;
const EXECUTION_PREFIX_RE =
  /^(?:go\s+ahead\s+and|make\s+sure\s+to|let'?s|now)\b[\s,:—–-]*/i;

const APPROVAL_DEFERRAL_RE =
  /(?:\b(?:ask|check|confirm)\s+(?:with\s+)?me\b[^.!?\n;]{0,100}\bbefore\b|\bbefore\b[^.!?\n;]{0,100}\b(?:i|we)\s+(?:approve|confirm|give\s+permission|say\s+yes)\b|\b(?:after|once|when)\b[^.!?\n;]{0,100}\b(?:i|we)\s+(?:approve|confirm|give\s+permission|say\s+yes)\b|\b(?:pending|until|unless)\b[^.!?\n;]{0,80}\b(?:approval|approved|confirmation|permission)\b|\bfor\s+(?:my\s+|our\s+|the\s+)?(?:approval|confirmation|permission)\b|\b(?:do\s+not|don't|dont|never)\b|\b(?:nothing|not)\s+(?:now|yet)\b)/i;

function stripDirectRequestPrefixes(rawClause: string): string {
  let clause = rawClause.trim().replace(/[’]/g, "'");
  for (let i = 0; i < 8; i += 1) {
    const next = clause
      .replace(ACKNOWLEDGEMENT_PREFIX_RE, '')
      .replace(POLITE_PREFIX_RE, '')
      .replace(DIRECT_ASSISTANT_PREFIX_RE, '')
      .replace(DESIRE_PREFIX_RE, '')
      .replace(EXECUTION_PREFIX_RE, '')
      .trim();
    if (next === clause) break;
    clause = next;
  }
  return clause;
}

/**
 * Classify direct external effects in one or more request clauses.
 *
 * This intentionally does not treat mere mentions, first-person hypotheticals,
 * advice questions, approval-deferred actions, or local programming verbs as
 * requests. The caller can therefore use `requested` as a shared consequential
 * signal without turning every occurrence of words like "order" or "follow"
 * into a gate.
 */
export function classifyExternalEffectRequest(text: string): ExternalEffectClassification {
  const kinds = new Set<ExternalEffectKind>();
  for (const rawClause of text.split(CLAUSE_BOUNDARY_RE)) {
    if (!rawClause.trim() || APPROVAL_DEFERRAL_RE.test(rawClause)) continue;
    const clause = stripDirectRequestPrefixes(rawClause);
    for (const rule of EXTERNAL_EFFECT_RULES) {
      if (rule.pattern.test(clause)) kinds.add(rule.kind);
    }
  }
  return {
    requested: kinds.size > 0,
    kinds: [...kinds],
  };
}
