import { createHash } from 'node:crypto';
import {
  consumeTaskContinuityPacket,
  createTaskContinuityPacket,
  dismissTaskContinuityPacket,
  peekTaskContinuityPacket,
  readConsumedTaskContinuityPacket,
  type TaskContinuityCapabilityEvidence,
  type TaskContinuityFrozenResolution,
  type TaskContinuityPacket,
} from '../../memory/task-continuity.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import {
  capabilityEffectIsCompatible,
  requestedCapabilityEffectScope,
} from '../../memory/capability-effect-scope.js';
import {
  liveComposioSchemaFingerprint,
} from '../../tools/composio-schema-cache.js';
import type { AssistantRequest, TaskContinuationContext } from '../../types.js';
import type { ContinuationAnswerDisposition } from '../../types.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  resolveTurnCapabilityCandidates,
  type CapabilityCandidate,
  type TurnCapabilityCandidates,
} from '../read-path/capability-candidates.js';
import { discoveryGovernor } from './discovery-governor.js';
import {
  getSession,
  listEvents,
  type EventRow,
} from './eventlog.js';
import * as approvalRegistry from './approval-registry.js';
import {
  getPendingAction,
  verifyConversationalPendingActionAuthority,
} from './pending-actions.js';
import { pendingActionIdFromArgs } from './pending-action-view.js';
import type { PresentationEvent } from './turn-outcome.js';

const ANSWER_MAX_CHARS = 280;
const ANSWER_MAX_WORDS = 24;
/** Accepted channel ingress is provider-dependent (Discord is tiny, generic
 * webhooks are not). Continuation authority therefore owns an explicit,
 * lossless ceiling: oversized A is not projected or truncated, it simply
 * cannot elevate B into A's effect contract. */
export const MAX_CLARIFICATION_PARENT_CHARS = 64_000;
const MAX_CONTINUITY_CANDIDATES = 10;
export const CLARIFICATION_RESOLVER_VERSION = 'clarification-resolver-v2' as const;

const NON_CLARIFICATION_SOURCES = new Set([
  'offer_background',
  'stall_recovery',
  'infra_error_recovery',
  'decision_awaiting_approval',
  'decision_awaiting_handoff_terminal',
  'artifact_verification_pending',
]);

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizedKey(value: string): string {
  return normalized(value).toLowerCase().replace(/[.!]+$/g, '');
}

function realAcceptedSource(sessionId: string, sourceUserSeq: number): EventRow | null {
  const [event] = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  });
  if (
    event?.seq !== sourceUserSeq
    || event.role !== 'user'
    || event.data.synthetic === true
  ) return null;
  const source = normalized(event.data.source).toLowerCase();
  // Approval/send consent has its own registry-bound resume protocol. A terse
  // yes/no control from that lane must never also consume a generic
  // clarification packet and acquire unrelated A/Q/B effect authority.
  if (
    source === 'channel_send_consent'
    || (
      source.startsWith('channel_')
      && normalized(event.data.approvalId)
      && normalized(event.data.decision)
    )
  ) return null;
  return event;
}

/** Read-only semantic projection for a registry-owned accepted control source.
 *
 * Approval/send consent has its own exact question/person/conversation claim
 * protocol, so the generic A/Q/B resolver must reject it. The graph compiler
 * still needs the already-authorized frozen action rather than the literal
 * word "Yes". Keep that elevation behind one runtime verifier: every durable
 * registry, responder, conversation, pending-action, and payload binding must
 * reproduce from the exact accepted source or this returns null. */
export function verifiedAcceptedControlSemanticInput(
  source: EventRow,
  identity: { sessionId: string; sourceUserSeq: number },
): string | null {
  if (
    source.sessionId !== identity.sessionId
    || source.seq !== identity.sourceUserSeq
    || source.type !== 'user_input_received'
    || source.role !== 'user'
    || source.data.synthetic === true
    || source.data.source !== 'channel_send_consent'
    || source.data.decision !== 'approve'
    || typeof source.data.approvalId !== 'string'
    || !source.data.approvalId.trim()
    || typeof source.data.userId !== 'string'
    || !source.data.userId.trim()
    || typeof source.data.conversationKey !== 'string'
    || !source.data.conversationKey.trim()
  ) return null;
  try {
    const row = approvalRegistry.get(source.data.approvalId);
    const presentation = row?.presentation;
    const pendingActionId = row ? pendingActionIdFromArgs(row.args) : null;
    const pendingAction = pendingActionId ? getPendingAction(pendingActionId) : null;
    const pinned = row?.args?.pendingAction;
    if (
      !row
      || row.sessionId !== identity.sessionId
      || row.status !== 'resolved'
      || row.resolution !== 'approved'
      || !presentation
      || presentation.kind !== 'autonomous_send_consent'
      || presentation.responseSourceUserSeq !== identity.sourceUserSeq
      || presentation.responseUserId !== source.data.userId
      || presentation.conversationKey !== source.data.conversationKey
    ) return null;
    if (pendingAction) {
      if (
        pendingAction.sessionId !== identity.sessionId
        || pendingAction.approvalId !== row.approvalId
        || !verifyConversationalPendingActionAuthority(pendingAction)
        || !pinned
        || typeof pinned !== 'object'
        || Array.isArray(pinned)
        || pendingAction.payloadHash !== (pinned as Record<string, unknown>).payloadHash
      ) return null;
      return `Send the exact previously prepared email to ${presentation.target} with subject ${presentation.subject ?? '(no subject)'} by executing frozen pending action ${pendingAction.id}. This is the irreversible external send the user just authorized.`;
    }

    return null;
  } catch {
    return null;
  }
}

