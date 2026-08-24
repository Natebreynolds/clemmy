/**
 * The durable bounded post-settlement learning worker (R2/A).
 *
 * Settlement leaves ONE pending row per verified read; this worker owns
 * everything expensive or fallible after that, in pipeline order:
 *
 *   catalog acquisition (exact-slug fetch → live fingerprint)
 *   → typed read receipt (identity bound to owner, session, source, attempt,
 *     identifier, account, schema fingerprint, evidence digest)
 *   → materialized procedure + aliases
 *   → committed learning state (the exactly-once claim, LAST)
 *   → embedding backfill armed.
 *
 * A transient failure at any step records a bounded retry on the pending
 * row and leaves everything else durable — restart drains it again. Nothing
 * here runs on the user-visible tool-return path.
 */
import { createHash } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { appendEvent, listEvents } from '../runtime/harness/eventlog.js';
import { eventLogReceiptResolver } from '../runtime/read-path/event-log-read-receipts.js';
import {
  composioToolOperationVersion,
  composioToolSchemaObservedAt,
  getComposioToolBySlug,
} from '../integrations/composio/client.js';
import { promoteFromVerifiedReceipt, type DurableReceiptRecord } from './procedure-receipts.js';
import {
  completePendingLearning,
  listPendingLearning,
  recordPendingLearningFailure,
  type PendingLearningRecord,
} from './capability-alias-index.js';
import {
  learnVerifiedReadSettlement,
  LearningWriteError,
} from './verified-read-learning.js';
import type { ToolChoiceKind } from './tool-choice-store.js';
import {
  liveComposioSchemaFingerprint,
  rememberToolSchema,
} from '../tools/composio-schema-cache.js';
import { checkpointCapsuleForSession } from '../execution/continuation-capsule.js';
import { canonicalProcedureScope } from '../runtime/read-path/procedure-scope.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * The receipt's identity IS its bindings: owner, session, accepted source,
 * attempt, identifier, account, schema contract, and evidence digest. Two
 * settlements that differ in ANY binding — including two accounts returning
 * byte-identical data — are two receipts.
 */
export function boundReceiptId(input: {
  sessionId: string;
  sourceUserSeq: number | null;
  attemptId: string | null;
  identifier: string;
  accountIdentity: string;
  schemaFingerprint: string;
  evidenceDigest: string;
}): string {
  return `rr_${sha256(JSON.stringify([
    getMachineId(), BASE_DIR,
    input.sessionId, input.sourceUserSeq, input.attemptId,
    input.identifier, input.accountIdentity,
    input.schemaFingerprint, input.evidenceDigest,
  ])).slice(0, 32)}`;
}

async function acquireLiveContract(identifier: string): Promise<string | undefined> {
  const cached = liveComposioSchemaFingerprint(identifier);
  if (cached) return cached;
  try {
    const match = await getComposioToolBySlug(identifier);
    if (match?.inputParameters) {
      rememberToolSchema(
        identifier,
        match.inputParameters,
        composioToolSchemaObservedAt(match) ?? Number.NaN,
        composioToolOperationVersion(match),
      );
    }
  } catch { /* declined below; the pending row retries */ }
  return liveComposioSchemaFingerprint(identifier);
}

function receiptAlreadyDurable(sessionId: string, receiptId: string): boolean {
  try {
    return listEvents(sessionId).some((event) => event.type === 'read_receipt'
      && (event.data as { record?: { receiptId?: string } }).record?.receiptId === receiptId);
  } catch {
    return false;
  }
}

