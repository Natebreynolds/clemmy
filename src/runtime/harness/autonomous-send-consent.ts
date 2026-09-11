import { loadProactivityPolicy } from '../../agents/proactivity-policy.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import {
  pendingActionApprovalViewFromArgs,
  type PendingActionApprovalView,
} from './pending-action-view.js';
import {
  exactOriginDeliveryTargetDigest,
  normalizeExactOriginDeliveryTarget,
} from '../exact-origin-delivery.js';
import { redactSensitiveText } from '../security.js';
import type { EventRow } from './eventlog.js';
import type { NewConversationalApprovalPresentation } from './approval-registry.js';

/**
 * Autonomous mode still needs a fresh human decision at the irreversible-send
 * boundary. The decision is conversational, while the durable approval row
 * remains the hidden, frozen execution capability used by the exact-once
 * resume path.
 */
export interface AutonomousSendConsent {
  question: string;
  /** The operation's own word for what is being written ("event", "record",
   *  "email"), derived at runtime. Deliberately NOT a closed enum: a fixed set
   *  is a list of services the harness has heard of, and the point is that it
   *  needs to have heard of none of them. */
  actionLabel: string;
  target: string;
  subject: string | null;
  bodyPreview: string | null;
  resultUrl: string | null;
}

function conversationalConsentEnabled(): boolean {
  const flag = (process.env.CLEMMY_AUTONOMOUS_CONVERSATIONAL_CONSENT ?? 'on').trim().toLowerCase();
  if (['off', 'false', '0', 'no'].includes(flag)) return false;
  try {
    return loadProactivityPolicy().autoApproveScope === 'yolo';
  } catch {
    return false;
  }
}

