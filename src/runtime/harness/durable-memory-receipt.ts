import {
  parseExplicitMemoryInstruction,
  type AutoMemoryCandidate,
} from '../../memory/auto-capture.js';
import { hasExplicitActionContinuation } from '../../assistant/message-intent.js';
import { objectiveRequiresFreshExternalWrite } from './tool-evidence.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';
import { isDirectionSeekingQuestion } from './objective-judge.js';

const EXPLICIT_MEMORY_CAPTURE_REASONS = new Set([
  'explicit remember request',
  'explicit durable correction',
]);

const MEMORY_REQUEST_PREFIX_RE = /^\s*(?:please\s+)?(?:remember(?:\s+(?:this|that|for\s+later|for\s+future\s+reference)){0,3}\s*(?:that\b|\s*[:—–-]\s*)?|note(?:\s+that\b|\s*:\s*)|keep\s+in\s+mind(?:\s+that\b|\s*:\s*)?|don'?t\s+forget(?:\s+that\b|\s*:\s*)?|make\s+a\s+note(?:\s+that\b|\s*:\s*)?|(?:small\s+)?correction\s+(?:for\s+later|for\s+future\s+reference)\s*[:—–-]\s*|(?:for\s+later|for\s+future\s+reference)\s*[,:—–-]?\s*(?:small\s+)?correction\s*[:—–-]\s*)/i;

const ACKNOWLEDGEMENT_ONLY_RE = /(?:\b(?:a|an)\s+(?:(?:natural|brief|short|simple)\s+)?(?:acknowledg(?:e)?ment|confirmation|reply)\s+(?:is|will be)\s+(?:enough|sufficient)|\b(?:just|only)\s+(?:acknowledge|confirm)(?:\s+(?:that|it|this))?)[.!]*$/i;

const SECONDARY_CLAUSE_PREFIX = '(?:^|[.!?;,—–]\\s+|\\b(?:and\\s+then|then|also|plus|so|and)\\s+)';
const SECONDARY_REQUEST_RE = new RegExp(
  `${SECONDARY_CLAUSE_PREFIX}(?:please\\s+|(?:can|could|would|will)\\s+you\\s+)?(?:answer|analy[sz]e|assess|advise|brainstorm|calculate|check|compare|create|delete|deploy|draft|edit|email|evaluate|execute|explain|fetch|find|give|help|inspect|list|look\\s+up|manage|message|multiply|outline|post|publish|read|recommend|research|review|run|schedule|scrape|send|show|summari[sz]e|take|tell|test|translate|update|upload|verify|write)\\b`,
  'i',
);
const SECONDARY_QUESTION_RE = new RegExp(
  `${SECONDARY_CLAUSE_PREFIX}(?:what|when|where|who|why|how|which|do|does|did|is|are|can|could|would|will|have|has)\\b`,
  'i',
);
const UNAMBIGUOUS_MEMORY_ADMIN_RE = new RegExp(
  `${SECONDARY_CLAUSE_PREFIX}(?:please\\s+|(?:can|could|would|will)\\s+you\\s+)?(?:clear|forget|purge|reactivate|recall|restore|unpin)\\b`,
  'i',
);
const AMBIGUOUS_MEMORY_ADMIN_RE = new RegExp(
  `${SECONDARY_CLAUSE_PREFIX}(?:please\\s+|(?:can|could|would|will)\\s+you\\s+)?(?:delete|inspect|list|pin|read|remove|search|show)\\b(?:(?![.!?]).){0,64}\\b(?:memor(?:y|ies)|facts?|fact\\s*#?\\d+)\\b`,
  'i',
);
const MEMORY_TOOL_REQUEST_RE = /\b(?:use|call|run|invoke)\s+memory_(?:forget|list_facts|read|recall_all|remember|restore|search)\b/i;
const STORED_MEMORY_MANAGEMENT_RE = /\b(?:manage|change|update|clear|purge)\s+(?:my\s+|the\s+)?(?:stored\s+)?(?:knowledge|memor(?:y|ies)|facts?)\b/i;

// Defense in depth for secondary tails that admission parsers can legitimately
// preserve as part of a declarative-looking sentence. These shapes express a
// question, requested deliverable, memory administration, explicit tool use,
// or external effect after a conjunction. Keep the detector task-shaped: a
// second declarative fact such as "and Cedar-12 is retired" remains eligible.
const SECONDARY_TAIL_WORK_RE = new RegExp(
  `${SECONDARY_CLAUSE_PREFIX}(?:`
    + `(?:i|we)\\s+(?:have\\s+(?:(?:a|another|one)\\s+)?questions?\\b|have\\s+something\\s+to\\s+ask\\b|wonder\\b|(?:am|are|was|were)\\s+wondering\\b|(?:am|are|was|were)\\s+curious\\b|(?:need|want|would\\s+like)\\s+to\\s+know\\b|expect\\b|anticipate\\b)`
    + `|i(?:['’]d|\\s+would)\\s+like\\s+to\\s+know\\b`
    + `|(?:there\\s+is\\s+)?(?:one|a)\\s+(?:more\\s+)?question\\b`
    + `|(?:i|we)\\s+(?:need|want|would\\s+like)\\s+(?:(?:a|an|the)\\s+)?(?:summary|analysis|assessment|review|report|brief|outline|plan|recommendation|answer|explanation|translation|calculation)\\b`
    + `|(?:i|we)\\s+(?:need|want|would\\s+like)\\s+(?:(?:a|an|the)\\s+)?(?:report|brief|message|email|note|file|document|artifact|result)\\b(?:(?![.!?]).){0,96}\\b(?:sent|emailed|messaged|posted|published|deployed|created|edited|deleted|uploaded|downloaded|run|executed|scheduled|booked|ordered|paid)\\b`
    + `|(?:(?:the|my|our)\\s+)?(?:(?:old|stored|saved|prior|previous)\\s+)?(?:memor(?:y|ies)|facts?)\\b(?:(?![.!?]).){0,80}\\b(?:should|must|need(?:s)?\\s+to)\\s+(?:be\\s+)?(?:cleared|deleted|forgotten|purged|removed|restored|reactivated|unpinned)\\b`
    + `|(?:the\\s+)?memory_[a-z0-9_]+(?:\\s+tool)?\\b(?:(?![.!?]).){0,64}\\b(?:should|must|need(?:s)?\\s+to)\\s+(?:be\\s+)?(?:called|run|invoked|used)\\b`
    + `|let\\s+memory_[a-z0-9_]+\\s+(?:run|be\\s+called|be\\s+invoked|be\\s+used)\\b`
    + `|memory_[a-z0-9_]+\\s+is\\s+(?:the\\s+)?tool\\s+to\\s+(?:run|call|invoke|use)\\b`
    + `|(?:i|we)\\s+(?:need|want)\\s+memory_[a-z0-9_]+\\s+(?:run|called|invoked|used)\\b`
    + `|(?:(?:the|my|our)\\s+)?(?:report|brief|message|email|note|file|document|artifact|result)\\b(?:(?![.!?]).){0,80}\\b(?:should|must|need(?:s)?\\s+to)\\s+(?:be\\s+)?(?:sent|emailed|messaged|posted|published|deployed|created|edited|deleted|uploaded|downloaded|run|executed|scheduled|booked|ordered|purchased|paid)\\b`
  + `)`,
  'i',
);

// The receipt fast path is intentionally narrower than memory admission. The
// shared memory parser owns clause isolation; this final payload check ensures
// the isolated memory itself is a declarative fact rather than a reminder/task.
const MEMORY_DECLARATIVE_CLAUSE_RE = /^(?:(?:i|we)\s+(?:am|are|was|were|use|prefer|live|work|have|own|run|manage|report|like|want|need|always|never|usually|typically)\b|(?:my|our)\b.{0,100}\b(?:is|are|was|were|uses?|prefers?|lives?|works?|has|have|owns?|runs?|manages?|reports?|reviews?|leads?|handles?|likes?|wants?|needs?|moved?|starts?|ends?|happens?|closes?|expires?)\b|(?:the\s+)?[\w][\w'’-]*(?:\s+[\w][\w'’-]*){0,10}\s+(?:is|are|was|were|has|have|uses?|prefers?|lives?|works?|owns?|runs?|manages?|reports?|reviews?|leads?|handles?|likes?|wants?|needs?|moved?|starts?|ends?|happens?|closes?|expires?)\b)/i;
const SECONDARY_DISCOURSE_CLAUSE_RE = /^(?:(?:if|since|while|when|once|after|before|provided|assuming)\b|as\s+long\s+as\b|now\s+that\b|(?:you|also|then|plus)\b|by\s+the\s+way\b|separately\b|one\s+more\s+thing\b)/i;
const LIVE_MEMORY_PAYLOAD_RE = /(?:\bnow\b|\b(?:i|we)\s+(?:need|want)\s+you\s+to\b|\b(?:is|are|was|were)\s+to\s+[a-z]+\b)/i;
const DECLARATIVE_PREDICATE_CONTINUATION_RE = /^(?:is|are|was|were|has|have)\b|^must\s+not\s+be\s+(?:used|treated|considered)\b/i;
const SEGMENT_QUESTION_OR_TASK_RE = /^(?:(?:i|we)\s+(?:have\s+(?:(?:a|another|one)\s+)?questions?\b|have\s+something\s+to\s+ask\b|wonder\b|(?:am|are|was|were)\s+(?:wondering|curious)\b|(?:need|want|would\s+like)\s+to\s+know\b|expect\b|anticipate\b)|i(?:['’]d|\s+would)\s+like\s+to\s+know\b|(?:there\s+is\s+)?(?:one|a)\s+(?:more\s+)?question\b)/i;
const SEGMENT_INDIRECT_WORK_RE = /^(?:(?:i|we)\s+(?:(?:am|are|was|were)\s+hoping\s+(?:you|we)\s+(?:can|could|will|would)\s+(?:answer|analy[sz]e|check|compare|create|draft|explain|review|run|send|show|summari[sz]e|update|write)\b|have\s+(?:(?:an|another|one\s+more)\s+)?(?:ask|request)\b|(?:need|want)\s+you\s+(?:to\s+)?(?:answer(?:ing)?|analy[sz](?:e|ing)|check(?:ing)?|compar(?:e|ing)|creat(?:e|ing)|draft(?:ing)?|explain(?:ing)?|review(?:ing)?|run(?:ning)?|send(?:ing)?|show(?:ing)?|summari[sz](?:e|ing)|updat(?:e|ing)|writ(?:e|ing))\b|could\s+use\s+(?:(?:a|an|the)\s+)?(?:summary|analysis|assessment|review|report|brief|outline|plan|recommendation|answer|explanation|translation|calculation)\b)|let(?:['’]s|\s+us)\s+(?:answer|analy[sz]e|check|compare|create|draft|explain|review|run|send|show|summari[sz]e|update|write)\b|(?:we\s+should|maybe)\s+(?:answer|analy[sz]e|check|compare|create|draft|explain|review|run|send|show|summari[sz]e|update|write)\b|(?:[a-z0-9_'-]+\s+){0,5}[a-z0-9_'-]+\s+needs?\s+(?:answering|analy[sz]ing|checking|comparing|creating|drafting|explaining|reviewing|running|sending|showing|summari[sz]ing|updating|writing)\b)/i;
const SEGMENT_MEMORY_TOOL_WORK_RE = /^(?:let\s+memory_[a-z0-9_]+\s+(?:run|be\s+(?:called|invoked|used))\b|memory_[a-z0-9_]+\s+is\s+(?:the\s+)?tool\s+to\s+(?:run|call|invoke|use)\b|(?:i|we)\s+(?:need|want)\s+memory_[a-z0-9_]+\s+(?:run|called|invoked|used)\b)/i;
const SEGMENT_PASSIVE_MUTATION_RE = /\b(?:should|must|need(?:s)?(?:\s+to)?)\s+(?:be\s+)?(?:updated|run|refunded|migrated|inserted|sent|emailed|messaged|published|posted|deployed|created|edited|deleted|cleared|forgotten|purged|removed|restored|reactivated|unpinned|uploaded|downloaded|executed|called|scheduled|booked|ordered|purchased|paid)\b/i;

export interface DurableMemoryReceiptInput {
  message: string;
  candidates: readonly Pick<AutoMemoryCandidate, 'reason'>[];
  queuedCandidateCount: number;
  episodeId?: string | null;
}

/** Negative-only provider-neutral safety boundary for receipt presentation.
 * A false result requires repair before publication; a true result deliberately
 * says nothing about style, so Claude's natural voice is never rewritten merely
 * because it chose an opener the generic loop does not recognize. */
export function isSafeDurableMemoryReceiptPresentation(value: string): boolean {
  const rawText = value.trim();
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 600 || text.includes('?')) return false;
  const reasoningLeak = /possibly injected|prompt[-\s]?injection|the classic trap|reference data,?\s*not live instructions|possibly stale|by who[-\s]?knows[-\s]?whom|treat everything in the system[-\s]?reminder|that result looks scrambled|let me re-?read (?:the|what|the actual)|I need to stop and actually look|what actually changed:?\s*nothing/i.test(text);
  const effectVerb = '(?:sent|emailed|messaged|published|posted|deployed|created|edited|deleted|uploaded|downloaded|executed|called|scheduled|booked|ordered|purchased|paid|ran|shipped|pushed|merged)';
  const inflectedEffectClaim = new RegExp(
    `\\b(?:(?:(?:i|we)(?:['’]ve|\\s+have)?\\s+)${effectVerb}|(?:was|were|has\\s+been|have\\s+been|got)\\s+${effectVerb})\\b`,
    'i',
  ).test(text);
  const objectSensitiveEffectClaim = /\b(?:(?:(?:i|we)(?:['’]ve|\s+have)?\s+)?(?:saved|wrote|added|changed|updated|marked|archived|refunded)\s+(?:(?:a|an|the)\s+)?(?:file|report|document|note|artifact|row|spreadsheet|workbook|sheet|task|ticket|issue|record|account|charge|payment|invoice|transaction))\b/i.test(text);
  const fakeToolJson = /\{\s*["']?(?:action|tool|tool_slug|tool_name)["']?\s*:\s*["']?[a-z0-9_.-]+["']?\s*,\s*["']?(?:args|arguments)["']?\s*:/i.test(rawText);
  const bareToolJson = /\{\s*["']?(?:command|arguments)["']?\s*:/i.test(rawText);
  const taggedToolProtocol = /<\/?\s*tool[\s_-]*call\b|\[\s*\/?\s*tool[\s_-]*call\b|\[\s*(?:tool|calling|using|invoking|call)\s*:[^\]]*\]/i.test(rawText);
  const functionProtocol = /\bfunction\s*\{\s*["']?name["']?\s*:\s*["']?[a-z0-9_.-]+/i.test(rawText);
  const falseMemoryDenial = /\b(?:can(?:not|['’]?t)|could(?:not|n['’]?t)|will\s+not|won['’]?t|did\s+not|didn['’]?t|do\s+not|don['’]?t|unable\s+to|refus(?:e|ed)\s+to)\b(?:(?![.!?]).){0,64}\b(?:remember|store|save|note)\b/i.test(text);
  return !isDirectionSeekingQuestion(text)
    && !looksLikeToolCallShape(rawText)
    && !taggedToolProtocol
    && !fakeToolJson
    && !bareToolJson
    && !functionProtocol
    && !falseMemoryDenial
    && !reasoningLeak
    && !inflectedEffectClaim
    && !objectSensitiveEffectClaim
    && !/\b(?:system prompt|internal (?:machinery|instructions)|tool\s*call|<\/?invoke\b)\b/i.test(text)
    && !/\b(?:i(?:'ll| will| have|’ve)?\s+)?(?:send|email|message|publish|post|deploy|create|edit|delete|upload|download|run|execute|fetch|retrieve|check|call|contact|schedule|book|order|purchase|pay|ship|push|merge)\b/i.test(text);
}

/** Narrow generic-loop optimization on top of the shared safety boundary.
 * False here means “use ordinary verification,” not “rewrite this prose.” */
export function looksLikeHealthyDurableMemoryAcknowledgement(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  return isSafeDurableMemoryReceiptPresentation(value)
    && /^(?:got it|noted|understood|okay|ok|alright|certainly|absolutely|you(?:'re| are) right)(?:\b|[.!,:;—–-])/i.test(text);
}

function hasExplicitDurableMemoryReceipt(input: DurableMemoryReceiptInput): boolean {
  return Boolean(input.episodeId)
    && input.candidates.length > 0
    && input.queuedCandidateCount === input.candidates.length
    && input.candidates.some((candidate) => EXPLICIT_MEMORY_CAPTURE_REASONS.has(candidate.reason));
}

function hasOnlyDeclarativeMemoryPayload(message: string): boolean {
  const acknowledgement = message.match(ACKNOWLEDGEMENT_ONLY_RE);
  if (acknowledgement?.index === undefined) return false;
  const beforeAcknowledgement = message.slice(0, acknowledgement.index).trim();
  const payload = beforeAcknowledgement
    .replace(MEMORY_REQUEST_PREFIX_RE, '')
    .replace(/[.!;:\s]+$/g, '')
    .trim();
  if (!payload || payload === beforeAcknowledgement) return false;
  if (LIVE_MEMORY_PAYLOAD_RE.test(payload)) return false;
  const clauses = payload
    .split(/(?:[.!?;]\s+|\n+)/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const declarativeSegments = clauses.flatMap((clause) => (
    clause.split(/\s+(?:and|also|plus)\s+/i).map((segment) => segment.trim()).filter(Boolean)
  ));
  return declarativeSegments.length > 0
    && declarativeSegments.every((clause) => (
      !SECONDARY_DISCOURSE_CLAUSE_RE.test(clause)
      && !SEGMENT_QUESTION_OR_TASK_RE.test(clause)
      && !SEGMENT_INDIRECT_WORK_RE.test(clause)
      && !SEGMENT_MEMORY_TOOL_WORK_RE.test(clause)
      && !SEGMENT_PASSIVE_MUTATION_RE.test(clause)
      && (MEMORY_DECLARATIVE_CLAUSE_RE.test(clause)
        || DECLARATIVE_PREDICATE_CONTINUATION_RE.test(clause))
    ));
}

/**
 * Exact authority for an acknowledgement-only memory turn. Storage admission
 * and runtime authority consume the same explicit-memory parse, so a secondary
 * question/action isolated out of the fact can never disappear from the turn.
 */
export function durableMemoryReceiptAllowsConversationOnly(input: DurableMemoryReceiptInput): boolean {
  const message = input.message.replace(/\s+/g, ' ').trim();
  const instruction = parseExplicitMemoryInstruction(message);
  return message.length <= 900
    && hasExplicitDurableMemoryReceipt(input)
    && instruction !== null
    && !instruction.hasSecondaryWork
    && ACKNOWLEDGEMENT_ONLY_RE.test(message)
    && hasOnlyDeclarativeMemoryPayload(message)
    && !message.includes('?')
    && !hasExplicitActionContinuation(message, true)
    && !SECONDARY_REQUEST_RE.test(message)
    && !SECONDARY_QUESTION_RE.test(message)
    && !UNAMBIGUOUS_MEMORY_ADMIN_RE.test(message)
    && !AMBIGUOUS_MEMORY_ADMIN_RE.test(message)
    && !MEMORY_TOOL_REQUEST_RE.test(message)
    && !STORED_MEMORY_MANAGEMENT_RE.test(message)
    && !SECONDARY_TAIL_WORK_RE.test(message)
    && !objectiveRequiresFreshExternalWrite(message);
}