function clarificationAwaitingEvent(input: {
  sessionId: string;
  sourceUserSeq: number;
  terminalSeq: number;
  terminalTurn: number;
}): EventRow | null {
  const candidates = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq,
    types: ['awaiting_user_input'],
  }).filter((event) => {
    if (event.seq >= input.terminalSeq) return false;
    // Modern awaiting rows carry the accepted source directly. That identity
    // is stronger than the display turn counter, which can legitimately differ
    // on durable 202 ingress after a long conversation. Legacy rows without a
    // source pointer retain the exact-turn fallback.
    return event.data.sourceUserSeq !== undefined
      ? event.data.sourceUserSeq === input.sourceUserSeq
      : event.turn === input.terminalTurn;
  });
  const distinctQuestions = new Set(candidates.map((event) => JSON.stringify({
    question: normalizedKey(normalized(event.data.question)),
    options: (Array.isArray(event.data.options) ? event.data.options : [])
      .map((option) => normalizedKey(normalized(option)))
      .filter(Boolean),
  })));
  // Several distinct open asks cannot be resolved by one short reply. The
  // packet store normally has one row, so detect ambiguity while the typed
  // awaiting events are still visible instead of silently selecting the last.
  if (distinctQuestions.size > 1) return null;
  const event = candidates.at(-1);
  if (!event) return null;
  const eventSourceUserSeq = event.data.sourceUserSeq;
  if (
    eventSourceUserSeq !== undefined
    && eventSourceUserSeq !== input.sourceUserSeq
  ) return null;
  const purpose = normalized(event.data.purpose).toLowerCase();
  if (purpose && purpose !== 'clarification') return null;
  // A bundle needs a typed answer per question. Until that parser exists, one
  // generic short reply must never consume several independent open points.
  if (event.data.bundled === true) return null;
  const source = normalized(event.data.source).toLowerCase();
  const reason = normalized(event.data.reason).toLowerCase();
  if (NON_CLARIFICATION_SOURCES.has(source)) return null;
  if (/(?:^|_)(?:approval|recovery|plan_first|handoff|background|artifact_verification)(?:_|$)/.test(reason)) {
    return null;
  }
  return event;
}

function effectClass(value: unknown): TaskContinuityCapabilityEvidence['effectClass'] {
  return value === 'read' || value === 'write' ? value : 'unknown';
}

function capabilityEvidenceForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  terminalSeq: number;
}): TaskContinuityCapabilityEvidence[] {
  const out: TaskContinuityCapabilityEvidence[] = [];
  const events = listEvents(input.sessionId, { sinceSeq: input.sourceUserSeq })
    .filter((event) => event.seq < input.terminalSeq);
  for (const event of events) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
    if (event.type === 'capability_resolution') {
      const entries = Array.isArray(event.data.entries) ? event.data.entries : [];
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const entry = raw as Record<string, unknown>;
        if (entry.status !== 'proven' || entry.connection === 'missing') continue;
        const kind = normalized(entry.kind);
        const identifier = normalized(entry.identifier);
        if (!kind || !identifier) continue;
        const schemaFingerprint = kind === 'composio'
          ? liveComposioSchemaFingerprint(identifier)
          : undefined;
        out.push({
          kind,
          identifier,
          effectClass: effectClass(entry.effectClass),
          evidenceKind: 'resolved',
          ...(normalized(entry.accountIdentity)
            ? { accountIdentity: normalized(entry.accountIdentity) }
            : {}),
          resourceRefs: [],
          ...(schemaFingerprint ? { schemaFingerprint } : {}),
        });
      }
    } else if (event.type === 'capability_discovered') {
      const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const row = raw as Record<string, unknown>;
        const kind = normalized(row.kind);
        const identifier = normalized(row.identifier);
        const schemaFingerprint = normalized(row.schemaFingerprint);
        if (!kind || !identifier || !schemaFingerprint) continue;
        out.push({
          kind,
          identifier,
          effectClass: effectClass(row.effectClass),
          evidenceKind: 'discovered',
          resourceRefs: [],
          schemaFingerprint,
        });
      }
    } else if (event.type === 'read_receipt') {
      const record = event.data.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const row = record as Record<string, unknown>;
      const kind = normalized(row.kind);
      const identifier = normalized(row.identifier);
      if (!kind || !identifier) continue;
      const resourceRef = normalized(row.readEvidenceRef);
      out.push({
        kind,
        identifier,
        effectClass: effectClass(row.effectClass || 'read'),
        evidenceKind: 'settled',
        ...(normalized(row.accountIdentity)
          ? { accountIdentity: normalized(row.accountIdentity) }
          : {}),
        resourceRefs: resourceRef ? [resourceRef] : [],
        ...(normalized(row.schemaFingerprint)
          ? { schemaFingerprint: normalized(row.schemaFingerprint) }
          : {}),
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((row) => {
    const key = `${row.kind}:${row.identifier}:${row.accountIdentity ?? ''}:${row.evidenceKind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);
}

/** Called only after the exactly-once terminal has durably committed. It
 * refuses every pause except an exact current-turn clarification event. */
export function persistCommittedClarificationContinuity(input: {
  terminalEvent: EventRow;
  presentation: PresentationEvent;
}): TaskContinuityPacket | null {
  const { terminalEvent, presentation } = input;
  if (
    presentation.status !== 'needs_input'
    || presentation.kind !== 'question'
    || presentation.needs?.kind !== 'input'
  ) return null;
  // Ordinary done terminals dominate this hot path. Avoid a session-table read
  // until the typed presentation proves this is actually a clarification.
  const sessionKind = getSession(presentation.identity.sessionId)?.kind;
  // A background execution can pause on a real user question and later be
  // resumed conversationally. Workflow/agent sessions do not accept a literal
  // next user turn, so they stay outside this continuity contract.
  if (sessionKind !== 'chat' && sessionKind !== 'execution') return null;
  const source = realAcceptedSource(
    presentation.identity.sessionId,
    presentation.identity.sourceUserSeq,
  );
  if (!source) return null;
  const awaiting = clarificationAwaitingEvent({
    sessionId: presentation.identity.sessionId,
    sourceUserSeq: source.seq,
    terminalSeq: terminalEvent.seq,
    terminalTurn: presentation.identity.turn,
  });
  if (!awaiting) return null;
  const question = normalized(awaiting.data.question);
  const deliveredQuestion = normalized(presentation.text);
  // The packet must describe the question the user actually saw. An internal
  // Q1 followed by a delivered Q2 cannot let a reply to Q2 inherit Q1's task,
  // options, recipient, or effect authority.
  if (
    !question
    || !deliveredQuestion
    || question.toLowerCase() !== deliveredQuestion.toLowerCase()
  ) return null;
  // PresentationEvent currently carries only the terminal question text. Until
  // a future terminal contract binds rendered controls byte-for-byte, internal
  // awaiting options are hidden implementation data and confer no ordinal or
  // exact-option authority on the reply.
  const options: string[] = [];
  const current = peekTaskContinuityPacket({ sessionId: source.sessionId });
  // The schema normally makes this impossible. If storage was copied or its
  // uniqueness invariant was damaged, never let a newly committed question
  // silently pick one of several possible parent tasks.
  if (current.status === 'ambiguous') return null;
  if (
    current.status === 'available'
    && current.packet.originatingSourceUserSeq === source.seq
    && current.packet.pause.kind === 'clarification'
    && normalizedKey(current.packet.pause.question) === normalizedKey(question)
    && current.packet.pause.options.length === options.length
    && current.packet.pause.options.every((option, index) => option === options[index])
  ) return current.packet;
  return createTaskContinuityPacket({
    sessionId: source.sessionId,
    originatingSourceUserSeq: source.seq,
    pause: { kind: 'clarification', question, options },
    capabilities: capabilityEvidenceForSource({
      sessionId: source.sessionId,
      sourceUserSeq: source.seq,
      terminalSeq: terminalEvent.seq,
    }),
  });
}

export interface ClarificationAnswerClassification {
  disposition: ContinuationAnswerDisposition;
  selectedOption?: string;
  activeTaskInput?: string;
}

const EXPLICIT_DECLINE_RE = /^(?:no|nope|nah|actually no|no,? thanks|not now|never mind|nevermind|not that one|don['’]?t|do not|please don['’]?t|please do not|stop|cancel|leave it alone|keep it unchanged|draft only)[.!]*$/i;
const EXPLICIT_AFFIRM_RE = /^(?:yes(?:,?\s+(?:please|correct|that(?:['’]s| is)\s+(?:all\s+)?correct))?|yep|yeah|correct|exactly|that(?:['’]s| is) right|go ahead|continue|proceed|do it|create it|sounds good|okay|ok|sure)[.!]*$/i;

/** A deliberately narrow dual-clause form. The first sentence must explicitly
 * cancel/leave the prior work and the second must be introduced as separate
 * work. This does not classify same-task corrections such as “No, but send it
 * to Alice instead”; those remain ordinary fresh turns and inherit nothing. */
function declinedParentWithNewTask(
  answer: string,
): ClarificationAnswerClassification | null {
  const match = /^(?:no|nope|nah)\s*(?:[—–-]|[,;:])?\s*([^.!?]{1,120})[.!?]\s*(?:instead|separately|new task|unrelated(?:ly)?)\s*[,;:—–-]?\s*(.+)$/i.exec(answer);
  if (!match) return null;
  const cancelledClause = normalized(match[1]);
  const activeTaskInput = normalized(match[2]);
  if (!cancelledClause || !activeTaskInput) return null;
  if (!/\b(?:leave|skip|cancel|stop|don['’]?t|do not|not create|not send|not write|alone|uncreated)\b/i.test(cancelledClause)) {
    return null;
  }
  if (/^(?:but\b|and\b)/i.test(activeTaskInput)) return null;
  // “Instead, send it…” is still a correction to the parent task, even after a
  // sentence break. Require the fresh clause to name its own object rather than
  // smuggling parent authority through an opening anaphor.
  if (/^(?:please\s+)?(?:send|post|publish|deploy|update|edit|delete|move|share|create|write|read|open|run|use)\s+(?:it|that|this|them|those|these)\b/i.test(activeTaskInput)) {
    return null;
  }
  return { disposition: 'declined_with_new_task', activeTaskInput };
}

type TypedLiteralKind = 'url' | 'email' | 'date' | 'time' | 'channel';

function typedLiteralKind(value: string): TypedLiteralKind | null {
  if (/^https?:\/\/\S+$/i.test(value)) return 'url';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^\d{1,2}:\d{2}(?:\s?[ap]m)?$/i.test(value)) return 'time';
  if (/^#[\w.-]+$/.test(value)) return 'channel';
  return null;
}

function questionRequestsTypedSlot(question: string, kind?: TypedLiteralKind): boolean {
  const q = normalized(question);
  const namesKind = kind === undefined
    ? /\b(?:url|link|website|endpoint|email|e-mail|mailbox|recipient|address|date|day|time|channel|room)\b/i.test(q)
    : kind === 'url'
      ? /\b(?:url|link|website|endpoint)\b/i.test(q)
      : kind === 'email'
        ? /\b(?:email|e-mail|mailbox|recipient(?:\s+address)?|email\s+address)\b/i.test(q)
        : kind === 'date'
          ? /\b(?:date|day)\b/i.test(q)
          : kind === 'time'
            ? /\b(?:time|hour)\b/i.test(q)
            : /\b(?:channel|room)\b/i.test(q);
  if (!namesKind) return false;
  return /^(?:which|what|where|when|who|whose|how)\b/i.test(q)
    || /\b(?:provide|enter|supply|give|tell|specify|choose|select|name|share|type)\b/i.test(q)
    || /\b(?:do|did|can|could|would)\s+you\s+(?:know|have)\b/i.test(q);
}

function literalAnswerFitsQuestion(answer: string, pause: TaskContinuityPacket['pause']): boolean {
  const kind = typedLiteralKind(answer);
  return kind !== null
    && questionRequestsTypedSlot(pause.question, kind)
    && !questionAcceptsConfirmation(pause);
}

function questionAcceptsConfirmation(pause: TaskContinuityPacket['pause']): boolean {
  const question = normalized(pause.question);
  if (!question || /\b(?:not|never|don['’]?t|do not)\b/i.test(question)) return false;
  if (/\b(?:which|what|where|when|who|whose|how many)\b/i.test(question)) return false;
  if (questionRequestsTypedSlot(question)) return false;
  // "Can you give/clarify/provide …?" asks for missing slot content. Its modal
  // prefix does not make the unknown tenant/account/name a closed proposition.
  if (/^(?:can|could|would|will|may)\s+you\s+(?:give|provide|supply|tell|name|specify|clarify|identify|choose|select|share|enter|type)\b/i.test(question)) {
    return false;
  }
  // Providers often render the same binary clarification conversationally as
  // “Want me to …?” rather than “Do you want me to …?”. Accept that ellipsis
  // only when it has no alternative branch, or when the alternative explicitly
  // cancels/leaves the proposed work. “Want me to use A or B?” remains a named
  // choice and cannot be consumed by a generic yes/no answer.
  if (/^(?:do you\s+)?want\s+(?:me|us)\s+to\b/i.test(question)) {
    const alternative = question.match(/\bor\s+(.+?)[?!.]*$/i)?.[1]?.trim();
    if (!alternative || /^(?:leave|keep|skip|cancel|stop|do not|don['’]?t)\b/i.test(alternative)) {
      return true;
    }
  }
  if (/^(?:should|shall|may|can|could|would|will|do|does|did|is|are|was|were|has|have)\b/i.test(question)) {
    return true;
  }
  if (/\b(?:is|was|does|did)\s+(?:that|this|it)\s+(?:look\s+)?(?:correct|right)\?\s*$/i.test(question)) {
    return true;
  }
  // Live providers often bundle two closed confirmations into one foreground
  // ask. Admit only that structural form: a leading confirmation bundle, at
  // least two numbered clauses, and an explicit yes/correction escape. Merely
  // mentioning a "correct recipient" or "confirmation email" is a slot ask,
  // not yes/no authority.
  if (
    /^two\s+(?:quick\s+)?confirmations?\s+before\s+i\b/i.test(question)
    && /\(\s*1\s*\)[\s\S]+?\byes\?[\s\S]+?\(\s*2\s*\)/i.test(question)
    && /\(\s*2\s*\)[\s\S]+?\bi(?:['’]ll|\s+will)\b[\s\S]+?unless\s+you\s+want\s+(?:a\s+)?different\s+one\b/i.test(question)
  ) {
    return true;
  }
  return false;
}

/** Classify B only relative to the exact durable clarification. This is
 * deliberately conservative: context may improve retrieval, but an ambiguous
 * control phrase never resolves an open slot or inherits A's authority. */
export function classifyClarificationAnswer(
  value: string,
  pause: TaskContinuityPacket['pause'],
): ClarificationAnswerClassification | null {
  const answer = normalized(value);
  if (!answer || answer.length > ANSWER_MAX_CHARS) return null;
  if (answer.split(/\s+/).length > ANSWER_MAX_WORDS) return null;
  // The explicit compound grammar only revokes the parent task's authority;
  // it never grants or inherits it. Exact durable adjacency plus an explicit
  // cancellation and independent fresh clause are sufficient, regardless of
  // whether the provider phrased the preceding question as “Do you want…” or
  // the conversational “Want me…?”.
  const compoundDecline = declinedParentWithNewTask(answer);
  if (compoundDecline) return compoundDecline;
  if (EXPLICIT_DECLINE_RE.test(answer)) return { disposition: 'declined' };
  if (EXPLICIT_AFFIRM_RE.test(answer)) {
    return questionAcceptsConfirmation(pause) ? { disposition: 'affirmed' } : null;
  }
  // A control followed by another clause is a fresh conversational turn, not
  // a low-information answer ("No, but send it to Alice instead").
  if (/^(?:no|nope|nah|yes|yep|yeah|ok|okay|sure|continue|proceed|go ahead)\b/i.test(answer)) return null;
  // A literal is safe only when Q explicitly opens that TYPE of slot. An email
  // or #channel pasted after "Should I delete it?" is a fresh turn, not an
  // answer that may inherit destructive authority.
  if (typedLiteralKind(answer)) {
    return literalAnswerFitsQuestion(answer, pause)
      ? { disposition: 'provided' }
      : null;
  }
  if (/^(?:(?:the\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth)|[1-8])(?:\s+(?:one|option|choice))?[.!]*$/i.test(answer)) {
    return null;
  }
  if (/\b(?:and|also|but|instead|unrelated|new task|while you(?:'re| are) at it)\b/i.test(answer)) return null;
  if (/[?;]/.test(answer)) return null;
  // A question invites a slot answer because of its SHAPE, not its vocabulary.
  //
  // The interrogative list below is genuine evidence, but it can only ever be a
  // list. Live 2026-08-09: "Want me to just draft check-ins for those 2, or did
  // you mean a different/broader group?" contains none of these fifteen words,
  // so "Just the 2 with past due ops" classified as null, the pending packet
  // was dismissed as a topic change, and the answered turn re-derived the task
  // from scratch with consequential:false.
  //
  // A DISJUNCTIVE question — alternatives offered with "or", ending in "?" — is
  // structurally an invitation to choose, whichever interrogative it happens to
  // use. That property holds for phrasings nobody has enumerated, which is the
  // point: the previous rule failed on ordinary English, not on an exotic case.
  const questionNamesASlot = /\b(?:which|what|where|when|who|whose|how many|account|workspace|tenant|date|time|destination|option|one)\b/i
    .test(pause.question);
  const questionOffersAlternatives = /\bor\b/i.test(pause.question) && /\?/.test(pause.question);
  const questionInvitesSlot = questionNamesASlot || questionOffersAlternatives;
  if (!questionInvitesSlot || answer.length > 120 || answer.split(/\s+/).length > 8) return null;
  return classifyMessageIntent(answer).intent === 'tool_intent'
    ? { disposition: 'provided' }
    : null;
}

export function isLowInformationClarificationAnswer(
  value: string,
  pause: TaskContinuityPacket['pause'],
): boolean {
  return classifyClarificationAnswer(value, pause) !== null;
}

/** Deterministic authority/routing capsule. Q and B are never truncated: Q can
 * carry corrected provider, target, account, or recipient facts. A is likewise
 * lossless: a consequential send/delete clause may occur anywhere, and no
 * positional projection can safely decide which parent bytes grant semantics. */
export function canonicalClarificationTaskInput(input: {
  parentInput: string;
  question: string;
  answer: string;
}): string | null {
  const parentInput = normalized(input.parentInput);
  if (!parentInput || parentInput.length > MAX_CLARIFICATION_PARENT_CHARS) return null;
  return [
    '[task-continuation:v2]',
    '[parent-task]',
    parentInput,
    '[clarifying-question]',
    normalized(input.question),
    '[user-answer]',
    normalized(input.answer),
  ].join('\n').trim();
}

function buildRetrievalQuery(parentInput: string, question: string, answer: string): string | null {
  return canonicalClarificationTaskInput({ parentInput, question, answer });
}

function retrievalQueryForClassification(
  parentInput: string,
  question: string,
  answer: string,
  classification: ClarificationAnswerClassification,
): string | null {
  if (classification.disposition === 'declined_with_new_task') {
    return normalized(classification.activeTaskInput) || null;
  }
  // A decline closes the old task and must not keep A's effect semantics in
  // the frozen canonical hash. Every inheriting disposition uses exact A/Q/B.
  if (classification.disposition === 'declined') return normalized(answer) || null;
  return buildRetrievalQuery(parentInput, question, answer);
}

function frozenResolutionFor(input: {
  parentInput: string;
  question: string;
  answer: string;
  classification: ClarificationAnswerClassification;
}): TaskContinuityFrozenResolution | null {
  const semanticInput = retrievalQueryForClassification(
    input.parentInput,
    input.question,
    input.answer,
    input.classification,
  );
  if (!semanticInput) return null;
  return {
    resolverVersion: CLARIFICATION_RESOLVER_VERSION,
    disposition: input.classification.disposition,
    ...(input.classification.selectedOption
      ? { selectedOption: input.classification.selectedOption }
      : {}),
    ...(input.classification.activeTaskInput
      ? { activeTaskInput: input.classification.activeTaskInput }
      : {}),
    semanticInputHash: createHash('sha256').update(semanticInput, 'utf8').digest('hex'),
  };
}

function clarificationContextFromPacket(input: {
  sessionId: string;
  sourceUserSeq: number;
  answer: string;
  packet: TaskContinuityPacket;
  frozenResolution: TaskContinuityFrozenResolution;
}): TaskContinuationContext | null {
  if (
    input.packet.sessionId !== input.sessionId
    || input.packet.pause.kind !== 'clarification'
  ) return null;
  const parent = realAcceptedSource(input.sessionId, input.packet.originatingSourceUserSeq);
  const parentInput = normalized(parent?.data.text);
  if (!parentInput || parentInput.length > MAX_CLARIFICATION_PARENT_CHARS) return null;
  const classification: ClarificationAnswerClassification = {
    disposition: input.frozenResolution.disposition,
    ...(input.frozenResolution.selectedOption
      ? { selectedOption: input.frozenResolution.selectedOption }
      : {}),
    ...(input.frozenResolution.activeTaskInput
      ? { activeTaskInput: input.frozenResolution.activeTaskInput }
      : {}),
  };
  const frozenResolution = frozenResolutionFor({
    parentInput,
    question: input.packet.pause.question,
    answer: input.answer,
    classification,
  });
  if (
    !frozenResolution
    || input.frozenResolution.disposition !== frozenResolution.disposition
    || input.frozenResolution.selectedOption !== frozenResolution.selectedOption
    || input.frozenResolution.activeTaskInput !== frozenResolution.activeTaskInput
    || input.frozenResolution.resolverVersion !== CLARIFICATION_RESOLVER_VERSION
    || input.frozenResolution.semanticInputHash !== frozenResolution.semanticInputHash
  ) return null;
  const retrievalQuery = retrievalQueryForClassification(
    parentInput,
    input.packet.pause.question,
    input.answer,
    classification,
  );
  if (!retrievalQuery) return null;
  return {
    packetId: input.packet.packetId,
    parentSourceUserSeq: input.packet.originatingSourceUserSeq,
    consumingSourceUserSeq: input.sourceUserSeq,
    parentInput,
    question: input.packet.pause.question,
    options: [...input.packet.pause.options],
    answer: input.answer,
    ...classification,
    retrievalQuery,
    capabilities: [...input.packet.capabilities],
  };
}

/** Reconstruct a closed clarification edge without mutating packet state.
 * Graph/replay validation uses this after the resolver's one logical consume. */
export function rehydrateConsumedClarificationContext(input: {
  sessionId: string;
  sourceUserSeq: number;
  answer: string;
}): TaskContinuationContext | null {
  const consumed = readConsumedTaskContinuityPacket({
    sessionId: input.sessionId,
    consumingSourceUserSeq: input.sourceUserSeq,
  });
  if (consumed.status !== 'consumed') return null;
  return clarificationContextFromPacket({
    ...input,
    packet: consumed.packet,
    frozenResolution: consumed.resolution,
  });
}

/** A graph continuation is authoritative only when every semantic field is
 * reproducible from the exact consumed packet and its A/Q/B source events.
 * Capability rows are deliberately omitted from this comparison: the bridge
 * narrows them against live connection/schema state after packet consumption. */
export function verifyDurableClarificationContext(input: {
  sessionId: string;
  sourceUserSeq: number;
  answer: string;
  context: TaskContinuationContext;
}): TaskContinuationContext | null {
  const durable = rehydrateConsumedClarificationContext(input);
  if (!durable) return null;
  const candidate = input.context;
  if (
    candidate.packetId !== durable.packetId
    || candidate.parentSourceUserSeq !== durable.parentSourceUserSeq
    || candidate.consumingSourceUserSeq !== durable.consumingSourceUserSeq
    || candidate.parentInput !== durable.parentInput
    || candidate.question !== durable.question
    || candidate.answer !== durable.answer
    || candidate.disposition !== durable.disposition
    || candidate.activeTaskInput !== durable.activeTaskInput
    || candidate.selectedOption !== durable.selectedOption
    || candidate.retrievalQuery !== durable.retrievalQuery
    || candidate.options.length !== durable.options.length
    || candidate.options.some((option, index) => option !== durable.options[index])
  ) return null;
  return durable;
}

function nextRealSourceIs(input: {
  sessionId: string;
  originatingSourceUserSeq: number;
  consumingSourceUserSeq: number;
}): boolean {
  const next = listEvents(input.sessionId, {
    sinceSeq: input.originatingSourceUserSeq,
    types: ['user_input_received'],
  }).find((event) => event.role === 'user' && event.data.synthetic !== true);
  return next?.seq === input.consumingSourceUserSeq;
}

function consumeContinuationContext(input: {
  sessionId: string;
  sourceUserSeq: number;
  answer: string;
}): TaskContinuationContext | null {
  const lookup = peekTaskContinuityPacket({ sessionId: input.sessionId });
  if (lookup.status !== 'available') {
    const replay = readConsumedTaskContinuityPacket({
      sessionId: input.sessionId,
      consumingSourceUserSeq: input.sourceUserSeq,
    });
    if (replay.status !== 'consumed') return null;
    return clarificationContextFromPacket({
      ...input,
      packet: replay.packet,
      frozenResolution: replay.resolution,
    });
  }
  const packet = lookup.packet;
  if (packet.pause.kind !== 'clarification') {
    dismissTaskContinuityPacket({ sessionId: input.sessionId, reason: 'invalidated' });
    return null;
  }
  const classification = classifyClarificationAnswer(input.answer, packet.pause);
  if (!classification) {
    if (nextRealSourceIs({
      sessionId: input.sessionId,
      originatingSourceUserSeq: packet.originatingSourceUserSeq,
      consumingSourceUserSeq: input.sourceUserSeq,
    })) {
      dismissTaskContinuityPacket({ sessionId: input.sessionId, reason: 'topic_changed' });
    }
    return null;
  }
  const parentInput = normalized(realAcceptedSource(
    input.sessionId,
    packet.originatingSourceUserSeq,
  )?.data.text);
  if (!parentInput || parentInput.length > MAX_CLARIFICATION_PARENT_CHARS) return null;
  const resolution = frozenResolutionFor({
    parentInput,
    question: packet.pause.question,
    answer: input.answer,
    classification,
  });
  if (!resolution) return null;
  const consumed = consumeTaskContinuityPacket({
    sessionId: input.sessionId,
    consumingSourceUserSeq: input.sourceUserSeq,
    resolution,
  });
  if (consumed.status !== 'consumed') return null;
  return clarificationContextFromPacket({
    ...input,
    packet: consumed.packet,
    frozenResolution: consumed.resolution,
  });
}

function accountEvidenceStillFits(row: TaskContinuityCapabilityEvidence): boolean {
  if (row.kind !== 'composio') return true;
  let registry: ReturnType<typeof peekConnectedToolkits> = [];
  try { registry = peekConnectedToolkits(); } catch { return false; }
  if (registry.length === 0) return !row.accountIdentity;
  const toolkit = registeredToolkitOfSlug(row.identifier).toLowerCase();
  const live = registry.filter((entry) => entry.slug.toLowerCase() === toolkit && /active/i.test(entry.status));
  if (live.length === 0) return false;
  if (!row.accountIdentity) return true;
  const wanted = normalizedKey(row.accountIdentity);
  return live.some((entry) => [
    entry.connectionId,
    entry.accountEmail,
    entry.accountLabel,
    entry.accountName,
    entry.alias,
    entry.wordId,
  ].some((value) => normalizedKey(value ?? '') === wanted));
}

function validInheritedEvidence(
  context: TaskContinuationContext,
): TaskContinuityCapabilityEvidence[] {
  if (context.disposition === 'declined' || context.disposition === 'declined_with_new_task') return [];
  const requestedEffect = requestedCapabilityEffectScope(context.parentInput);
  return context.capabilities.filter((row) => {
    if (!capabilityEffectIsCompatible(requestedEffect, row.effectClass)) return false;
    if (!accountEvidenceStillFits(row)) return false;
    if (row.kind === 'composio' && row.schemaFingerprint) {
      const live = liveComposioSchemaFingerprint(row.identifier);
      if (live && live !== row.schemaFingerprint) return false;
    }
    return row.evidenceKind !== 'discovered' || Boolean(row.schemaFingerprint);
  }).slice(0, MAX_CONTINUITY_CANDIDATES);
}

function inheritedCandidates(
  context: TaskContinuationContext,
  evidence: readonly TaskContinuityCapabilityEvidence[],
): TurnCapabilityCandidates {
  const candidates: CapabilityCandidate[] = evidence.map((row) => ({
    identifier: row.identifier,
    kind: row.kind,
    intent: context.parentInput.slice(0, 240),
    klass: 'capability_only',
    ...(row.accountIdentity ? { accountIdentity: row.accountIdentity } : {}),
    via: 'exact',
    score: 1,
    effectClass: row.effectClass,
  }));
  return {
    candidates,
    requirements: [],
    matches: [],
    pinnedTools: [...new Set(evidence.flatMap((row) =>
      row.kind === 'composio' ? ['composio_execute_tool'] : [row.identifier]))],
    semanticApplied: false,
  };
}

function mergeCandidates(
  first: TurnCapabilityCandidates,
  second: TurnCapabilityCandidates,
): TurnCapabilityCandidates {
  const candidates = new Map<string, CapabilityCandidate>();
  for (const candidate of [...first.candidates, ...second.candidates]) {
    const key = `${candidate.kind}:${candidate.identifier}:${candidate.accountIdentity ?? ''}`;
    if (!candidates.has(key)) candidates.set(key, candidate);
  }
  const requirements = new Map<string, TurnCapabilityCandidates['requirements'][number]>();
  for (const requirement of [...first.requirements, ...second.requirements]) {
    const current = requirements.get(requirement.roleKey);
    if (!current || (!current.resolved && requirement.resolved)) {
      requirements.set(requirement.roleKey, requirement);
    }
  }
  return {
    candidates: [...candidates.values()].slice(0, MAX_CONTINUITY_CANDIDATES),
    requirements: [...requirements.values()],
    matches: [...first.matches, ...second.matches].slice(0, MAX_CONTINUITY_CANDIDATES),
    pinnedTools: [...new Set([...first.pinnedTools, ...second.pinnedTools])],
    semanticApplied: first.semanticApplied || second.semanticApplied,
    roleScopedDiscovery: first.roleScopedDiscovery === true || second.roleScopedDiscovery === true
      ? true
      : first.roleScopedDiscovery === false || second.roleScopedDiscovery === false
        ? false
        : undefined,
  };
}

/** Re-derive every private field from durable exact-source state. Caller-
 * supplied semanticTaskInput/taskContinuation values are never trusted. */
export async function enrichAcceptedRequestWithTaskContinuity(
  request: AssistantRequest,
  sourceUserSeq: number,
  options: { continuationOnly?: boolean } = {},
): Promise<AssistantRequest> {
  const accepted = realAcceptedSource(request.sessionId, sourceUserSeq);
  const acceptedText = typeof accepted?.data.text === 'string' ? accepted.data.text : '';
  const suppliedText = request.displayMessage ?? request.message;
  // Source authority is byte-exact. Whitespace-equivalent caller text is not
  // enough to inherit private context or capability evidence.
  if (
    !accepted
    || !acceptedText.trim()
    || acceptedText !== suppliedText
    || (request.sourceUserSeq !== undefined && request.sourceUserSeq !== sourceUserSeq)
  ) {
    const {
      semanticTaskInput: _semantic,
      taskContinuation: _context,
      taskContinuationResolved: _resolved,
      ...safe
    } = request;
    return safe;
  }
  const context = consumeContinuationContext({
    sessionId: request.sessionId,
    sourceUserSeq,
    answer: acceptedText,
  });
  if (!context && options.continuationOnly) {
    const { semanticTaskInput: _semantic, taskContinuation: _context, ...safe } = request;
    return { ...safe, taskContinuationResolved: true };
  }
  // A decline still benefits from private conversational context, but it must
  // not reacquire or inherit the parent task's execution surface.
  const query = context?.disposition === 'declined'
    ? acceptedText
    : context?.disposition === 'declined_with_new_task'
      ? context.activeTaskInput ?? context.retrievalQuery
      : context?.retrievalQuery ?? request.message;
  let resolved: TurnCapabilityCandidates = {
    candidates: [], requirements: [], matches: [], pinnedTools: [], semanticApplied: false,
  };
  // A decline is already a complete answer to the exact durable question. It
  // needs conversational context, not another semantic/capability search. Even
  // a literal "No" lookup is wasted work and can match generic historical
  // aliases, so leave the candidate surface empty rather than merely changing
  // the query from A/Q/B to B.
  if (context?.disposition !== 'declined') {
    try { resolved = await resolveTurnCapabilityCandidates({ userInput: query }); } catch { /* advisory only */ }
  }
  if (!context) {
    const { semanticTaskInput: _semantic, taskContinuation: _context, ...safe } = request;
    return {
      ...safe,
      taskContinuationResolved: true,
      turnCandidates: mergeCandidates(request.turnCandidates ?? resolved, resolved),
    };
  }
  const evidence = validInheritedEvidence(context);
  const inherited = inheritedCandidates(context, evidence);
  // Only resolved/settled capability evidence is execution-proven. Discovery
  // results stay advisory and retain B's own one-broad-search allowance.
  const proven = evidence.some((row) => row.evidenceKind === 'resolved' || row.evidenceKind === 'settled');
  if (proven) {
    try {
      discoveryGovernor.initializeTask({
        sessionId: request.sessionId,
        sourceUserSeq,
        knownCapability: true,
      });
    } catch { /* governor will initialize normally at capability preflight */ }
  }
  return {
    ...request,
    // Preserve the full A/Q/B capsule below for conversation continuity, but a
    // decline's semantic query is literal B. Downstream preflight/recall must
    // never rediscover or warm the parent action after the user cancelled it.
    semanticTaskInput: query,
    taskContinuation: { ...context, capabilities: evidence },
    taskContinuationResolved: true,
    turnCandidates: context.disposition === 'declined'
      || context.disposition === 'declined_with_new_task'
      ? resolved
      : mergeCandidates(inherited, mergeCandidates(request.turnCandidates ?? resolved, resolved)),
  };
}