function parseJsonWrapper(value: string): { parsed: boolean; invalid: boolean; value: unknown } {
  const trimmed = value.trim();
  const startsStructured = trimmed.startsWith('{') || trimmed.startsWith('[');
  const endsStructured = trimmed.endsWith('}') || trimmed.endsWith(']');
  if (!startsStructured && !endsStructured) return { parsed: false, invalid: false, value };
  if (trimmed.length > 200_000 || !startsStructured || !endsStructured) {
    return { parsed: false, invalid: true, value };
  }
  try {
    return { parsed: true, invalid: false, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { parsed: false, invalid: true, value };
  }
}

function cleanInline(value: string, max = 240): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizePayloadTextCandidate(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /https?:\/\/[^\s<>"'\\]+/gi;
/**
 * The people a write is addressed to. These are ROLE words — the generic names
 * for "who receives this" — not the name of any product or channel. An invite
 * addresses attendees, a thread addresses participants, a message addresses
 * recipients; all three are the same question to a person reviewing it, and
 * only the first of them used to count. Live 2026-09-11: a calendar invite
 * naming exactly one attendee had, by this regex, no recipient at all, so it
 * could not be described in one line no matter how simple it was.
 */
const RECIPIENT_KEY_RE = /^(?:to|cc|bcc)(?:recipients?|emails?|addresses|list)?$|^(?:recipients?|attendees?|participants?|invitees?|guests?|assignees?|members?)(?:info|emails?|addresses|list)?$/;
const SENDER_KEY_RE = /^(?:from|sender|replyto|returnpath|onbehalfof)(?:email|emails|address|addresses)?$/;
const SUBJECT_KEY_RE = /^(?:subject|emailsubject|messagesubject)$/;
const BODY_KEY_RE = /^(?:body|htmlbody|textbody|emailbody|messagebody|content)$/;
const BODY_OBJECT_VALUE_KEY_RE = /^(?:htmlbody|textbody|emailbody|messagebody|content)$/;
const JSON_WRAPPER_KEY_RE = /^(?:arguments?|args|argsjson|payload|input|parameters?|request|data)$/;
/**
 * Keys that say WHERE a write lands, for operations that address a container
 * rather than a person. These are data-model words — a thing with an id, a
 * place with a path — not the name of any product: `*id`/`*key`/`*ref`
 * covers whatever a given service calls its container, so a service nobody
 * has heard of addresses its destination through the same door as one
 * everybody has.
 */
const DESTINATION_KEY_RE = /^(?:destination|target|channel|folder|path|url|link|parent|location|calendar|list|board|collection|space|room|repository|table|database|sheet|document|file|page|record|item|thread|conversation|event|issue|task|ticket)(?:id|key|ref|name)?$|(?:id|key|ref)$/;

interface PayloadDetails {
  recipients: string[];
  subjects: string[];
  bodies: string[];
  urls: string[];
  invalidSubject: boolean;
  invalidBody: boolean;
  traversalUncertain: boolean;
  /** Scalar arguments the call actually named, as `key=value`, in traversal
   *  order. Shape-neutral: whatever fields this operation has are what a human
   *  gets to review. This is what lets a record, an invite or a row be judged
   *  in one line without the harness knowing any of those words. */
  salient: string[];
  /** Where the write lands when it addresses a container rather than a person.
   *  A write with no recipient is not a write with no destination. */
  destinations: string[];
}

function payloadDetails(value: unknown): PayloadDetails {
  const recipients = new Set<string>();
  const subjects = new Set<string>();
  const bodies = new Set<string>();
  const urls = new Set<string>();
  const destinations = new Map<string, string>();
  const salient = new Map<string, string>();

  const collectDestination = (key: string | null, rendered: string): void => {
    const normalized = (key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized || destinations.size >= 4) return;
    if (JSON_WRAPPER_KEY_RE.test(normalized) || !DESTINATION_KEY_RE.test(normalized)) return;
    const value = cleanInline(rendered, 120);
    if (!value) return;
    if (!destinations.has(normalized)) destinations.set(normalized, value);
  };
  let invalidSubject = false;
  let invalidBody = false;
  let traversalUncertain = false;

  const collectSalient = (key: string | null, rendered: string): void => {
    const name = (key ?? '').trim();
    if (!name || salient.size >= 8) return;
    // Structural plumbing is not review material, and a value long enough to
    // hide something is not reviewable in one line either.
    if (JSON_WRAPPER_KEY_RE.test(name.toLowerCase().replace(/[^a-z0-9]/g, ''))) return;
    const value = cleanInline(rendered, 80);
    if (!value) return;
    const line = redactSensitiveText(`${name}=${value}`).slice(0, 96);
    if (!salient.has(name)) salient.set(name, line);
  };

  const collectUrls = (input: string): void => {
    for (const match of input.matchAll(URL_RE)) urls.add(match[0].replace(/[),.;]+$/g, ''));
  };

  const visit = (input: unknown, keyHint: string | null, depth: number, inRecipient = false): void => {
    if (depth > 12) {
      traversalUncertain = true;
      return;
    }
    const normalizedKey = (keyHint ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const subjectKey = SUBJECT_KEY_RE.test(normalizedKey);
    const bodyKey = BODY_KEY_RE.test(normalizedKey);

    // Candidate fields are frozen provider data, not JSON wrappers. Preserve
    // literal JSON-looking strings and fail closed on null/non-string values.
    if (subjectKey) {
      if (typeof input !== 'string') {
        invalidSubject = true;
        return;
      }
      subjects.add(normalizePayloadTextCandidate(input));
      collectUrls(input);
      return;
    }
    if (bodyKey && normalizedKey !== 'body') {
      if (typeof input !== 'string') {
        invalidBody = true;
        return;
      }
      bodies.add(normalizePayloadTextCandidate(input));
      collectUrls(input);
      return;
    }
    if (bodyKey && normalizedKey === 'body' && typeof input === 'string') {
      bodies.add(normalizePayloadTextCandidate(input));
      collectUrls(input);
      return;
    }
    if (bodyKey && normalizedKey === 'body') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        invalidBody = true;
        return;
      }
      const entries = Object.entries(input as Record<string, unknown>);
      if (!entries.some(([key]) => BODY_OBJECT_VALUE_KEY_RE.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
        invalidBody = true;
      }
      for (const [key, child] of entries) visit(child, key, depth + 1, inRecipient);
      return;
    }

    if (input === null || input === undefined) return;
    if (typeof input === 'string') {
      if (keyHint === null || JSON_WRAPPER_KEY_RE.test(normalizedKey)) {
        const wrapper = parseJsonWrapper(input);
        if (wrapper.invalid) {
          traversalUncertain = true;
          return;
        }
        if (wrapper.parsed) {
          visit(wrapper.value, keyHint, depth + 1, inRecipient);
          return;
        }
      }
      if (inRecipient || RECIPIENT_KEY_RE.test(normalizedKey)) {
        const matches = [...input.matchAll(EMAIL_RE)];
        for (const match of matches) recipients.add(match[0].toLowerCase());
        // A direct flat recipient field may contain a provider id/phone-like
        // destination. Nested Graph metadata (display name, type, label) must
        // never become a target merely because it lives beside address.
        if (!inRecipient && RECIPIENT_KEY_RE.test(normalizedKey) && matches.length === 0 && input.trim()) {
          recipients.add(cleanInline(input, 180));
        }
      }
      collectUrls(input);
      collectDestination(keyHint, input);
      collectSalient(keyHint, input);
      return;
    }
    if (typeof input === 'number' || typeof input === 'boolean') {
      collectSalient(keyHint, String(input));
      return;
    }
    if (Array.isArray(input)) {
      for (const child of input) visit(child, keyHint, depth + 1, inRecipient);
      return;
    }
    if (typeof input !== 'object') return;
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      const childKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const sender = SENDER_KEY_RE.test(childKey);
      visit(child, key, depth + 1, !sender && (inRecipient || RECIPIENT_KEY_RE.test(childKey)));
    }
  };

  visit(value, null, 0);
  return {
    recipients: [...recipients],
    subjects: [...subjects],
    bodies: [...bodies],
    urls: [...urls],
    invalidSubject,
    invalidBody,
    traversalUncertain,
    salient: [...salient.values()],
    destinations: [...destinations.values()],
  };
}

/** The first URL the call itself produced. This used to rank a named vendor's
 *  document hosts first — the same hardcoded-noun habit as the label above, and
 *  just as wrong: it made one company's links "the result" and everyone else's
 *  second. Order of appearance is the operation's own answer. */
function preferredResultUrl(urls: string[]): string | null {
  return urls[0] ?? null;
}

/** Verbs an operation name uses to say WHAT it does. They are the boundary of
 *  the noun we want, never the noun itself. */
const OPERATION_VERB_RE = /^(?:create|send|post|publish|add|insert|new|update|patch|put|delete|remove|upsert|write|invite|share|schedule|book|execute|run|submit|append)$/;
/** Structural filler that carries no meaning for a human reading one line. */
const OPERATION_FILLER_RE = /^(?:a|an|the|to|for|with|by|of|in|on|v\d+|api|tool|action|operation)$/;

/**
 * Name the thing being written, in the operation's OWN words.
 *
 * This used to ask which product the call belonged to, by matching a regex of
 * vendor and channel nouns held in the harness. Every new service needed a new
 * branch, and any service without one got no conversational consent at all. An operation
 * already says what it acts on; read that instead. `*_CREATE_EVENT` is an
 * "event", `*_CREATE_RECORD` a "record", `*_SEND_EMAIL` an "email" — with no
 * vendor, verb list, or tool catalogue held in the harness.
 *
 * Falls back to the neutral 'send' when the operation names no object, so an
 * unreadable name degrades to a correct generic word rather than a wrong one.
 */
export function actionLabel(toolName: string, shapeKey: string | undefined): string {
  const source = `${shapeKey ?? ''} ${toolName}`;
  const tokens = source
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 1 && !OPERATION_FILLER_RE.test(token));
  // The object is what trails the last verb: CREATE_CALENDAR_EVENT -> "event".
  const lastVerb = tokens.map((token) => OPERATION_VERB_RE.test(token)).lastIndexOf(true);
  const object = lastVerb >= 0 ? tokens.slice(lastVerb + 1) : [];
  const noun = object.at(-1) ?? '';
  return noun && noun.length <= 24 ? noun : 'send';
}

