/**
 * Verified-read learning (F1 + F3).
 *
 * The existing auto-remember seam only learns a capability when the model has
 * just run a discovery search in the same session window. A cold turn where
 * the brain already knew the slug — the ordinary case — teaches nothing, so a
 * later paraphrase can retrieve nothing.
 *
 * This module closes that as a narrow, evidence-bound rule: ONE canonical
 * successful top-level READ settlement teaches the capability and an
 * accepted-source alias, through the EXISTING tool-choice/procedure store.
 * Retrieval built on it stays advisory (the brain still chooses); nothing here
 * authorizes dispatch, binds an account, or stores replayable arguments.
 *
 * Safety properties, each pinned by a black-box test:
 *
 *  - only a settled SUCCESS with real returned data learns — failures,
 *    queued/async receipts, empty or unverified payloads never do;
 *  - only READ-class effects learn; the sealed effect taxonomy decides, not a
 *    verb list;
 *  - the alias is bound to the EXACT accepted source ({sessionId,
 *    sourceUserSeq}), never "the latest message", so a newer foreground turn
 *    cannot be credited for an older/background tool call;
 *  - the stored alias is privacy-bounded: a normalized digest for exact
 *    repeats plus bounded distinctive terms, never unrestricted raw text;
 *  - no concrete argument value is ever stored as replayable state, so a
 *    resolved "tomorrow" date can never be replayed on a later turn.
 */

import {
  getActiveRunAttempt,
  getRunAttemptSourceUserEvent,
  listEvents,
} from '../runtime/harness/eventlog.js';
import { priorTurnEndedAwaitingClarification } from '../runtime/harness/convergence-steer.js';
import {
  acceptedPhraseDigest,
  boundedAliasTerms,
  claimAcceptedSourceForLearning,
  daemonAliasScope,
  recordCapabilityAlias,
  scheduleCapabilityAliasEmbedBackfill,
} from './capability-alias-index.js';
import type { ReceiptResolver } from './procedure-receipts.js';
import { rememberToolChoice, type ToolChoiceKind } from './tool-choice-store.js';

/** The canonical procedure slug for a dispatchable identifier. */
export function canonicalIntentSlug(identifier: string): string {
  const parts = identifier.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return '';
  const provider = parts[0]!;
  const operation = parts.slice(1).join('_') || 'operation';
  return `${provider}.${operation}`.slice(0, 80);
}

/**
 * Did this settlement return real, verified data? A success envelope with no
 * payload, an async job receipt, or an error shape is not evidence.
 */
export function settlementCarriesVerifiedData(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.successful === false || record.error) return false;
  const data = record.data ?? record.result ?? record.items;
  if (data === null || data === undefined) return false;
  if (typeof data === 'object') {
    const inner = data as Record<string, unknown>;
    // A queued receipt names a job, not an answer.
    if (typeof inner.status === 'string' && /queued|pending|running/i.test(inner.status)) return false;
    if (Array.isArray(data)) return data.length > 0;
    return Object.keys(inner).length > 0;
  }
  return String(data).trim().length > 0;
}

