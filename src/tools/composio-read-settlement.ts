/**
 * Verified READ settlement for governed Composio dispatches (A-series, R2).
 *
 * Settlement is SYNCHRONOUS and cheap; materialization is not allowed here.
 * This module runs after the execute wrapper has finished everything that
 * decides what actually happened — canonical failure classification, async
 * job-receipt resolution — and does exactly three things with what is
 * already in hand:
 *
 *   1. verify the FINAL payload through the one settled-read verifier
 *      (nested error envelopes decline);
 *   2. capture the accepted source, attempt, account, and evidence digest
 *      while they are still live;
 *   3. append ONE durable pending-learning row and arm the bounded worker.
 *
 * Catalog fetches, receipt creation, procedure/alias writes, and embedding
 * all belong to `src/memory/learning-worker.ts` — the user-visible tool
 * return never waits on any of them, and a crash at any point leaves a
 * pending row that restart retries.
 */
import { createHash } from 'node:crypto';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import { getActiveRunAttempt, getRunAttemptSourceUserEvent } from '../runtime/harness/eventlog.js';
import {
  enqueuePendingLearning,
  type PendingLearningRecord,
} from '../memory/capability-alias-index.js';
import {
  acceptedPhraseDigest,
  acceptedIntentPhraseForSettlement,
  boundedAliasTerms,
  settlementCarriesVerifiedData,
} from '../memory/verified-read-learning.js';
import { scheduleLearningDrain } from '../memory/learning-worker.js';
import { normalizeProcedureAccountIdentity } from '../runtime/read-path/procedure-scope.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export interface VerifiedComposioSettlementInput {
  toolSlug: string;
  sessionId: string;
  /** The FINAL settled payload — post failure detection, post async resolve. */
  result: unknown;
  /** Exact accepted source when the run context carries it. */
  sourceUserSeq?: number;
  /** Stable account identity (an email, never a rotating connection id). */
  accountIdentity?: string;
  /** Exact schema fingerprint held by the gateway when this call validated. */
  schemaFingerprint?: string;
  /** Post-carrier normalized provider args. Only an exactly empty plain object
   * can produce a structural executable artifact; values are never persisted. */
  normalizedArgs?: unknown;
}

export type SettlementVerdict =
  | { queued: true; pending: PendingLearningRecord }
  | { queued: false; reason: string };

/** `Object.keys([])` and class instances are both empty, but neither is the
 * complete typed `{}` invocation shape. Symbols also make an object nonempty
 * even though JSON would omit them. */
function isExactlyEmptyPlainObject(value: unknown): value is Record<string, never> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === 0;
}

/**
 * Queue the learning intent for one verified read. Fail-closed at every
 * step; a decline is a normal outcome, never an error surfaced to the tool
 * call.
 */
export function settleVerifiedComposioRead(input: VerifiedComposioSettlementInput): SettlementVerdict {
  const toolSlug = input.toolSlug?.trim();
  if (!toolSlug || !input.sessionId) return { queued: false, reason: 'no identifier or session' };
  if (classifyComposioSlugEffect(toolSlug) !== 'read') {
    return { queued: false, reason: 'the sealed taxonomy does not prove a read' };
  }
  if (!settlementCarriesVerifiedData(input.result)) {
    return { queued: false, reason: 'settlement carries no verified returned data' };
  }
  let evidenceDigest = '';
  try {
    evidenceDigest = sha256(JSON.stringify(input.result)).slice(0, 24);
  } catch {
    return { queued: false, reason: 'settled payload is not serializable evidence' };
  }
  // The accepted source and live attempt exist NOW and are gone by the time
  // the worker runs — capture the intent phrase and identity here.
  const captured = acceptedIntentPhraseForSettlement(input.sessionId, input.sourceUserSeq);
  if (!captured) return { queued: false, reason: 'no exact accepted source phrase' };
  const activeAttempt = getActiveRunAttempt(input.sessionId);
  const activeSource = activeAttempt ? getRunAttemptSourceUserEvent(activeAttempt) : null;
  const exactActiveAuthority = Boolean(activeAttempt
    && activeSource
    && activeSource.seq === captured.sourceUserSeq);
  const attemptId = exactActiveAuthority ? activeAttempt!.attemptId : undefined;
  let accountIdentity = '';
  try {
    accountIdentity = normalizeProcedureAccountIdentity(input.accountIdentity);
  } catch {
    // Capability-only learning may remain unbound. A rotating connection id
    // must never become durable stable-account or executable authority.
  }
  const schemaFingerprint = input.schemaFingerprint?.trim() ?? '';
  // Derive the only retrievable identity while the accepted source is live.
  // The durable queue never receives the raw prompt.
  const aliasDigest = acceptedPhraseDigest(captured.phrase);
  const aliasTerms = boundedAliasTerms(captured.phrase);

  const pending = enqueuePendingLearning({
    sessionId: input.sessionId,
    ...(typeof captured.sourceUserSeq === 'number' ? { sourceUserSeq: captured.sourceUserSeq } : {}),
    ...(attemptId ? { attemptId } : {}),
    identifier: toolSlug,
    kind: 'composio',
    accountIdentity,
    aliasDigest,
    aliasTerms,
    evidenceDigest,
    schemaFingerprint,
    executableEmptyArgs: exactActiveAuthority
      && Boolean(accountIdentity && schemaFingerprint)
      && isExactlyEmptyPlainObject(input.normalizedArgs),
  });
  if (!pending) return { queued: false, reason: 'the durable pending-learning record could not be written' };
  scheduleLearningDrain();
  return { queued: true, pending };
}