function suppliedPendingAction(
  args: unknown,
  pendingAction?: Partial<PendingActionApprovalView> | null,
): Partial<PendingActionApprovalView> | undefined {
  if (pendingAction && typeof pendingAction === 'object') return pendingAction;
  return pendingActionApprovalViewFromArgs(args);
}

/**
 * Return the ordinary exact-action question for one frozen irreversible send.
 * Anything uncertain (non-autonomous policy, batch, destructive request,
 * missing email recipient/subject, unknown effect) returns null and therefore
 * keeps the existing formal approval surface.
 */
export function autonomousSendConsent(
  toolName: string,
  args: unknown,
  pendingAction?: Partial<PendingActionApprovalView> | null,
): AutonomousSendConsent | null {
  if (!conversationalConsentEnabled()) return null;
  const topArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  if (topArgs.destructive === true) return null;

  const pending = suppliedPendingAction(args, pendingAction);
  if (pending && pending.kind !== 'external_send') return null;
  const exactTool = typeof pending?.toolName === 'string' && pending.toolName.trim()
    ? pending.toolName.trim()
    : toolName;
  const exactPayload = pending?.payload ?? args;
  // Batches retain the explicit multi-action card and its independent sibling
  // decisions. This conversational seam owns exactly one frozen provider call.
  if (exactTool === 'run_batch' || toolName === 'run_batch') return null;
  if (toolName === 'request_approval' && !pending) return null;

  const effect = classifyExternalWrite(exactTool, exactPayload);
  if (!effect.external || !effect.mutating || !effect.irreversible || !effect.classificationKnown) {
    return null;
  }

  const details = payloadDetails(exactPayload);
  if (details.invalidSubject || details.invalidBody || details.traversalUncertain) return null;
  const label = actionLabel(exactTool, effect.shapeKey);
  // Conversational consent is narrower than a formal card: it must name ONE
  // unambiguous place the write lands. That is a single recipient where the
  // operation addresses a person, and the single container it addresses
  // otherwise — a write with no recipient is not a write with no destination.
  // Several of either is genuinely a card, not a sentence.
  const target = details.recipients.length === 1
    ? details.recipients[0]
    : details.recipients.length === 0 && details.destinations.length === 1
      ? details.destinations[0]
      : '';
  const exactSubject = details.subjects.length === 1 ? details.subjects[0] : null;
  const subject = exactSubject && exactSubject.length <= 180 ? exactSubject : null;
  const pendingPreview = typeof pending?.preview === 'string'
    ? cleanInline(pending.preview, 360)
    : '';
  const bodyPreview = details.bodies.length === 1
    ? cleanInline(details.bodies[0], 360)
    : details.bodies.length === 0
      ? (pendingPreview || null)
      : null;

  // REVIEWABILITY, not product identity.
  //
  // This gate used to read `label !== 'email'`, plus an email-shaped subject
  // and body. Those three conditions meant only one kind of write could ever
  // get a one-line ask: a record, a calendar invite, a row, a task — none of
  // them carry a "body", so all of them fell to the formal card no matter how
  // plainly describable they were. Extending that by noun would mean carrying
  // a branch per service in a consent path, forever.
  //
  // The question a consent surface actually has to answer is not "which
  // product is this?" — the effect classifier above already settled that this
  // is an external, mutating, irreversible write, generically, by verb. It is
  // "can a person judge this in one sentence?" That needs exactly two things:
  // one unambiguous destination, and enough of the payload to recognise it.
  // Both are read from whatever fields the operation actually has.
  // AMBIGUITY fails closed, independently of shape. Several subject or body
  // candidates in one payload means a nested decoy or a wrapper the traversal
  // read twice, and there is no way to know which one a person would be saying
  // yes to. The old gate caught this only as a side effect of requiring
  // exactly one subject; that requirement is gone, so state the rule directly.
  if (details.subjects.length > 1 || details.bodies.length > 1) return null;
  // A COMPOSED MESSAGE must carry its header. This is a shape rule, not a
  // product rule: a payload with a body is something written to be read, and
  // "send this body" without naming what it is announces nothing a person can
  // judge in one sentence. A write with no body — a record, an invite, a row —
  // has no header to be missing and is described by what it does carry.
  if (bodyPreview && !subject) return null;
  const detail = describedPayload(subject, bodyPreview, details);
  if (!target || !detail) return null;

  const resultUrl = preferredResultUrl(details.urls);
  const resultLine = resultUrl
    ? `I’ve got what you needed — here’s the result: ${resultUrl}`
    : 'I’ve finished the reversible work and prepared the last step.';
  const question = [
    resultLine,
    `The exact ${label} is ready for **${target}** — ${detail}. Do you want me to go ahead? `
    + `Reply **yes** to send this exact version or **no** to leave it unsent.`,
  ].join('\n\n');

  return { question, actionLabel: label, target, subject, bodyPreview, resultUrl };
}