function eventText(data: unknown): string | undefined {
  const text = (data as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : undefined;
}

export type AcceptedSource = { sourceUserSeq: number; phrase: string };

/**
 * The INTENT-carrying phrase for a settlement that landed on an ANSWER turn.
 *
 * When the previous turn ended by asking the user a clarifying question
 * ("which of your three accounts?"), the turn that finally settles the read
 * carries only the answer ("use the first one") — an alias learned from that
 * would never retrieve anything. The same structural predicate the scope
 * resolvers already trust decides continuity, and the QUESTION turn's phrase
 * (the request that actually names the intent) becomes the alias source. The
 * exactly-once claim stays keyed on the settling turn, so a replay still
 * loses.
 */
function intentPhraseFor(sessionId: string, source: AcceptedSource): string {
  try {
    if (!priorTurnEndedAwaitingClarification(sessionId)) return source.phrase;
    const users = listEvents(sessionId, { types: ['user_input_received'] })
      .filter((event) => (event.data as { synthetic?: boolean } | undefined)?.synthetic !== true)
      .sort((a, b) => a.seq - b.seq);
    const index = users.findIndex((event) => event.seq === source.sourceUserSeq);
    if (index <= 0) return source.phrase;
    const previous = eventText(users[index - 1]!.data);
    return previous ?? source.phrase;
  } catch {
    return source.phrase;
  }
}

/**
 * The EXACT accepted source this settlement belongs to.
 *
 * When the caller knows the sequence (the harness run context carries it), that
 * exact event is the only candidate. Otherwise the session's LIVE run attempt
 * supplies it — the attempt row durably binds its own source_user_seq, so this
 * is still the turn that was accepted, never "whatever message arrived last".
 * A background call whose attempt has already finished resolves nothing and
 * therefore learns nothing.
 */
export function resolveAcceptedSource(
  sessionId: string,
  sourceUserSeq?: number,
): AcceptedSource | undefined {
  if (!sessionId) return undefined;
  try {
    if (typeof sourceUserSeq === 'number') {
      for (const event of listEvents(sessionId)) {
        if (event.seq !== sourceUserSeq) continue;
        if (event.type !== 'user_input_received') return undefined;
        const phrase = eventText(event.data);
        return phrase ? { sourceUserSeq, phrase } : undefined;
      }
      return undefined;
    }
    const attempt = getActiveRunAttempt(sessionId);
    if (!attempt) return undefined;
    const event = getRunAttemptSourceUserEvent(attempt);
    if (!event) return undefined;
    const phrase = eventText(event.data);
    return phrase ? { sourceUserSeq: event.seq, phrase } : undefined;
  } catch { /* fail closed: no accepted source, no alias */ }
  return undefined;
}

/** Load the EXACT accepted phrase for {sessionId, sourceUserSeq}. */
export function acceptedPhraseFor(sessionId: string, sourceUserSeq: number | undefined): string | undefined {
  return resolveAcceptedSource(sessionId, sourceUserSeq)?.phrase;
}

export { acceptedPhraseDigest, boundedAliasTerms, normalizeAcceptedPhrase } from './capability-alias-index.js';

export interface VerifiedReadLearningInput {
  /** The durable receipt this learning cites — resolved BY ID, never trusted
   *  as a caller-constructed object. */
  receiptId: string;
  receipts: ReceiptResolver;
  kind: ToolChoiceKind;
  sessionId: string;
  /** The EXACT accepted user event this dispatch belongs to. */
  sourceUserSeq?: number;
}

export type LearningVerdict =
  | { learned: true; intent: string; aliasDigest: string; klass: 'capability_only' }
  | { learned: false; reason: string };

/**
 * Learn a capability + accepted-source alias from ONE verified successful
 * top-level READ settlement, PROVEN by a durable receipt. Everything about
 * this is fail-closed: the receipt must resolve by id through the injected
 * resolver, must be a succeeded read with evidence and a schema contract, and
 * any missing piece declines. The class is always `capability_only` —
 * promotion to executable requires typed provenance for constants, slots,
 * resolvers, and presentation, which a cold brain call cannot supply.
 */
export function learnVerifiedReadSettlement(input: VerifiedReadLearningInput): LearningVerdict {
  let receipt;
  try {
    receipt = input.receipts.resolve(input.receiptId);
  } catch {
    receipt = undefined;
  }
  if (!receipt) return { learned: false, reason: 'the cited receipt does not resolve' };
  if (receipt.dispatchOutcome !== 'succeeded') {
    return { learned: false, reason: `the receipt records "${receipt.dispatchOutcome}", not a verified success` };
  }
  if (receipt.effectClass !== 'read') {
    return { learned: false, reason: `the receipt proves effect class "${receipt.effectClass}", not a read` };
  }
  if (!receipt.readEvidenceRef) {
    return { learned: false, reason: 'the receipt carries no read evidence' };
  }
  if (!receipt.schemaFingerprint) {
    return { learned: false, reason: 'the receipt binds no schema contract' };
  }
  const identifier = receipt.identifier?.trim();
  if (!identifier) return { learned: false, reason: 'the receipt names no identifier' };

  const source = resolveAcceptedSource(input.sessionId, input.sourceUserSeq);
  if (!source) return { learned: false, reason: 'no exact accepted source phrase' };
  const phrase = intentPhraseFor(input.sessionId, source);

  const intent = canonicalIntentSlug(identifier);
  if (!intent) return { learned: false, reason: 'identifier has no canonical slug' };
  const terms = boundedAliasTerms(phrase);
  if (terms.length === 0) return { learned: false, reason: 'accepted phrase has no distinctive terms' };
  const aliasDigest = acceptedPhraseDigest(phrase);

  // Exactly-once: the first settlement to claim this accepted source learns; a
  // retry or a replayed frame is told it lost rather than re-teaching. The
  // account is part of the claim: reading two mailboxes is two settlements.
  const claimAccount = receipt.scope?.accountIdentity?.trim() ?? '';
  if (!claimAcceptedSourceForLearning({
    sessionId: input.sessionId, sourceUserSeq: source.sourceUserSeq, identifier,
    accountIdentity: claimAccount,
  })) {
    return { learned: false, reason: 'accepted source already owned by an earlier settlement' };
  }

  const accountIdentity = receipt.scope?.accountIdentity?.trim() || undefined;
  try {
    rememberToolChoice({
      intent,
      // The description is the retrievable surface: bounded distinctive terms
      // plus the exact-repeat digest. No raw phrase, no arguments, ever.
      description: `${terms.join(' ')} [alias:${aliasDigest}]`,
      choice: {
        kind: input.kind,
        identifier,
        // Deliberately NO invocationTemplate: a proven capability is
        // capability_only, so no concrete argument value can be replayed.
        ...(accountIdentity ? { accountIdentity } : {}),
      },
      aliasSource: 'verified_read',
      schemaFingerprint: receipt.schemaFingerprint,
    });
    // The separate, scoped, class-locked retrieval index. Its write is not
    // allowed to undo the capability memo above, so a refusal here (a class
    // conflict, a locked file) degrades retrieval, never learning.
    recordCapabilityAlias({
      aliasDigest,
      scope: daemonAliasScope(),
      intent,
      kind: input.kind,
      identifier,
      accountIdentity: accountIdentity ?? '',
      klass: 'capability_only',
      terms,
      schemaFingerprint: receipt.schemaFingerprint,
    });
    // A paraphrase learned NOW must retrieve on the NEXT turn: the missing
    // embedding rows are the durable queue, this arms the drain.
    scheduleCapabilityAliasEmbedBackfill();
    return { learned: true, intent, aliasDigest, klass: 'capability_only' };
  } catch (error) {
    return { learned: false, reason: error instanceof Error ? error.message : 'remember refused' };
  }
}
