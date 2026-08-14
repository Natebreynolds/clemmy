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
  actionLabel: 'email' | 'message' | 'post' | 'send';
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
const RECIPIENT_KEY_RE = /^(?:to|cc|bcc)(?:recipients?|emails?|addresses|list)?$|^recipients?(?:emails?|list)?$/;
const SENDER_KEY_RE = /^(?:from|sender|replyto|returnpath|onbehalfof)(?:email|emails|address|addresses)?$/;
const SUBJECT_KEY_RE = /^(?:subject|emailsubject|messagesubject)$/;
const BODY_KEY_RE = /^(?:body|htmlbody|textbody|emailbody|messagebody|content)$/;
const BODY_OBJECT_VALUE_KEY_RE = /^(?:htmlbody|textbody|emailbody|messagebody|content)$/;
const JSON_WRAPPER_KEY_RE = /^(?:arguments?|args|argsjson|payload|input|parameters?|request|data)$/;

interface PayloadDetails {
  recipients: string[];
  subjects: string[];
  bodies: string[];
  urls: string[];
  invalidSubject: boolean;
  invalidBody: boolean;
  traversalUncertain: boolean;
}

function payloadDetails(value: unknown): PayloadDetails {
  const recipients = new Set<string>();
  const subjects = new Set<string>();
  const bodies = new Set<string>();
  const urls = new Set<string>();
  let invalidSubject = false;
  let invalidBody = false;
  let traversalUncertain = false;

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
  };
}

function preferredResultUrl(urls: string[]): string | null {
  return urls.find((url) => /docs\.google\.com|drive\.google\.com|sheets?/i.test(url))
    ?? urls[0]
    ?? null;
}

function actionLabel(toolName: string, shapeKey: string | undefined): AutonomousSendConsent['actionLabel'] {
  const action = `${shapeKey ?? ''} ${toolName}`;
  if (/EMAIL/i.test(action)) return 'email';
  if (/POST|PUBLISH|TWEET/i.test(action)) return 'post';
  if (/MESSAGE|SLACK|\bDM\b/i.test(action)) return 'message';
  return 'send';
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
  // Conversational consent is intentionally narrower than a formal card. A
  // single canonical email recipient is reviewable in one sentence; multiple
  // recipients, or an inferred targetSummary, keep the richer formal surface.
  const target = details.recipients.length === 1 ? details.recipients[0] : '';
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

  // An email question that cannot name its exact destination and subject is
  // not reviewable enough for a bare yes/no reply. Keep the formal card.
  if (label !== 'email' || !target || !subject || !bodyPreview) return null;

  const resultUrl = preferredResultUrl(details.urls);
  const resultLine = resultUrl
    ? `I’ve got what you needed — here’s the result: ${resultUrl}`
    : 'I’ve finished the reversible work and prepared the last step.';
  const subjectText = subject ? ` with subject **${subject}**` : '';
  const question = [
    resultLine,
    `The exact email is ready for **${target}**${subjectText}. Do you want me to send it? Reply **yes** to send this exact version or **no** to leave it unsent.`,
    `Preview: ${bodyPreview}`,
  ].join('\n\n');

  return { question, actionLabel: label, target, subject, bodyPreview, resultUrl };
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