/**
 * One human-readable line describing what is about to be written, from
 * whichever fields this operation happens to carry.
 *
 * Prefers the operation's own subject/body when they exist (an email reads
 * best that way), and otherwise falls back to the salient scalar arguments the
 * call actually named. No field here is specific to a service: a record's
 * fields, an event's time, a task's title all arrive through the same door.
 * Returns null when nothing legible can be shown, which keeps the formal card.
 */
function describedPayload(
  subject: string | null,
  bodyPreview: string | null,
  details: PayloadDetails,
): string | null {
  if (subject && bodyPreview) return `subject **${subject}** — ${bodyPreview}`;
  if (subject) return `subject **${subject}**`;
  if (bodyPreview) return bodyPreview;
  const salient = details.salient.slice(0, 3);
  return salient.length > 0 ? salient.join(' · ') : null;
}

/** Freeze a conversational surface only when exact origin and audience are
 * already durable on the accepted source/session. Missing identity keeps the
 * existing formal approval card. */
export function autonomousSendConsentPresentation(
  toolName: string,
  args: unknown,
  pendingAction?: Partial<PendingActionApprovalView> | null,
  context?: { source: EventRow },
): NewConversationalApprovalPresentation | null {
  const consent = autonomousSendConsent(toolName, args, pendingAction);
  const source = context?.source;
  const originReplyTarget = normalizeExactOriginDeliveryTarget(source?.data.originReplyTarget);
  const originReplyTargetDigest = typeof source?.data.originReplyTargetDigest === 'string'
    ? source.data.originReplyTargetDigest
    : '';
  const audienceUserId = typeof source?.data.userId === 'string'
    ? source.data.userId.trim()
    : '';
  const conversationKey = typeof source?.data.conversationKey === 'string'
    ? source.data.conversationKey.trim()
    : '';
  if (
    !consent
    || !source
    || !originReplyTarget
    || !originReplyTargetDigest
    || exactOriginDeliveryTargetDigest(originReplyTarget) !== originReplyTargetDigest
    || !audienceUserId
    || !conversationKey
  ) return null;
  return {
    version: 1,
    kind: 'autonomous_send_consent',
    ...consent,
    sourceUserSeq: source.seq,
    originReplyTarget,
    originReplyTargetDigest,
    conversationKey,
    audienceUserId,
  };
}

/** Only unqualified answers bind to the frozen action. A qualified answer such
 * as "yes, but change the subject" falls through as a normal instruction and
 * cannot accidentally authorize the old payload. */
export function parseAutonomousSendConsentReply(text: string): 'approve' | 'reject' | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (/^(?:yes|yes please|yes[,]? that(?:'|’)?s all correct|yep|yeah|sure|go ahead|send it|please send(?: it)?|do it|proceed)$/.test(normalized)) {
    return 'approve';
  }
  if (/^(?:no|no thanks|not now|don'?t send(?: it)?|do not send(?: it)?|leave it unsent|skip it)$/.test(normalized)) {
    return 'reject';
  }
  return null;
}
