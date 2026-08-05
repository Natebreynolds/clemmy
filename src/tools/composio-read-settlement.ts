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
import { getActiveRunAttempt } from '../runtime/harness/eventlog.js';
import {
  enqueuePendingLearning,
  type PendingLearningRecord,
} from '../memory/capability-alias-index.js';
import {
  acceptedIntentPhraseForSettlement,
  settlementCarriesVerifiedData,
} from '../memory/verified-read-learning.js';
import { scheduleLearningDrain } from '../memory/learning-worker.js';

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
}

export type SettlementVerdict =
  | { queued: true; pending: PendingLearningRecord }
  | { queued: false; reason: string };

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
  const attemptId = getActiveRunAttempt(input.sessionId)?.attemptId;

  const pending = enqueuePendingLearning({
    sessionId: input.sessionId,
    ...(typeof captured.sourceUserSeq === 'number' ? { sourceUserSeq: captured.sourceUserSeq } : {}),
    ...(attemptId ? { attemptId } : {}),
    identifier: toolSlug,
    kind: 'composio',
    accountIdentity: input.accountIdentity?.trim() ?? '',
    phrase: captured.phrase,
    evidenceDigest,
  });
  if (!pending) return { queued: false, reason: 'the durable pending-learning record could not be written' };
  scheduleLearningDrain();
  return { queued: true, pending };
}