async function materializeOne(pending: PendingLearningRecord): Promise<void> {
  const liveSchemaFingerprint = await acquireLiveContract(pending.identifier);
  if (!liveSchemaFingerprint) {
    throw new LearningWriteError('no live catalog authority for the identifier yet');
  }
  if (pending.schemaFingerprint && pending.schemaFingerprint !== liveSchemaFingerprint) {
    throw new LearningWriteError(
      `dispatch schema ${pending.schemaFingerprint} no longer matches live schema ${liveSchemaFingerprint}`,
    );
  }
  const schemaFingerprint = pending.schemaFingerprint || liveSchemaFingerprint;
  const receiptId = boundReceiptId({
    sessionId: pending.sessionId,
    sourceUserSeq: pending.sourceUserSeq,
    attemptId: pending.attemptId,
    identifier: pending.identifier,
    accountIdentity: pending.accountIdentity,
    schemaFingerprint,
    evidenceDigest: pending.evidenceDigest,
  });
  let scope;
  try {
    scope = canonicalProcedureScope(pending.accountIdentity);
  } catch (error) {
    throw new LearningWriteError(error instanceof Error ? error.message : String(error));
  }
  const record: DurableReceiptRecord = {
    receiptId,
    at: new Date().toISOString(),
    provider: (pending.identifier.split('_')[0] ?? '').toLowerCase(),
    operation: pending.identifier.split('_').slice(1).join('_').toLowerCase() || 'operation',
    effectClass: 'read',
    identifier: pending.identifier,
    schemaFingerprint,
    scope,
    dispatchOutcome: 'succeeded',
    ...(typeof pending.sourceUserSeq === 'number'
      ? {
          source: {
            sessionId: pending.sessionId,
            sourceUserSeq: pending.sourceUserSeq,
            ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
          },
        }
      : {}),
    readEvidenceRef: `evt:${pending.evidenceDigest}`,
  };
  // Idempotent under retry: the receipt id is fully binding-derived, so a
  // crash after this append and before the commit re-runs into a no-op.
  if (!receiptAlreadyDurable(pending.sessionId, receiptId)) {
    appendEvent({
      sessionId: pending.sessionId,
      turn: 0,
      role: 'system',
      type: 'read_receipt',
      data: { record },
    });
  }

  // The only automatic executable promotion is the structurally complete
  // empty-args shape. It carries no historical constants and needs no slots or
  // model-authored resolver: `{}` is the entire typed invocation template.
  // Every non-empty read remains capability_only below.
  if (pending.executableEmptyArgs && pending.kind === 'composio' && pending.accountIdentity) {
    const promoted = await promoteFromVerifiedReceipt({
      scope,
      provider: record.provider,
      operation: record.operation,
      effectClass: 'read',
      kind: 'composio',
      identifier: pending.identifier,
      templateArgs: {},
      receiptId,
      acquiredSchemaFingerprint: schemaFingerprint,
    }, eventLogReceiptResolver(pending.sessionId));
    if (!promoted.ok) {
      throw new LearningWriteError(`empty-args structural promotion refused: ${promoted.errors.join('; ')}`);
    }
  }

  const verdict = learnVerifiedReadSettlement({
    receiptId,
    receipts: eventLogReceiptResolver(pending.sessionId),
    kind: pending.kind as ToolChoiceKind,
    sessionId: pending.sessionId,
    ...(typeof pending.sourceUserSeq === 'number' ? { sourceUserSeq: pending.sourceUserSeq } : {}),
    ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
    expect: {
      identifier: pending.identifier,
      accountIdentity: pending.accountIdentity,
      evidenceDigest: pending.evidenceDigest,
    },
    aliasDigest: pending.aliasDigest,
    aliasTerms: pending.aliasTerms,
  });
  if (!verdict.learned && /already owned/.test(verdict.reason)) {
    // The claim was committed by an earlier (possibly crashed-and-retried)
    // materialization: the learning state exists; this row is done.
    return;
  }
  if (!verdict.learned) {
    // A binding decline is permanent for this row — retrying cannot change
    // what the receipt proves. Surface it as a dead row, not a silent skip.
    throw new Error(`learning declined: ${verdict.reason}`);
  }
  // The receipt is durable, so the effect is settled: re-checkpoint the
  // continuation capsule for this session if one owns the turn. A capsule that
  // predates this receipt would let a resume re-issue an effect that already
  // happened. Best-effort — the settlement above is authoritative either way.
  try {
    checkpointCapsuleForSession(pending.sessionId, pending.sourceUserSeq ?? undefined);
  } catch { /* bookkeeping must never fail a committed settlement */ }
}

let draining = false;
let rerun = false;

/** Drain every pending learning row, bounded per pass. The daemon calls this
 *  on a timer; settlements arm it via scheduleLearningDrain. */
export async function drainPendingLearning(limit = 32): Promise<{ completed: number; failed: number }> {
  const outcome = { completed: 0, failed: 0 };
  for (const pending of listPendingLearning(limit)) {
    try {
      await materializeOne(pending);
      completePendingLearning(pending.pendingId);
      outcome.completed += 1;
    } catch (error) {
      recordPendingLearningFailure(
        pending.pendingId,
        error instanceof Error ? error.message : String(error),
      );
      outcome.failed += 1;
    }
  }
  return outcome;
}

let drainTimer: NodeJS.Timeout | null = null;

/** Arm one near-term drain (debounced). Fire-and-forget by design: the
 *  pending rows are durable, so a missed timer only delays, never loses. */
export function scheduleLearningDrain(delayMs = 100): void {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    if (draining) { rerun = true; return; }
    draining = true;
    void drainPendingLearning()
      .catch(() => ({ completed: 0, failed: 0 }))
      .finally(() => {
        draining = false;
        if (rerun) { rerun = false; scheduleLearningDrain(delayMs); }
      });
  }, delayMs);
  drainTimer.unref?.();
}
